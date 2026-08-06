import { chromium, type Page } from "playwright";
import type { SourceConfig } from "./config.js";
import { assertAllowedUrl } from "./config.js";
import { localeFromUrl, PageIndexStore, type IndexedPage } from "./page-index.js";

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

async function documentSignature(page: Page): Promise<string> {
  const content = page.locator("article.site-document-container, article, main").first();
  await content.waitFor({ state: "attached", timeout: 10_000 }).catch(() => undefined);
  const [text, linkCount] = await Promise.all([
    content.innerText({ timeout: 5_000 }).catch(() => ""),
    page.locator("a[href]").count()
  ]);
  return `${linkCount}\0${text}`;
}

async function waitForDocumentStable(page: Page, previousPageSignature?: string): Promise<void> {
  const headings = page.locator("article.site-document-container, article, main").first().locator("h1, h2, h3, h4, h5, h6");
  let previous = "";
  let stableSamples = 0;
  let contentChanged = previousPageSignature === undefined;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const [signature, headingCount] = await Promise.all([
      documentSignature(page),
      headings.count()
    ]);
    if (signature !== previousPageSignature) contentChanged = true;
    if (signature === previous) stableSamples += 1;
    else stableSamples = 0;
    if (contentChanged && headingCount > 0 && stableSamples >= 5) return;
    previous = signature;
    await page.waitForTimeout(100);
  }
}

async function navigateForIndex(
  page: Page,
  source: SourceConfig,
  target: string
): Promise<{ mode: "spa" | "full"; previousPageSignature?: string }> {
  const current = page.url();
  const currentAllowed = source.allowedOrigins.some((origin) => {
    try {
      return new URL(origin).origin === new URL(current).origin;
    } catch {
      return false;
    }
  });
  if (currentAllowed && localeFromUrl(current) === localeFromUrl(target)) {
    const previousPageSignature = await documentSignature(page);
    const targetUrl = new URL(target);
    for (const href of [targetUrl.pathname, target]) {
      const link = page.locator(`a[href=${JSON.stringify(href)}]`);
      if (await link.count() === 0) continue;
      await link.first().dispatchEvent("click");
      try {
        await page.waitForFunction(
          `() => location.href.split("#", 1)[0] === ${JSON.stringify(target)}`,
          undefined,
          { timeout: 3_000 }
        );
        return { mode: "spa", previousPageSignature };
      } catch {
        break;
      }
    }
  }

  await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await waitForProtectedPagesRedirect(page, source);
  return { mode: "full" };
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

    const pageTitle = cleanHeading(headings.find((heading) => heading.tagName === "H1")?.textContent ?? headings[0]?.textContent) || document.title;
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
  concurrency: number;
  spaNavigations: number;
  fullNavigations: number;
  durationMs: number;
  errors: string[];
};

export class SiteIndexer {
  async refresh(source: SourceConfig, databasePath: string, maxPages: number, concurrency = 12): Promise<RefreshIndexResult> {
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
    let spaNavigations = 0;
    let fullNavigations = 0;
    const workerLimit = Math.max(1, Math.min(32, concurrency));

    try {
      type Worker = { page: Page; locale?: string; busy: boolean };
      const workers: Worker[] = await Promise.all(Array.from({ length: workerLimit }, async () => ({
        page: await context.newPage(),
        busy: false
      })));

      const processTarget = async (worker: Worker, target: string) => {
        const page = worker.page;
        try {
          const navigation = await navigateForIndex(page, source, target);
          if (navigation.mode === "spa") spaNavigations += 1;
          else fullNavigations += 1;
          if (!isAuthenticatedPage(page, source)) {
            authenticated = false;
            errors.push(`Authentication required: ${page.url()}`);
            return;
          }
          await waitForDocumentStable(page, navigation.previousPageSignature);
          const extracted = await extractPage(page);
          const finalUrl = canonicalizePageUrl(source, extracted.page.url);
          if (!finalUrl) throw new Error(`Navigation left the indexable origin: ${extracted.page.url}`);
          extracted.page.url = finalUrl;
          worker.locale = localeFromUrl(finalUrl);

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
      };

      const takeNextTarget = (worker: Worker): string | undefined => {
        if (queue.length === 0) return undefined;
        const preferredIndex = worker.locale
          ? queue.findIndex((candidate) => localeFromUrl(candidate) === worker.locale)
          : -1;
        const index = preferredIndex >= 0 ? preferredIndex : 0;
        return queue.splice(index, 1)[0];
      };

      const inFlight = new Map<Promise<void>, Worker>();
      const schedule = (worker: Worker, target: string) => {
        let task: Promise<void>;
        worker.busy = true;
        task = processTarget(worker, target).finally(() => {
          worker.busy = false;
          inFlight.delete(task);
        });
        inFlight.set(task, worker);
      };

      while ((queue.length > 0 || inFlight.size > 0) && authenticated) {
        for (const worker of workers) {
          if (worker.busy || visited.size >= maxPages || !authenticated) continue;
          const target = takeNextTarget(worker);
          if (!target) break;
          if (visited.has(target)) continue;
          visited.add(target);
          schedule(worker, target);
        }
        if (inFlight.size === 0) break;
        await Promise.race(inFlight.keys());
      }
      await Promise.allSettled([...inFlight.keys()]);

      const truncated = queue.length > 0 || queued.size > visited.size;
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
        concurrency: workerLimit,
        spaNavigations,
        fullNavigations,
        durationMs: Date.now() - startedAt,
        errors
      };
    } finally {
      await context.close();
      store.close();
    }
  }
}
