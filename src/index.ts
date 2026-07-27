/**
 * Shakespeare's Monologues — MCP server.
 *
 * A thin, stateless, read-only wrapper over the public JSON index at
 * https://www.shakespeare-monologues.org/api/monologues.json. Exposes tools an
 * MCP client can use to search and fetch Shakespeare monologue metadata; every
 * result carries the monologue's permalink `url` (where the full text, scene,
 * and paraphrase live) plus attribution.
 *
 * Transport: Streamable HTTP in stateless mode (a fresh server + transport per
 * request), so it runs on any Node host with no session store.
 */
import express, { type Request, type Response } from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { PostHog } from "posthog-node";
import { instrument } from "@posthog/mcp";

const API_URL =
  process.env.MONOLOGUES_API_URL ?? "https://www.shakespeare-monologues.org/api/monologues.json";
// Base for the other endpoints, e.g. ".../api" from ".../api/monologues.json".
const API_BASE = API_URL.replace(/\/monologues\.json.*$/, "");
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const ATTRIBUTION =
  "Source: shakespeare-monologues.org (CC BY-NC-SA 4.0). Full text, scene context, and a modern-English paraphrase are on each monologue's `url`.";

// PostHog analytics. The key is the site's public, write-only ingest key (the
// same `phc_` project key posthog-js exposes in the browser), so it's safe to
// commit. Override with POSTHOG_PROJECT_API_KEY, or set it to "" to disable
// analytics entirely (e.g. in local dev). One shared client batches events
// across the per-request servers.
const POSTHOG_KEY =
  process.env.POSTHOG_PROJECT_API_KEY ?? "phc_6aYLpkqQsmYJanYseJ8SJcOMicomCxj9v9Pl6hnZQS3";
const POSTHOG_HOST = process.env.POSTHOG_HOST ?? "https://us.i.posthog.com";
const posthog = POSTHOG_KEY ? new PostHog(POSTHOG_KEY, { host: POSTHOG_HOST }) : null;

type Monologue = {
  id: number;
  character: string;
  play: string;
  play_type: string;
  gender: string;
  act: number | null;
  scene: number | null;
  line: number | null;
  location: string;
  style: string;
  first_line: string;
  line_count: number;
  url: string;
};

let cache: { at: number; data: Monologue[] } | null = null;

async function getIndex(): Promise<Monologue[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  const res = await fetch(API_URL, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Upstream API returned ${res.status}`);
  const json = (await res.json()) as { monologues: Monologue[] };
  cache = { at: Date.now(), data: json.monologues };
  return cache.data;
}

// Fetch a JSON endpoint; null on 404, throws on other errors.
async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Upstream ${res.status} for ${url}`);
  return res.json();
}

// "Both" monologues belong in both Men's and Women's results.
function genderMatch(m: Monologue, gender?: string): boolean {
  if (!gender) return true;
  if (gender === "Both") return m.gender === "Both";
  return m.gender === gender || m.gender === "Both";
}

// A tool result carrying text content, optionally flagged as an error.
type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function textResult(data: unknown): ToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

// Soft failure: return an actionable instruction the agent can act on, flagged
// with isError so the client's recovery path engages — but never a raw -32602
// or a thrown exception. Reserve this for genuine mistakes and transient
// problems; a legitimately empty answer (no matches, a null summary) is a
// normal success (textResult), not an error.
function guide(message: string): ToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true };
}

// Wrap a tool handler so an unexpected throw (e.g. the upstream API is down)
// comes back as guidance instead of surfacing to the agent as a hard error.
// Args are validated inside each handler, so the boundary type is intentionally
// loose here.
function safeTool(fn: (args: any) => Promise<ToolResult>): (args: any) => Promise<ToolResult> {
  return async (args: any) => {
    try {
      return await fn(args);
    } catch (err) {
      console.error("Tool handler error:", err);
      return guide("The monologue service is temporarily unavailable. Please try again in a moment.");
    }
  };
}

