import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { join } from "node:path";
import { z } from "zod";
import { readAuthState, writeAuthState } from "./auth-state.js";
import { BrowserFetcher } from "./browser-fetcher.js";
import { assertAllowedUrl, configureSource, findSource, loadConfig, loadConfigIfPresent } from "./config.js";
import { PageIndexStore } from "./page-index.js";
import { canonicalizePageUrl, SiteIndexer, type RefreshIndexResult } from "./site-indexer.js";
import { ALL_SOURCES_ID } from "./source-id.js";

const server = new McpServer({
  name: "github-pages-retrieval",
  version: "0.2.0"
}, {
  instructions: "Private GitHub Pages retrieval only. Call list_pages_sources first. If no source is configured, ask the user for the exact Pages site URL, then call configure_pages_source. Use sourceId all only when the user asks to search across every configured source. The server never accesses a source repository or GitHub API."
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
const localeSchema = z.string()
  .regex(/^(all|default|[a-z]{2,3}(?:-[a-z0-9]{2,8})*)$/u)
  .default("all");

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) },], structuredContent: value as Record<string, unknown> };
}

async function sourceFor(sourceId: string) {
  const config = await loadConfig();
  return { config, source: findSource(config, sourceId) };
}

server.registerTool("list_pages_sources", {
  title: "List configured Pages sources",
  description: "Checks whether any Pages search targets are configured. Call this before authentication or search so an agent can request a site URL when the list is empty.",
  inputSchema: {}
}, async () => {
  const config = await loadConfigIfPresent();
  const sources = config?.sources.map(({ id, startUrl, authProbeUrl, allowedOrigins }) => ({
    id,
    startUrl,
    ...(authProbeUrl ? { authProbeUrl } : {}),
    allowedOrigins
  })) ?? [];
  return textResult({
    configured: sources.length > 0,
    sourceCount: sources.length,
    sources,
    ...(sources.length === 0 ? { nextAction: "Ask the user for the exact GitHub Pages site URL, then call configure_pages_source." } : {})
  });
});

server.registerTool("configure_pages_source", {
  title: "Configure a Pages source",
  description: "Persists a user-provided HTTPS Pages URL as a local search target, derives its exact origin allowlist, and creates a dedicated browser-profile path. Existing configuration is never replaced.",
  inputSchema: {
    startUrl: z.string().url(),
    sourceId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u).optional()
  }
}, async ({ startUrl, sourceId }) => {
  const result = await configureSource(startUrl, sourceId);
  return textResult({
    ...result,
    nextAction: result.created
      ? "Call get_source_auth_status for this source, then begin_source_reauth if authentication is required."
      : "Use the existing source id; this origin was already configured."
  });
});

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
  description: "Starts a parallel background crawl of allowlisted rendered Pages links. Returns immediately; poll get_pages_index for compact progress and final statistics.",
  inputSchema: {
    sourceId: z.string().min(1),
    maxPages: z.number().int().min(1).max(2_000).default(500),
    concurrency: z.number().int().min(1).max(32).default(12)
  }
}, async ({ sourceId, maxPages, concurrency }) => {
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
  void indexer.refresh(source, indexPath(config.stateDir), maxPages, concurrency).then(async (result) => {
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
  description: "Returns index status, locale counts, and one page of a compact URL/title list. Use search_pages_index for named items; follow nextOffset only when a complete listing is required.",
  inputSchema: {
    sourceId: z.string().min(1),
    pathContains: z.string().min(1).optional(),
    locale: localeSchema,
    limit: z.number().int().min(1).max(500).default(50),
    offset: z.number().int().min(0).default(0)
  }
}, async ({ sourceId, pathContains, locale, limit, offset }) => {
  const { config, source } = await sourceFor(sourceId);
  const store = await PageIndexStore.open(indexPath(config.stateDir));
  try {
    const status = store.getStatus(source.id);
    const filteredPageCount = store.countPages(source.id, pathContains, locale);
    const pages = store.listPages(source.id, limit, pathContains, locale, offset);
    const followingOffset = offset + pages.length;
    const hasMore = followingOffset < filteredPageCount;
    return textResult({
      sourceId: source.id,
      ...status,
      refresh: refreshJobs.get(source.id),
      filteredPageCount,
      offset,
      limit,
      returned: pages.length,
      hasMore,
      nextOffset: hasMore ? followingOffset : null,
      pages
    });
  } finally {
    store.close();
  }
});

server.registerTool("search_pages_index", {
  title: "Search Pages index",
  description: "Searches one source or all configured sources in the local multilingual trigram index. Use sourceId all for cross-site search; each result includes its actual sourceId for fetch_indexed_section.",
  inputSchema: {
    sourceId: z.string().min(1),
    query: z.string().min(1),
    urlContains: z.string().min(1).optional(),
    locale: localeSchema,
    limit: z.number().int().min(1).max(20).default(5),
    maxSnippetChars: z.number().int().min(80).max(1_000).default(280)
  }
}, async ({ sourceId, query, urlContains, locale, limit, maxSnippetChars }) => {
  const config = await loadConfig();
  const resolvedSourceId = sourceId === ALL_SOURCES_ID ? ALL_SOURCES_ID : findSource(config, sourceId).id;
  const searchedSourceIds = resolvedSourceId === ALL_SOURCES_ID
    ? config.sources.map((source) => source.id)
    : [resolvedSourceId];
  const store = await PageIndexStore.open(indexPath(config.stateDir));
  try {
    const status = store.getStatus(resolvedSourceId);
    const results = store.search(resolvedSourceId, query, limit, maxSnippetChars, urlContains, locale);
    return textResult({ sourceId: resolvedSourceId, searchedSourceIds, query, urlContains, locale, ...status, resultCount: results.length, results });
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
