import type { Page } from "playwright";
import type { SourceConfig } from "./config.js";
import { isAllowedUrl } from "./config.js";

export async function waitForPagesAuthRedirect(page: Page, source: SourceConfig): Promise<void> {
  const current = new URL(page.url());
  if (current.origin !== "https://github.com" || current.pathname !== "/pages/auth") return;
  await page.waitForURL(
    (url) => isAllowedUrl(source, url),
    { waitUntil: "domcontentloaded", timeout: 10_000 }
  ).catch(() => undefined);
}