// Coerce a loosely-typed numeric arg (agents often send "5" instead of 5) to an
// integer, or null if it isn't one.
function coerceInt(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value.trim());
    return Number.isInteger(n) ? n : null;
  }
  return null;
}

// Some clients pass natural gender words ("female", "male", "m") instead of the
// catalogue's "Men"/"Women"/"Both". Map the common ones; anything unrecognized
// is caught in-handler with a guiding message.
const GENDER_ALIASES: Record<string, "Men" | "Women" | "Both"> = {
  men: "Men", man: "Men", male: "Men", males: "Men", m: "Men", boy: "Men", boys: "Men",
  women: "Women", woman: "Women", female: "Women", females: "Women", f: "Women", girl: "Women", girls: "Women",
  both: "Both", any: "Both", all: "Both", either: "Both", neutral: "Both",
};

// Returns the canonical gender, or null if the value isn't recognized.
function normalizeGender(value: unknown): "Men" | "Women" | "Both" | null {
  if (typeof value !== "string") return null;
  return GENDER_ALIASES[value.trim().toLowerCase()] ?? null;
}

function normalizeStyle(value: unknown): "Verse" | "Prose" | null {
  if (typeof value !== "string") return null;
  const s = value.trim().toLowerCase();
  if (s === "verse") return "Verse";
  if (s === "prose") return "Prose";
  return null;
}

// Loose string fields: accept anything so the SDK never hard-rejects; the
// handler normalizes and guides on unrecognized input.
function genderField() {
  return z
    .string()
    .optional()
    .describe(
      "Role gender: Men, Women, or Both. Natural words like 'male'/'female' are accepted. 'Men'/'Women' also include gender-neutral ('Both') roles.",
    );
}

// A number-ish arg: accepts a number or a numeric string (agents send both).
function numberish() {
  return z.union([z.number(), z.string()]).optional();
}

// The by-id tools take a numeric `id`; `monologue_id` is an older alias some
// clients still send. Both optional and number-ish so bad/missing input returns
// guidance rather than a raw -32602. Fresh instance per tool so the analytics
// wrapper never mutates a shared schema.
function byIdShape() {
  return {
    id: numberish().describe("The monologue's numeric id (from search_monologues)."),
    monologue_id: numberish().describe("Deprecated alias for `id`."),
  };
}

function resolveMonologueId(args: { id?: unknown; monologue_id?: unknown }): number | null {
  return coerceInt(args.id) ?? coerceInt(args.monologue_id);
}

const NO_ID_MSG =
  "Need a numeric monologue `id`. Use search_monologues or list_all_monologues_for_a_character to find the monologue first, then pass its `id`.";

