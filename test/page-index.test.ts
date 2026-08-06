import assert from "node:assert/strict";
import test from "node:test";
import type { SourceConfig } from "../src/config.js";
import { PageIndexStore, type IndexedPage } from "../src/page-index.js";
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

    const section = store.getPageContent(source.id, buttonPage.url, "prevent-click", 500);
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
});
