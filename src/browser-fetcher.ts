import { mkdir } from "node:fs/promises";
import type { BrowserContext, Page } from "playwright";
import { chromium } from "playwright";
import type { SourceConfig } from "./config.js";
import { assertAllowedUrl } from "./config.js";

export type PageInspection = {
  authenticated: boolean;
  url: string;
  title: string;
  reason?: string;
  headings?: string[];
  body?: string;
};

const authUrlPattern = /github\.com\/(login|sessions)|\/sso\b|saml|signin|login/i;

export class BrowserFetcher {
  private readonly activeContexts = new Map<string, BrowserContext>();

  async startInteractiveReauth(source: SourceConfig): Promise<void> {
    if (this.activeContexts.has(source.id)) return;
    await mkdir(source.profileDir, { recursive: true });
    const context = await chromium.launchPersistentContext(source.profileDir, {
      headless: false,
      viewport: { width: 1280, height: 900 }
    });
    this.activeContexts.set(source.id, context);
    const page = await context.newPage();
    await page.goto(source.startUrl, { waitUntil: "domcontentloaded" });
  }

  async validateInteractiveReauth(source: SourceConfig): Promise<PageInspection> {
    const context = this.activeContexts.get(source.id);
    if (!context) throw new Error("No interactive reauthentication is in progress.");
    try {
      return await this.inspect(context, source, source.authProbeUrl ?? source.startUrl, false);
    } finally {
      await context.close();
      this.activeContexts.delete(source.id);
    }
  }

  async fetch(source: SourceConfig, url: string): Promise<PageInspection> {
    const target = assertAllowedUrl(source, url).toString();
    await mkdir(source.profileDir, { recursive: true });
    const context = await chromium.launchPersistentContext(source.profileDir, { headless: true });
    try {
      return await this.inspect(context, source, target, true);
    } finally {
      await context.close();
    }
  }

  private async inspect(context: BrowserContext, source: SourceConfig, target: string, includeContent: boolean): Promise<PageInspection> {
    const page = await context.newPage();
    try {
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 });
      const currentUrl = new URL(page.url());
      if (currentUrl.origin === "https://github.com" && currentUrl.pathname === "/pages/auth") {
        await page.waitForURL(
          (url) => source.allowedOrigins.some((origin) => new URL(origin).origin === url.origin),
          { waitUntil: "domcontentloaded", timeout: 10_000 }
        ).catch(() => undefined);
      }
      return await this.readPage(page, source, includeContent);
    } finally {
      await page.close();
    }
  }

  private async readPage(page: Page, source: SourceConfig, includeContent: boolean): Promise<PageInspection> {
    const currentUrl = page.url();
    const title = await page.title().catch(() => "");
    const isOutsideAllowedOrigin = !source.allowedOrigins.some((origin) => new URL(origin).origin === new URL(currentUrl).origin);
    const likelyAuthPage = authUrlPattern.test(currentUrl) || /sign in|single sign-on|saml/i.test(title);
    if (isOutsideAllowedOrigin || likelyAuthPage) {
      return { authenticated: false, url: currentUrl, title, reason: "Redirected to an authentication page." };
    }
    if (!includeContent) return { authenticated: true, url: currentUrl, title };

    const [body, headings] = await Promise.all([
      page.locator("body").innerText({ timeout: 10_000 }),
      page.locator("h1, h2, h3").allTextContents()
    ]);
    return {
      authenticated: true,
      url: currentUrl,
      title,
      headings: headings.map((heading) => heading.trim()).filter(Boolean),
      body: body.trim()
    };
  }
}
