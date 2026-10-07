#!/usr/bin/env node
/**
 * Shakespeare's Monologues — stdio entry point.
 *
 * What `npx shakespeare-monologues-mcp` runs. Same tools as the hosted server;
 * the client spawns this process and speaks JSON-RPC over stdin/stdout.
 *
 * Nothing here may write to stdout — that channel carries the protocol, and a
 * stray log line corrupts the stream. Diagnostics go to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer, posthog } from "./server.js";

const server = buildServer({ conversationIds: false });
const transport = new StdioServerTransport();

async function shutdown() {
  if (posthog) await posthog.shutdown();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await server.connect(transport);
