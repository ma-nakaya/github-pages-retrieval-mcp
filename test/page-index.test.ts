import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configureSource, loadConfig, loadConfigIfPresent } from "../src/config.js";
import type { SourceConfig } from "../src/config.js";
import { localeFromUrl, PageIndexStore, type IndexedPage } from "../src/page-index.js";
import { canonicalizePageUrl } from "../src/site-indexer.js";

const source: SourceConfig = {
  id: "docs",
  startUrl: "https://docs.example.test/guide/overview.ja",
  allowedOrigins: ["https://docs.example.test"],
  profileDir: ".data/profile"
};

const buttonPage: IndexedPage = {
  url: "https://docs.example.test/component/button.ja",
  title: "Button ボタン",
  documentTitle: "Example UI",
  sections: [
    { position: 0, heading: "Button ボタン", level: 1, anchor: "button", body: "ボタンコンポーネントの概要。" },
    { position: 1, heading: "重複クリック防止", level: 2, anchor: "prevent-click", body: "連続した重複クリックを防止する設定。" }
  ]
};

const tablePage: IndexedPage = {
  url: "https://docs.example.test/component/table.ja",
  title: "Table テーブル",
  documentTitle: "Example UI",
  sections: [
    { position: 0, heading: "Table テーブル", level: 1, anchor: "table", body: "大量データを表示するテーブル。" }
  ]
};

test("SQLite trigram index searches Japanese sections and removes stale pages", async () => {
  const store = await PageIndexStore.open(":memory:");
  try {
    assert.equal(store.upsertPage(source.id, "run-1", buttonPage), "inserted");
    assert.equal(store.upsertPage(source.id, "run-1", tablePage), "inserted");
    assert.equal(store.upsertPage(source.id, "run-1", buttonPage), "unchanged");

    const results = store.search(source.id, "重複クリック", 5, 120);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.heading, "重複クリック防止");
    assert.match(results[0]?.snippet ?? "", /重複クリック/u);
    assert.equal(store.search(source.id, "重複クリック", 5, 120, ".en").length, 0);
    assert.equal(store.search(source.id, "重複クリック", 5, 120, undefined, "ja").length, 1);
    assert.equal(store.search(source.id, "重複クリック", 5, 120, undefined, "default").length, 0);
    assert.equal(store.listPages(source.id, 10, undefined, "ja").length, 2);
    assert.equal(store.listPages(source.id, 10, undefined, "default").length, 0);
    assert.deepEqual(store.getStatus(source.id).locales, { ja: 2 });

    const section = store.getPageContent(source.id, buttonPage.url, "prevent-click", 500);
    assert.equal(section?.locale, "ja");
    assert.equal(section?.truncated, false);
    assert.equal(section?.headings.length, 1);
    assert.match(section?.content ?? "", /連続した重複クリック/u);

    assert.equal(store.upsertPage(source.id, "run-2", tablePage), "unchanged");
    assert.equal(store.removePagesNotSeen(source.id, "run-2"), 1);
    assert.equal(store.getStatus(source.id).pageCount, 1);
  } finally {
    store.close();
  }
});

test("crawler canonicalizes allowlisted page URLs and rejects assets", () => {
  assert.equal(
    canonicalizePageUrl(source, "https://docs.example.test/component/button.ja?x=1#api"),
    "https://docs.example.test/component/button.ja"
  );
  assert.equal(canonicalizePageUrl(source, "https://docs.example.test/assets/app.js"), undefined);
  assert.equal(canonicalizePageUrl(source, "https://github.com/example/repo"), undefined);
  assert.equal(localeFromUrl("https://docs.example.test/component/button"), "default");
  assert.equal(localeFromUrl("https://docs.example.test/component/button.en"), "en");
  assert.equal(localeFromUrl("https://docs.example.test/component/button.ja"), "ja");
  assert.equal(localeFromUrl("https://docs.example.test/component/button.zh-CN"), "zh-cn");
});

test("initial setup safely creates and reuses a source configuration from a Pages URL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gpr-config-"));
  const path = join(directory, "plugin-data", "config.local.json");
  const previousPath = process.env.GPR_CONFIG_PATH;
  process.env.GPR_CONFIG_PATH = path;
  try {
    assert.equal(await loadConfigIfPresent(), undefined);
    const created = await configureSource("https://docs.example.test/guide/overview.ja#usage");
    assert.equal(created.created, true);
    assert.equal(created.source.id, "docs-example-test");
    assert.equal(created.source.startUrl, "https://docs.example.test/guide/overview.ja");
    assert.deepEqual(created.source.allowedOrigins, ["https://docs.example.test"]);

    const stored = JSON.parse(await readFile(path, "utf8")) as {
      sources: Array<{ profileDir: string }>;
    };
    assert.equal(stored.sources[0]?.profileDir, join(".data", "browser-profiles", "docs-example-test"));
    const loaded = await loadConfig();
    assert.equal(loaded.sources.length, 1);

    const duplicate = await configureSource("https://docs.example.test/component/button.ja");
    assert.equal(duplicate.created, false);
    assert.equal((await loadConfig()).sources.length, 1);

    const second = await configureSource("https://second-guide.pages.github.io/guide/overview.ja");
    assert.equal(second.source.id, "second-guide");
    assert.equal((await loadConfig()).sources.length, 2);
    await assert.rejects(
      () => configureSource("https://another.example.test/", "docs-example-test"),
      /already configured/u
    );
    await assert.rejects(() => configureSource("http://insecure.example.test/"), /must use HTTPS/u);
  } finally {
    if (previousPath === undefined) delete process.env.GPR_CONFIG_PATH;
    else process.env.GPR_CONFIG_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});
