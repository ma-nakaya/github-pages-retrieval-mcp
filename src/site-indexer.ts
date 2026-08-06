import { chromium, type Page } from "playwright";
import type { SourceConfig } from "./config.js";
import { assertAllowedUrl } from "./config.js";
import { PageIndexStore, type IndexedPage } from "./page-index.js";

const ignoredExtensions = new Set([
  ".avif", ".css", ".gif", ".ico", ".jpeg", ".jpg", ".js", ".json", ".map",
  ".mp3", ".mp4", ".pdf", ".png", ".svg", ".txt", ".webm", ".webp", ".woff", ".woff2", ".xml"
]);

export function canonicalizePageUrl(source: SourceConfig, value: string): string | undefined {
  let url: URL;
  try {
    url = assertAllowedUrl(source, value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  url.hash = "";
  url.search = "";
  const filename = url.pathname.split("/").at(-1) ?? "";
  const extensionAt = filename.lastIndexOf(".");
  if (extensionAt >= 0 && ignoredExtensions.has(filename.slice(extensionAt).toLocaleLowerCase())) return undefined;
  return url.toString();
}

async function waitForProtectedPagesRedirect(page: Page, source: SourceConfig): Promise<void> {
  const current = new URL(page.url());
  if (current.origin !== "https://github.com" || current.pathname !== "/pages/auth") return;
  await page.waitForURL(
    (url) => source.allowedOrigins.some((origin) => new URL(origin).origin === url.origin),
    { waitUntil: "domcontentloaded", timeout: 10_000 }
  ).catch(() => undefined);
}

function isAuthenticatedPage(page: Page, source: SourceConfig): boolean {
  const current = new URL(page.url());
  const allowed = source.allowedOrigins.some((origin) => new URL(origin).origin === current.origin);
  return allowed;
}

async function extractPage(page: Page): Promise<{ page: IndexedPage; links: string[] }> {
  return page.evaluate(`(() => {
    const normalize = (value) => (value ?? "").replace(/\\s+/gu, " ").trim();
    const normalizeBody = (value) => (value ?? "")
      .replace(/[ \\t]+/gu, " ")
      .replace(/ *\\n */gu, "\\n")
      .replace(/\\n{3,}/gu, "\\n\\n")
      .trim();
    const cleanHeading = (value) => normalize(value).replace(/^#+\\s*/u, "");
    const root = document.querySelector("article.site-document-container")
      ?? document.querySelector("article")
      ?? document.querySelector("main")
      ?? document.body;
    const headings = Array.from(root.querySelectorAll("h1, h2, h3, h4, h5, h6"));

    const rangeText = (start, end) => {
      const range = document.createRange();
      range.selectNodeContents(root);
      if (start) range.setStartAfter(start);
      if (end) range.setEndBefore(end);
      const container = document.createElement("div");
      container.append(range.cloneContents());
      container.querySelectorAll("script, style, svg").forEach((element) => element.remove());
      container.querySelectorAll("th, td").forEach((element) => element.append(" | "));
      container.querySelectorAll("p, li, tr, pre, blockquote").forEach((element) => element.append("\\n"));
      return normalizeBody(container.textContent);
    };

    const pageTitle = cleanHeading(headings.find((heading) => heading.tagName === "H1")?.textContent) || document.title;
    const sections = [];
    const intro = rangeText(undefined, headings[0]);
    if (intro) sections.push({ position: 0, heading: pageTitle, level: 1, body: intro });
    headings.forEach((heading, index) => {
      sections.push({
        position: sections.length,
        heading: cleanHeading(heading.textContent) || pageTitle,
        level: Number(heading.tagName.slice(1)),
        ...(heading.id ? { anchor: heading.id } : {}),
        body: rangeText(heading, headings[index + 1])
      });
    });
    if (sections.length === 0) {
      sections.push({ position: 0, heading: pageTitle, level: 1, body: normalizeBody(root.textContent) });
    }

    return {
      page: {
        url: location.href.split("#", 1)[0],
        title: pageTitle,
        documentTitle: document.title,
        sections
      },
      links: Array.from(document.querySelectorAll("a[href]"), (link) => link.href)
    };
  })()`);
}

export type RefreshIndexResult = {
  sourceId: string;
  status: "ready" | "auth_required";
  pagesVisited: number;
  pagesDiscovered: number;
  inserted: number;
  updated: number;
  unchanged: number;
  failed: number;
  removed: number;
  truncated: boolean;
  durationMs: number;
  errors: string[];
};

export class SiteIndexer {
  async refresh(source: SourceConfig, databasePath: string, maxPages: number): Promise<RefreshIndexResult> {
    const startedAt = Date.now();
    const runId = `${startedAt}-${Math.random().toString(16).slice(2)}`;
    const startUrl = canonicalizePageUrl(source, source.startUrl);
    if (!startUrl) throw new Error(`The source start URL cannot be indexed: ${source.startUrl}`);

    const store = await PageIndexStore.open(databasePath);
    const context = await chromium.launchPersistentContext(source.profileDir, { headless: true });
    const queue = [startUrl];
    const queued = new Set(queue);
    const visited = new Set<string>();
    const errors: string[] = [];
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let failed = 0;
    let removed = 0;
    let authenticated = true;

    try {
      const page = await context.newPage();
      while (queue.length > 0 && visited.size < maxPages) {
        const target = queue.shift()!;
        if (visited.has(target)) continue;
        visited.add(target);
        try {
          await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 });
          await waitForProtectedPagesRedirect(page, source);
          if (!isAuthenticatedPage(page, source)) {
            authenticated = false;
            errors.push(`Authentication required: ${page.url()}`);
            break;
          }
          await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
          await page.locator("article, main").first().waitFor({ state: "attached", timeout: 10_000 }).catch(() => undefined);
          const extracted = await extractPage(page);
          const finalUrl = canonicalizePageUrl(source, extracted.page.url);
          if (!finalUrl) throw new Error(`Navigation left the indexable origin: ${extracted.page.url}`);
          extracted.page.url = finalUrl;

          const outcome = store.upsertPage(source.id, runId, extracted.page);
          if (outcome === "inserted") inserted += 1;
          else if (outcome === "updated") updated += 1;
          else unchanged += 1;

          for (const link of extracted.links) {
            const candidate = canonicalizePageUrl(source, link);
            if (candidate && !queued.has(candidate) && !visited.has(candidate)) {
              queued.add(candidate);
              queue.push(candidate);
            }
          }
        } catch (error) {
          failed += 1;
          if (errors.length < 20) {
            errors.push(`${target}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }

      const truncated = queue.length > 0;
      if (authenticated && failed === 0 && !truncated) {
        removed = store.removePagesNotSeen(source.id, runId);
      }
      return {
        sourceId: source.id,
        status: authenticated ? "ready" : "auth_required",
        pagesVisited: visited.size,
        pagesDiscovered: queued.size,
        inserted,
        updated,
        unchanged,
        failed,
        removed,
        truncated,
        durationMs: Date.now() - startedAt,
        errors
      };
    } finally {
      await context.close();
      store.close();
    }
  }
}
