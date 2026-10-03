/**
 * Shakespeare's Monologues — Streamable HTTP entry point.
 *
 * Stateless mode: a fresh server + transport per request, so it runs on any
 * Node host with no session store. The tools themselves live in `server.ts`,
 * shared with the stdio entry point.
 */
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer, posthog } from "./server.js";

const app = express();
app.use(express.json());

// Tool names this server registers, for spotting calls to tools that don't exist.
const KNOWN_TOOLS = new Set(
  Object.keys((buildServer() as unknown as { _registeredTools: Record<string, unknown> })._registeredTools),
);

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
      const ip = req.get("x-real-ip") ?? req.socket.remoteAddress ?? "unknown";
      console.warn(`MCP unknown tool from ${ip}: ${JSON.stringify(name.slice(0, 100))}`);
    }
  }
}

app.post("/mcp", async (req: Request, res: Response) => {
  // Stateless: a fresh server + transport per request, disposed when it closes.
  try {
    logUnknownToolCalls(req);
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Stateless server: no session-based SSE stream (GET) or session teardown (DELETE).
function methodNotAllowed(_req: Request, res: Response) {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed (stateless server)." },
    id: null,
  });
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
