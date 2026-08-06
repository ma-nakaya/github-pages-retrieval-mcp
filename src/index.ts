import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { join } from "node:path";
import { z } from "zod";
import { readAuthState, writeAuthState } from "./auth-state.js";
import { BrowserFetcher } from "./browser-fetcher.js";
import { assertAllowedUrl, findSource, loadConfig } from "./config.js";
import { PageIndexStore } from "./page-index.js";
import { canonicalizePageUrl, SiteIndexer, type RefreshIndexResult } from "./site-indexer.js";

const server = new McpServer({
  name: "github-pages-retrieval",
  version: "0.1.0"
}, {
  instructions: "Private GitHub Pages retrieval only. The server never accesses a source repository or GitHub API."
});

const fetcher = new BrowserFetcher();
const indexer = new SiteIndexer();
type RefreshJob = {
  jobId: string;
  sourceId: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  finishedAt?: string;
  result?: RefreshIndexResult;
  error?: string;
};
const refreshJobs = new Map<string, RefreshJob>();
const sourceIdSchema = z.object({ sourceId: z.string().min(1) });

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) },], structuredContent: value as Record<string, unknown> };
}

async function sourceFor(sourceId: string) {
  const config = await loadConfig();
  return { config, source: findSource(config, sourceId) };
}

function indexPath(stateDir: string): string {
  return join(stateDir, "pages-index.sqlite");
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

server.registerTool("refresh_pages_index", {
  title: "Refresh Pages index",
  description: "Starts a background crawl of allowlisted rendered Pages links. Returns immediately; poll get_pages_index for compact progress and final statistics.",
  inputSchema: {
    sourceId: z.string().min(1),
    maxPages: z.number().int().min(1).max(2_000).default(500)
  }
}, async ({ sourceId, maxPages }) => {
  const { config, source } = await sourceFor(sourceId);
  const active = refreshJobs.get(source.id);
  if (active?.status === "running") return textResult(active);

  const job: RefreshJob = {
    jobId: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    sourceId: source.id,
    status: "running",
    startedAt: new Date().toISOString()
  };
  refreshJobs.set(source.id, job);
  void indexer.refresh(source, indexPath(config.stateDir), maxPages).then(async (result) => {
    job.status = "completed";
    job.finishedAt = new Date().toISOString();
    job.result = result;
    const checkedAt = new Date().toISOString();
    await writeAuthState(config.stateDir, source.id, result.status === "ready"
      ? { status: "ready", checkedAt }
      : { status: "auth_required", checkedAt, reason: result.errors[0] ?? "Authentication is required." });
  }).catch((error) => {
    job.status = "failed";
    job.finishedAt = new Date().toISOString();
    job.error = error instanceof Error ? error.message : String(error);
  });
  return textResult(job);
});

server.registerTool("get_pages_index", {
  title: "Get compact Pages index",
  description: "Returns index status and a compact URL/title list. Use pathContains and a small limit to minimize tokens.",
  inputSchema: {
    sourceId: z.string().min(1),
    pathContains: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(500).default(50)
  }
}, async ({ sourceId, pathContains, limit }) => {
  const { config, source } = await sourceFor(sourceId);
  const store = await PageIndexStore.open(indexPath(config.stateDir));
  try {
    const status = store.getStatus(source.id);
    const pages = store.listPages(source.id, limit, pathContains);
    return textResult({
      sourceId: source.id,
      ...status,
      refresh: refreshJobs.get(source.id),
      returned: pages.length,
      pages
    });
  } finally {
    store.close();
  }
});

server.registerTool("search_pages_index", {
  title: "Search Pages index",
  description: "Searches the local Japanese/English trigram index and returns only top headings with bounded snippets. Refresh the index first when it is empty or stale.",
  inputSchema: {
    sourceId: z.string().min(1),
    query: z.string().min(1),
    urlContains: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(20).default(5),
    maxSnippetChars: z.number().int().min(80).max(1_000).default(280)
  }
}, async ({ sourceId, query, urlContains, limit, maxSnippetChars }) => {
  const { config, source } = await sourceFor(sourceId);
  const store = await PageIndexStore.open(indexPath(config.stateDir));
  try {
    const status = store.getStatus(source.id);
    const results = store.search(source.id, query, limit, maxSnippetChars, urlContains);
    return textResult({ sourceId: source.id, query, urlContains, ...status, resultCount: results.length, results });
  } finally {
    store.close();
  }
});

server.registerTool("fetch_indexed_section", {
  title: "Fetch indexed page or section",
  description: "Returns one cached page or exact heading/anchor with a strict character cap. Prefer a heading returned by search_pages_index to minimize tokens.",
  inputSchema: {
    sourceId: z.string().min(1),
    url: z.string().url(),
    heading: z.string().min(1).optional(),
    maxChars: z.number().int().min(200).max(20_000).default(5_000)
  }
}, async ({ sourceId, url, heading, maxChars }) => {
  const { config, source } = await sourceFor(sourceId);
  const target = canonicalizePageUrl(source, url);
  if (!target) throw new Error(`URL is not indexable for ${source.id}: ${url}`);
  const store = await PageIndexStore.open(indexPath(config.stateDir));
  try {
    const result = store.getPageContent(source.id, target, heading, maxChars);
    return textResult(result
      ? { sourceId: source.id, found: true, ...result }
      : { sourceId: source.id, found: false, url: target, heading });
  } finally {
    store.close();
  }
});

await server.connect(new StdioServerTransport());
