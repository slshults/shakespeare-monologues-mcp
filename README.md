# Shakespeare's Monologues — MCP server

A small, read-only [Model Context Protocol](https://modelcontextprotocol.io) server
that lets MCP-capable AI clients search and fetch Shakespeare monologue metadata from
[shakespeare-monologues.org](https://www.shakespeare-monologues.org).

It's a **thin, stateless wrapper** over the site's public JSON index
(`/api/monologues.json`) — no database, no secrets. Every result carries the
monologue's permalink `url` (where the full text, scene context, and modern-English
paraphrase live) and an attribution note.

## Tools

| Tool | What it does |
| --- | --- |
| `search_monologues` | Free-text search (character / play / first line) + filters: `gender`, `play`, `style`, `act`, `limit`. |
| `get_monologue` | One monologue's index entry by numeric `id`. |
| `random_monologue` | A random monologue, optional `gender` / `play` filters. |
| `list_plays` | Every play with its classification and monologue count. |
| `list_all_monologues_for_a_character` | Every monologue spoken by a named character. |
| `get_monologue_of_the_day` | The current Monologue of the Day (latest social post). |
| `get_paraphrased_monologue` | A monologue's full text + its modern-English paraphrase (AI-generated; may be null if not yet generated). |
| `get_scene_summary` | AI-generated summary of the scene a monologue is in (by monologue id). |
| `get_play_summary` | AI-generated summary of a play (by title). |

> The paraphrase and summaries are AI-generated (Claude) and only partially cached so far,
> so those tools return `null` where content hasn't been generated yet.

## Run locally

```bash
npm install
npm run build
npm start          # listens on :3000, POST /mcp   (set PORT to change)
```

Health check: `GET /health` → `{"ok":true}`.

## Connecting a client

Remote MCP means users add a **URL**, no install. In a client that supports remote /
custom MCP servers (Claude Desktop connectors, etc.), add:

```
https://mcp.shakespeare-monologues.org/mcp
```

> Note on "autonomous" use: there's no mechanism today for an arbitrary agent to
> discover and use this with zero user action — a client/platform still has to connect
> it. For truly zero-setup access, agents can hit the plain JSON API
> (`/api/monologues.json`) and `/llms.txt` directly.

## License

- **Code:** MIT.
- **Data** served through it: © shakespeare-monologues.org, **CC BY-NC-SA 4.0** — please
  keep the attribution that each tool response includes.
