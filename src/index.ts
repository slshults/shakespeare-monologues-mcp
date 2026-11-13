/**
 * Shakespeare's Monologues — Streamable HTTP entry point.
 *
 * Stateless mode: a fresh server + transport per request, so it runs on any
 * Node host with no session store. The tools themselves live in `server.ts`,
 * shared with the stdio entry point.
 */
import { isIP } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer, posthog } from "./server.js";

// Abuse limits for the public endpoint. Real MCP requests are a few hundred
// bytes with small, shallow objects. Without these, one 96 KB `initialize`
// whose `clientInfo.icons` holds 48k bad entries makes the SDK's zod schemas
// emit one issue per entry and echo all of them back: about 12 MB of
// response and a ~300 ms blocked event loop per request. A JSON-RPC batch
// also fans one POST out into many tool calls (and upstream fetches).
// Per-container caps alone still let 64 × 64 bad entries through, so there's
// a total-node budget too, and the echoed error text is capped as a backstop.
// Fable + Opus security reviews, 2026-11-12. A rich real `initialize` is ~80
// nodes; a batch of 5 full tool calls with `_meta` is ~140.
const BODY_LIMIT = "16kb";
const MAX_NODES = 256; // every value in the body, containers and leaves
const MAX_ENTRIES = 64; // per array or object
const MAX_DEPTH = 16; // containers may sit at most 15 levels below the top
const MAX_BATCH = 5; // the 2025-06-18 spec dropped batching; real clients don't send big ones
const MAX_ERROR_MESSAGE = 500; // chars of error text echoed back to the client

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: BODY_LIMIT }));

// nginx (proxy_pass to 127.0.0.1:3000) sets X-Real-IP from $remote_addr. Trust
// it only from a loopback peer, and only if it's a plain address (no IPv6 zone
// id), so a direct or forged request can't put someone else's IP or arbitrary
// text into the journal lines a future fail2ban jail would read.
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
function clientIp(req: Request): string {
  const peer = req.socket.remoteAddress ?? "unknown";
  const realIp = req.get("x-real-ip");
  if (LOOPBACK.has(peer) && realIp && !realIp.includes("%") && isIP(realIp)) return realIp;
  return peer;
}

function jsonRpcError(res: Response, status: number, code: number, message: string) {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

// Rejected requests go to the journal with the client IP, like unknown tools.
function reject(req: Request, res: Response, status: number, code: number, message: string) {
  console.warn(`MCP rejected ${status} from ${clientIp(req)}: ${message}`);
  jsonRpcError(res, status, code, message);
}

// True if the body has too many values overall, an array or object with too
// many entries, or nesting deeper than MAX_DEPTH.
function exceedsShapeLimits(value: unknown): boolean {
  let nodes = 0;
  const walk = (v: unknown, depth: number): boolean => {
    if (++nodes > MAX_NODES) return true;
    if (v === null || typeof v !== "object") return false;
    if (depth >= MAX_DEPTH) return true;
    const children = Array.isArray(v) ? v : Object.values(v);
    if (children.length > MAX_ENTRIES) return true;
    return children.some((child) => walk(child, depth + 1));
  };
  return walk(value, 0);
}

// The SDK puts the full validation issue list in error.message; cap it so a
// malformed request can't buy a response much bigger than itself.
function capErrorMessages(message: unknown) {
  for (const msg of Array.isArray(message) ? message : [message]) {
    const error = (msg as { error?: { message?: unknown } } | null)?.error;
    if (typeof error?.message === "string" && error.message.length > MAX_ERROR_MESSAGE) {
      error.message = `${error.message.slice(0, MAX_ERROR_MESSAGE)}… (truncated)`;
    }
  }
}

// Tool names this server registers, for spotting calls to tools that don't exist.
// `send_feedback` is served by the PostHog SDK (collectFeedback) at dispatch
// time, so it never appears in _registeredTools, and only exists when
// analytics is on.
const KNOWN_TOOLS = new Set([
  ...Object.keys((buildServer() as unknown as { _registeredTools: Record<string, unknown> })._registeredTools),
  ...(posthog ? ["send_feedback"] : []),
]);

// Scanners sweep fake tool names; the SDK answers -32602 and the PostHog
// $exception + Slack alert still fire. This adds the client IP to the journal.
// Log only, no ban (Steven, 2026-10-03). The line format is the hook for a
// future `shakes-mcp-probe` fail2ban jail; see ShakesMonos/mcp server deploy
// steps.md in the vault before building one.
function logUnknownToolCalls(req: Request) {
  const messages = Array.isArray(req.body) ? req.body : [req.body];
  for (const msg of messages) {
    const name = msg?.method === "tools/call" ? msg.params?.name : undefined;
    if (typeof name === "string" && !KNOWN_TOOLS.has(name)) {
      console.warn(`MCP unknown tool from ${clientIp(req)}: ${JSON.stringify(name.slice(0, 100))}`);
    }
  }
}

app.post("/mcp", async (req: Request, res: Response) => {
  if (Array.isArray(req.body) && req.body.length > MAX_BATCH) {
    return reject(req, res, 400, -32600, `Batches are limited to ${MAX_BATCH} messages.`);
  }
  if (exceedsShapeLimits(req.body)) {
    return reject(req, res, 400, -32600, "Request has too many values or is nested too deeply.");
  }
  // Stateless: a fresh server + transport per request, disposed when it closes.
  try {
    logUnknownToolCalls(req);
    const server = buildServer();
    // JSON responses, not SSE: SSE flushes headers before the handler runs, so
    // the analytics session token never reaches the client and every request
    // becomes its own PostHog session.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const send = transport.send.bind(transport);
    transport.send = (message, options) => {
      capErrorMessages(message);
      return send(message, options);
    };
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request failed:", err);
    if (!res.headersSent) {
      jsonRpcError(res, 500, -32603, "Internal server error");
    }
  }
});

// Stateless server: no session-based SSE stream (GET) or session teardown (DELETE).
function methodNotAllowed(_req: Request, res: Response) {
  jsonRpcError(res, 405, -32000, "Method not allowed (stateless server).");
}
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

app.get("/health", (_req: Request, res: Response) => res.json({ ok: true }));

// Glama connector ownership verification (https://glama.ai/mcp/connectors).
app.get("/.well-known/glama.json", (_req: Request, res: Response) =>
  res.json({
    $schema: "https://glama.ai/mcp/schemas/connector.json",
    maintainers: [{ email: "tipjar@shakespeare-monologues.org" }],
  }),
);

// Body-parser failures (bad JSON, too large) as JSON-RPC errors, instead of
// Express's default HTML page with a stack trace and file paths.
app.use((err: { type?: string; status?: number }, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(err);
  if (err.type === "entity.too.large") return reject(req, res, 413, -32000, "Request body too large.");
  if (err.type === "entity.parse.failed") return reject(req, res, 400, -32700, "Parse error.");
  if (err.status && err.status >= 400 && err.status < 500) {
    return reject(req, res, err.status, -32000, "Bad request.");
  }
  console.error("Unhandled request error:", err);
  jsonRpcError(res, 500, -32603, "Internal server error");
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`Shakespeare's Monologues MCP server listening on :${port} (POST /mcp)`);
});

// Flush buffered analytics before exit (systemd stops the service with SIGTERM).
async function shutdown() {
  if (posthog) await posthog.shutdown();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
