import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readAuthState, writeAuthState } from "./auth-state.js";
import { BrowserFetcher } from "./browser-fetcher.js";
import { assertAllowedUrl, findSource, loadConfig } from "./config.js";

const server = new McpServer({
  name: "github-pages-retrieval",
  version: "0.1.0"
}, {
  instructions: "Private GitHub Pages retrieval only. The server never accesses a source repository or GitHub API."
});

const fetcher = new BrowserFetcher();
const sourceIdSchema = z.object({ sourceId: z.string().min(1) });

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) },], structuredContent: value as Record<string, unknown> };
}

async function sourceFor(sourceId: string) {
  const config = await loadConfig();
  return { config, source: findSource(config, sourceId) };
}

server.registerTool("get_source_auth_status", {
  title: "Get source authentication status",
  description: "Returns the last known authentication state for a configured GitHub Pages source without exposing browser credentials.",
  inputSchema: sourceIdSchema.shape
}, async ({ sourceId }) => {
  const { config, source } = await sourceFor(sourceId);
  return textResult({ sourceId: source.id, ...(await readAuthState(config.stateDir, source.id)) });
});

server.registerTool("begin_source_reauth", {
  title: "Begin source reauthentication",
  description: "Opens a visible, persistent local browser at the configured GitHub Pages URL. The user completes GitHub, SAML, and MFA themselves.",
  inputSchema: sourceIdSchema.shape
}, async ({ sourceId }) => {
  const { source } = await sourceFor(sourceId);
  await fetcher.startInteractiveReauth(source);
  return textResult({ sourceId: source.id, status: "auth_in_progress", nextAction: "Complete sign-in in the opened local browser, then call validate_source_auth." });
});

server.registerTool("validate_source_auth", {
  title: "Validate source authentication",
  description: "Validates a completed interactive authentication session against the configured protected Pages URL and persists only the resulting status.",
  inputSchema: sourceIdSchema.shape
}, async ({ sourceId }) => {
  const { config, source } = await sourceFor(sourceId);
  const inspection = await fetcher.validateInteractiveReauth(source);
  const state = inspection.authenticated
    ? { status: "ready" as const, checkedAt: new Date().toISOString() }
    : { status: "auth_required" as const, checkedAt: new Date().toISOString(), reason: inspection.reason };
  await writeAuthState(config.stateDir, source.id, state);
  return textResult({ sourceId: source.id, ...state, url: inspection.url });
});

server.registerTool("fetch_pages_content", {
  title: "Fetch GitHub Pages content",
  description: "Fetches one allowlisted GitHub Pages URL through its persistent local browser profile. It never reads the source repository.",
  inputSchema: {
    sourceId: z.string().min(1),
    url: z.string().url().optional()
  }
}, async ({ sourceId, url }) => {
  const { config, source } = await sourceFor(sourceId);
  const target = assertAllowedUrl(source, url ?? source.startUrl).toString();
  const inspection = await fetcher.fetch(source, target);
  const state = inspection.authenticated
    ? { status: "ready" as const, checkedAt: new Date().toISOString() }
    : { status: "auth_required" as const, checkedAt: new Date().toISOString(), reason: inspection.reason };
  await writeAuthState(config.stateDir, source.id, state);
  return textResult({ sourceId: source.id, ...inspection });
});

await server.connect(new StdioServerTransport());