// Clamp a requested result limit into range, defaulting when absent/unparseable.
function resolveLimit(value: unknown, def: number, max: number): number {
  const n = coerceInt(value);
  if (n == null) return def;
  return Math.max(1, Math.min(max, n));
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "shakespeare-monologues", version: "0.1.0" });
  // Emit PostHog's native $mcp_* analytics ($mcp_tool_call, $mcp_initialize, …).
  // Handlers below are untouched; the SDK wraps tool dispatch.
  if (posthog) instrument(server, posthog);

  server.tool(
    "search_monologues",
    "Search Shakespeare monologues by free text (matches character, play, or first line) plus optional filters. Returns matches, each with a permalink `url`.",
    {
      query: z
        .string()
        .optional()
        .describe("Free text — matched against character name, play title, and first line."),
      gender: genderField(),
      play: z.string().optional().describe("Exact or partial play title."),
      style: z.string().optional().describe("Verse or Prose."),
      act: numberish().describe("Filter to a specific act number."),
      limit: numberish().describe("Max results to return (default 25, max 100)."),
    },
    safeTool(async ({ query, gender, play, style, act, limit }) => {
      let genderFilter: "Men" | "Women" | "Both" | undefined;
      if (gender != null && String(gender).trim() !== "") {
        const g = normalizeGender(gender);
        if (!g) return guide(`Unrecognized gender "${gender}". Use Men, Women, or Both (male/female also work).`);
        genderFilter = g;
      }
      let styleFilter: "Verse" | "Prose" | undefined;
      if (style != null && String(style).trim() !== "") {
        const s = normalizeStyle(style);
        if (!s) return guide(`Unrecognized style "${style}". Use Verse or Prose.`);
        styleFilter = s;
      }
      let actFilter: number | null = null;
      if (act != null && String(act).trim() !== "") {
        actFilter = coerceInt(act);
        if (actFilter == null) return guide(`Act "${act}" isn't a number. Pass an act number like 1, 2, or 3.`);
      }

      const all = await getIndex();
      const q = (query ?? "").trim().toLowerCase();
      const playQ = (play ?? "").trim().toLowerCase();

      const matches = all.filter((m) => {
        if (!genderMatch(m, genderFilter)) return false;
        if (styleFilter && m.style !== styleFilter) return false;
        if (actFilter != null && m.act !== actFilter) return false;
        if (playQ && !m.play.toLowerCase().includes(playQ)) return false;
        if (
          q &&
          !(
            m.character.toLowerCase().includes(q) ||
            m.play.toLowerCase().includes(q) ||
            m.first_line.toLowerCase().includes(q)
          )
        ) {
          return false;
        }
        return true;
      });

      const returned = matches.slice(0, resolveLimit(limit, 25, 100));
      return textResult({
        total_matches: matches.length,
        returned: returned.length,
        attribution: ATTRIBUTION,
        monologues: returned,
      });
    }),
  );

  server.tool(
    "get_monologue",
    "Fetch one monologue's catalogue entry by its numeric id. Follow the returned `url` for the full text.",
    byIdShape(),
    safeTool(async (args) => {
      const id = resolveMonologueId(args);
      if (id == null) return guide(NO_ID_MSG);
      const all = await getIndex();
      const m = all.find((x) => x.id === id);
      if (!m) return guide(`No monologue has id ${id}. Use search_monologues to find a valid id.`);
      return textResult({ ...m, attribution: ATTRIBUTION });
    }),
  );

  server.tool(
    "random_monologue",
    "Return one random monologue, with optional gender/play filters. Useful for a suggestion when the user is undecided.",
    {
      gender: genderField(),
      play: z.string().optional().describe("Exact or partial play title."),
    },
    safeTool(async ({ gender, play }) => {
      let genderFilter: "Men" | "Women" | "Both" | undefined;
      if (gender != null && String(gender).trim() !== "") {
        const g = normalizeGender(gender);
        if (!g) return guide(`Unrecognized gender "${gender}". Use Men, Women, or Both (male/female also work).`);
        genderFilter = g;
      }
      const all = await getIndex();
      const playQ = (play ?? "").trim().toLowerCase();
      const pool = all.filter(
        (m) => genderMatch(m, genderFilter) && (!playQ || m.play.toLowerCase().includes(playQ)),
      );
      if (pool.length === 0) return textResult({ message: "No monologues match those filters." });
      const m = pool[Math.floor(Math.random() * pool.length)];
      return textResult({ ...m, attribution: ATTRIBUTION });
    }),
  );

  server.tool(
    "list_plays",
    "List Shakespeare's plays with their classification (Comedy/History/Tragedy) and monologue counts.",
    {},
    safeTool(async () => {
      const all = await getIndex();
      const byPlay = new Map<string, { play: string; play_type: string; monologue_count: number }>();
      for (const m of all) {
        const entry = byPlay.get(m.play) ?? { play: m.play, play_type: m.play_type, monologue_count: 0 };
        entry.monologue_count += 1;
        byPlay.set(m.play, entry);
      }
      const plays = [...byPlay.values()].sort((a, b) => a.play.localeCompare(b.play));
      return textResult({ count: plays.length, plays });
    }),
  );

  server.tool(
    "list_all_monologues_for_a_character",
    "List every monologue spoken by a given character (e.g. 'Hamlet', 'Rosalind'). Matches the character name exactly first, then as a substring.",
    {
      character: z.string().optional().describe("Character name."),
      limit: numberish().describe("Max results (default 50, max 200)."),
    },
    safeTool(async ({ character, limit }) => {
      const c = (character ?? "").trim().toLowerCase();
      if (!c) return guide("Provide a `character` name, e.g. 'Hamlet' or 'Rosalind'.");
      const all = await getIndex();
      const exact = all.filter((m) => m.character.toLowerCase() === c);
      const matches = exact.length > 0 ? exact : all.filter((m) => m.character.toLowerCase().includes(c));
      const returned = matches.slice(0, resolveLimit(limit, 50, 200));
      return textResult({
        character,
        total_matches: matches.length,
        returned: returned.length,
        attribution: ATTRIBUTION,
        monologues: returned,
      });
    }),
  );

  server.tool(
    "get_monologue_of_the_day",
    "The current 'Monologue of the Day' — the piece most recently posted to the site's social feeds.",
    {},
    safeTool(async () => {
      const mod = await fetchJson(`${API_BASE}/monologue-of-the-day.json`);
      if (!mod) return textResult({ message: "No monologue of the day is available." });
      return textResult(mod);
    }),
  );

  server.tool(
    "get_paraphrased_monologue",
    "Fetch a monologue's full text alongside its modern-English, line-by-line paraphrase. The paraphrase is AI-generated (Claude) and may be null if it hasn't been generated yet — the `url` always has the monologue itself.",
    byIdShape(),
    safeTool(async (args) => {
      const id = resolveMonologueId(args);
      if (id == null) return guide(NO_ID_MSG);
      const m = await fetchJson(`${API_BASE}/monologues/${id}`);
      if (!m || m.error) return guide(`No monologue has id ${id}. Use search_monologues to find a valid id.`);
      return textResult({
        id: m.id,
        character: m.character,
        play: m.play,
        location: m.location,
        text: m.text,
        paraphrase: m.paraphrase,
        url: m.url,
        note: m.content_note,
        attribution: ATTRIBUTION,
      });
    }),
  );

  server.tool(
    "get_scene_summary",
    "Fetch an AI-generated summary of the scene a monologue appears in (context for the speech). May be null if not generated yet.",
    byIdShape(),
    safeTool(async (args) => {
      const id = resolveMonologueId(args);
      if (id == null) return guide(NO_ID_MSG);
      const m = await fetchJson(`${API_BASE}/monologues/${id}`);
      if (!m || m.error) return guide(`No monologue has id ${id}. Use search_monologues to find a valid id.`);
      return textResult({
        play: m.play,
        location: m.location,
        scene_summary: m.scene_summary,
        url: m.url,
        note: m.content_note,
        attribution: ATTRIBUTION,
      });
    }),
  );

  server.tool(
    "get_play_summary",
    "Fetch an AI-generated summary of a play (e.g. 'Hamlet', 'The Tempest'). May be null if not generated yet.",
    { play: z.string().optional().describe("Play title (exact or partial).") },
    safeTool(async ({ play }) => {
      const p = (play ?? "").trim().toLowerCase();
      if (!p) return guide("Provide a `play` title, e.g. 'Hamlet' or 'The Tempest'. Use list_plays to see the options.");
      const all = await getIndex();
      const hit = all.find((m) => m.play.toLowerCase() === p) ?? all.find((m) => m.play.toLowerCase().includes(p));
      if (!hit) return guide(`No play matches "${play}". Use list_plays to see available titles.`);
      const full = await fetchJson(`${API_BASE}/monologues/${hit.id}`);
      if (!full || full.error) return guide(`Couldn't load the summary for "${hit.play}". Please try again in a moment.`);
      return textResult({
        play: full.play,
        play_summary: full.play_summary,
        note: full.content_note,
        attribution: ATTRIBUTION,
      });
    }),
  );

  return server;
}

const app = express();
app.use(express.json());

app.post("/mcp", async (req: Request, res: Response) => {
  // Stateless: a fresh server + transport per request, disposed when it closes.
  try {
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
