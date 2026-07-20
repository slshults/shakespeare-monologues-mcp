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

const API_URL =
  process.env.MONOLOGUES_API_URL ?? "https://www.shakespeare-monologues.org/api/monologues.json";
// Base for the other endpoints, e.g. ".../api" from ".../api/monologues.json".
const API_BASE = API_URL.replace(/\/monologues\.json.*$/, "");
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const ATTRIBUTION =
  "Source: shakespeare-monologues.org (CC BY-NC-SA 4.0). Full text, scene context, and a modern-English paraphrase are on each monologue's `url`.";

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

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "shakespeare-monologues", version: "0.1.0" });

  server.tool(
    "search_monologues",
    "Search Shakespeare monologues by free text (matches character, play, or first line) plus optional filters. Returns matches, each with a permalink `url`.",
    {
      query: z
        .string()
        .optional()
        .describe("Free text — matched against character name, play title, and first line."),
      gender: z
        .enum(["Men", "Women", "Both"])
        .optional()
        .describe("Role gender as catalogued. 'Men'/'Women' also include gender-neutral ('Both') roles."),
      play: z.string().optional().describe("Exact or partial play title."),
      style: z.enum(["Verse", "Prose"]).optional().describe("Verse or prose."),
      act: z.number().int().optional().describe("Filter to a specific act number."),
      limit: z.number().int().min(1).max(100).optional().describe("Max results to return (default 25)."),
    },
    async ({ query, gender, play, style, act, limit }) => {
      const all = await getIndex();
      const q = (query ?? "").trim().toLowerCase();
      const playQ = (play ?? "").trim().toLowerCase();

      const matches = all.filter((m) => {
        if (!genderMatch(m, gender)) return false;
        if (style && m.style !== style) return false;
        if (act != null && m.act !== act) return false;
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

      const returned = matches.slice(0, limit ?? 25);
      return textResult({
        total_matches: matches.length,
        returned: returned.length,
        attribution: ATTRIBUTION,
        monologues: returned,
      });
    },
  );

  server.tool(
    "get_monologue",
    "Fetch one monologue's catalogue entry by its numeric id. Follow the returned `url` for the full text.",
    { id: z.number().int().describe("The monologue's numeric id.") },
    async ({ id }) => {
      const all = await getIndex();
      const m = all.find((x) => x.id === id);
      if (!m) return textResult({ error: `No monologue found with id ${id}.` });
      return textResult({ ...m, attribution: ATTRIBUTION });
    },
  );

  server.tool(
    "random_monologue",
    "Return one random monologue, with optional gender/play filters. Useful for a suggestion when the user is undecided.",
    {
      gender: z.enum(["Men", "Women", "Both"]).optional(),
      play: z.string().optional().describe("Exact or partial play title."),
    },
    async ({ gender, play }) => {
      const all = await getIndex();
      const playQ = (play ?? "").trim().toLowerCase();
      const pool = all.filter(
        (m) => genderMatch(m, gender) && (!playQ || m.play.toLowerCase().includes(playQ)),
      );
      if (pool.length === 0) return textResult({ error: "No monologues match those filters." });
      const m = pool[Math.floor(Math.random() * pool.length)];
      return textResult({ ...m, attribution: ATTRIBUTION });
    },
  );

  server.tool(
    "list_plays",
    "List Shakespeare's plays with their classification (Comedy/History/Tragedy) and monologue counts.",
    {},
    async () => {
      const all = await getIndex();
      const byPlay = new Map<string, { play: string; play_type: string; monologue_count: number }>();
      for (const m of all) {
        const entry = byPlay.get(m.play) ?? { play: m.play, play_type: m.play_type, monologue_count: 0 };
        entry.monologue_count += 1;
        byPlay.set(m.play, entry);
      }
      const plays = [...byPlay.values()].sort((a, b) => a.play.localeCompare(b.play));
      return textResult({ count: plays.length, plays });
    },
  );

  server.tool(
    "list_all_monologues_for_a_character",
    "List every monologue spoken by a given character (e.g. 'Hamlet', 'Rosalind'). Matches the character name exactly first, then as a substring.",
    {
      character: z.string().describe("Character name."),
      limit: z.number().int().min(1).max(200).optional().describe("Max results (default 50)."),
    },
    async ({ character, limit }) => {
      const all = await getIndex();
      const c = character.trim().toLowerCase();
      const exact = all.filter((m) => m.character.toLowerCase() === c);
      const matches = exact.length > 0 ? exact : all.filter((m) => m.character.toLowerCase().includes(c));
      const returned = matches.slice(0, limit ?? 50);
      return textResult({
        character,
        total_matches: matches.length,
        returned: returned.length,
        attribution: ATTRIBUTION,
        monologues: returned,
      });
    },
  );

  server.tool(
    "get_monologue_of_the_day",
    "The current 'Monologue of the Day' — the piece most recently posted to the site's social feeds.",
    {},
    async () => {
      const mod = await fetchJson(`${API_BASE}/monologue-of-the-day.json`);
      if (!mod) return textResult({ error: "No monologue of the day is available." });
      return textResult(mod);
    },
  );

  server.tool(
    "get_paraphrased_monologue",
    "Fetch a monologue's full text alongside its modern-English, line-by-line paraphrase. The paraphrase is AI-generated (Claude) and may be null if it hasn't been generated yet — the `url` always has the monologue itself.",
    { id: z.number().int().describe("The monologue's numeric id.") },
    async ({ id }) => {
      const m = await fetchJson(`${API_BASE}/monologues/${id}`);
      if (!m || m.error) return textResult({ error: `No monologue with id ${id}.` });
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
    },
  );

  server.tool(
    "get_scene_summary",
    "Fetch an AI-generated summary of the scene a monologue appears in (context for the speech). May be null if not generated yet.",
    { monologue_id: z.number().int().describe("The id of a monologue in the scene.") },
    async ({ monologue_id }) => {
      const m = await fetchJson(`${API_BASE}/monologues/${monologue_id}`);
      if (!m || m.error) return textResult({ error: `No monologue with id ${monologue_id}.` });
      return textResult({
        play: m.play,
        location: m.location,
        scene_summary: m.scene_summary,
        url: m.url,
        note: m.content_note,
        attribution: ATTRIBUTION,
      });
    },
  );

  server.tool(
    "get_play_summary",
    "Fetch an AI-generated summary of a play (e.g. 'Hamlet', 'The Tempest'). May be null if not generated yet.",
    { play: z.string().describe("Play title (exact or partial).") },
    async ({ play }) => {
      const all = await getIndex();
      const p = play.trim().toLowerCase();
      const hit = all.find((m) => m.play.toLowerCase() === p) ?? all.find((m) => m.play.toLowerCase().includes(p));
      if (!hit) return textResult({ error: `No play matching "${play}".` });
      const full = await fetchJson(`${API_BASE}/monologues/${hit.id}`);
      return textResult({
        play: full.play,
        play_summary: full.play_summary,
        note: full.content_note,
        attribution: ATTRIBUTION,
      });
    },
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
