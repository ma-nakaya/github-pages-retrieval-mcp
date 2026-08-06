import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type IndexedSection = {
  position: number;
  heading: string;
  level: number;
  anchor?: string;
  body: string;
};

export type IndexedPage = {
  url: string;
  title: string;
  documentTitle: string;
  sections: IndexedSection[];
};

type PageRow = {
  id: number;
  content_hash: string;
};

type SectionRow = {
  url: string;
  page_title: string;
  document_title: string;
  position: number;
  heading: string;
  level: number;
  anchor: string | null;
  body: string;
};

export type SearchResult = {
  url: string;
  locale: string;
  title: string;
  heading: string;
  level: number;
  anchor?: string;
  snippet: string;
};

export function localeFromUrl(value: string): string {
  try {
    const filename = new URL(value).pathname.split("/").at(-1) ?? "";
    const match = filename.match(/\.([a-z]{2,3}(?:-[a-z0-9]{2,8})*)$/iu);
    return match?.[1]?.toLocaleLowerCase() ?? "default";
  } catch {
    return "default";
  }
}

function pageHash(page: IndexedPage): string {
  return createHash("sha256").update(JSON.stringify(page)).digest("hex");
}

function ftsQuery(value: string): string | undefined {
  const terms = value.trim().split(/\s+/u).filter((term) => [...term].length >= 3);
  if (terms.length === 0) return undefined;
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

function snippet(body: string, query: string, maxChars: number): string {
  const normalized = body.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  const terms = query.trim().split(/\s+/u).filter(Boolean);
  const lower = normalized.toLocaleLowerCase();
  const offsets = terms.map((term) => lower.indexOf(term.toLocaleLowerCase())).filter((index) => index >= 0);
  const matchAt = offsets.length > 0 ? Math.min(...offsets) : 0;
  const start = Math.max(0, matchAt - Math.floor(maxChars / 3));
  const end = Math.min(normalized.length, start + maxChars);
  return `${start > 0 ? "…" : ""}${normalized.slice(start, end)}${end < normalized.length ? "…" : ""}`;
}

export class PageIndexStore {
  private constructor(private readonly database: DatabaseSync) {
    database.function("page_locale", { deterministic: true }, (value) => localeFromUrl(String(value ?? "")));
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS pages (
        id INTEGER PRIMARY KEY,
        source_id TEXT NOT NULL,
        url TEXT NOT NULL,
        title TEXT NOT NULL,
        document_title TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        last_seen_run TEXT NOT NULL,
        UNIQUE(source_id, url)
      );
      CREATE TABLE IF NOT EXISTS sections (
        id INTEGER PRIMARY KEY,
        page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        heading TEXT NOT NULL,
        level INTEGER NOT NULL,
        anchor TEXT,
        body TEXT NOT NULL,
        UNIQUE(page_id, position)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS section_search USING fts5(
        section_id UNINDEXED,
        source_id UNINDEXED,
        url UNINDEXED,
        page_title,
        heading,
        body,
        tokenize = 'trigram'
      );
      CREATE INDEX IF NOT EXISTS pages_source_url ON pages(source_id, url);
      CREATE INDEX IF NOT EXISTS sections_page_position ON sections(page_id, position);
    `);
  }

  static async open(databasePath: string): Promise<PageIndexStore> {
    if (databasePath !== ":memory:") await mkdir(dirname(databasePath), { recursive: true });
    return new PageIndexStore(new DatabaseSync(databasePath, { timeout: 5_000 }));
  }

  close(): void {
    this.database.close();
  }

  upsertPage(sourceId: string, runId: string, page: IndexedPage): "inserted" | "updated" | "unchanged" {
    const hash = pageHash(page);
    const existing = this.database.prepare(
      "SELECT id, content_hash FROM pages WHERE source_id = ? AND url = ?"
    ).get(sourceId, page.url) as PageRow | undefined;

    if (existing?.content_hash === hash) {
      this.database.prepare("UPDATE pages SET last_seen_run = ? WHERE id = ?").run(runId, existing.id);
      return "unchanged";
    }

    this.database.exec("BEGIN IMMEDIATE");
    try {
      let pageId: number;
      const indexedAt = new Date().toISOString();
      if (existing) {
        this.database.prepare(
          "DELETE FROM section_search WHERE section_id IN (SELECT id FROM sections WHERE page_id = ?)"
        ).run(existing.id);
        this.database.prepare("DELETE FROM sections WHERE page_id = ?").run(existing.id);
        this.database.prepare(`
          UPDATE pages
          SET title = ?, document_title = ?, content_hash = ?, indexed_at = ?, last_seen_run = ?
          WHERE id = ?
        `).run(page.title, page.documentTitle, hash, indexedAt, runId, existing.id);
        pageId = existing.id;
      } else {
        const result = this.database.prepare(`
          INSERT INTO pages(source_id, url, title, document_title, content_hash, indexed_at, last_seen_run)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(sourceId, page.url, page.title, page.documentTitle, hash, indexedAt, runId);
        pageId = Number(result.lastInsertRowid);
      }

      const insertSection = this.database.prepare(`
        INSERT INTO sections(page_id, position, heading, level, anchor, body)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const insertSearch = this.database.prepare(`
        INSERT INTO section_search(section_id, source_id, url, page_title, heading, body)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const section of page.sections) {
        const result = insertSection.run(
          pageId,
          section.position,
          section.heading,
          section.level,
          section.anchor ?? null,
          section.body
        );
        insertSearch.run(
          Number(result.lastInsertRowid),
          sourceId,
          page.url,
          page.title,
          section.heading,
          section.body
        );
      }
      this.database.exec("COMMIT");
      return existing ? "updated" : "inserted";
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  removePagesNotSeen(sourceId: string, runId: string): number {
    const stale = this.database.prepare(
      "SELECT id FROM pages WHERE source_id = ? AND last_seen_run <> ?"
    ).all(sourceId, runId) as Array<{ id: number }>;
    if (stale.length === 0) return 0;

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const removeSearch = this.database.prepare(
        "DELETE FROM section_search WHERE section_id IN (SELECT id FROM sections WHERE page_id = ?)"
      );
      const removePage = this.database.prepare("DELETE FROM pages WHERE id = ?");
      for (const { id } of stale) {
        removeSearch.run(id);
        removePage.run(id);
      }
      this.database.exec("COMMIT");
      return stale.length;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getStatus(sourceId: string): {
    pageCount: number;
    sectionCount: number;
    lastIndexedAt?: string;
    locales: Record<string, number>;
  } {
    const row = this.database.prepare(`
      SELECT COUNT(DISTINCT pages.id) AS page_count,
             COUNT(sections.id) AS section_count,
             MAX(pages.indexed_at) AS last_indexed_at
      FROM pages LEFT JOIN sections ON sections.page_id = pages.id
      WHERE pages.source_id = ?
    `).get(sourceId) as { page_count: number; section_count: number; last_indexed_at: string | null };
    const localeRows = this.database.prepare(`
      SELECT page_locale(url) AS locale, COUNT(*) AS page_count
      FROM pages WHERE source_id = ?
      GROUP BY page_locale(url) ORDER BY locale
    `).all(sourceId) as Array<{ locale: string; page_count: number }>;
    return {
      pageCount: row.page_count,
      sectionCount: row.section_count,
      ...(row.last_indexed_at ? { lastIndexedAt: row.last_indexed_at } : {}),
      locales: Object.fromEntries(localeRows.map((localeRow) => [localeRow.locale, localeRow.page_count]))
    };
  }

  listPages(sourceId: string, limit: number, pathPrefix?: string, locale = "all"): Array<{
    url: string;
    locale: string;
    title: string;
    sectionCount: number;
    indexedAt: string;
  }> {
    const prefix = pathPrefix?.trim();
    const filters = ["pages.source_id = ?"];
    const values: Array<string | number> = [sourceId];
    if (prefix) {
      filters.push("instr(pages.url, ?) > 0");
      values.push(prefix);
    }
    if (locale !== "all") {
      filters.push("page_locale(pages.url) = ?");
      values.push(locale);
    }
    values.push(limit);
    const sql = `
      SELECT pages.url, pages.title, pages.indexed_at, COUNT(sections.id) AS section_count
      FROM pages LEFT JOIN sections ON sections.page_id = pages.id
      WHERE ${filters.join(" AND ")}
      GROUP BY pages.id
      ORDER BY pages.url
      LIMIT ?
    `;
    const rows = this.database.prepare(sql).all(...values) as Array<{
      url: string;
      title: string;
      indexed_at: string;
      section_count: number;
    }>;
    return rows.map((row) => ({
      url: row.url,
      locale: localeFromUrl(row.url),
      title: row.title,
      sectionCount: row.section_count,
      indexedAt: row.indexed_at
    }));
  }

  search(
    sourceId: string,
    query: string,
    limit: number,
    maxSnippetChars: number,
    urlContains?: string,
    locale = "all"
  ): SearchResult[] {
    const match = ftsQuery(query);
    const urlFilter = urlContains?.trim();
    let rows: SectionRow[];
    if (match) {
      const localeClause = locale === "all" ? "" : "AND page_locale(section_search.url) = ?";
      const sql = `
        SELECT section_search.url,
               section_search.page_title,
               pages.document_title,
               sections.position,
               sections.heading,
               sections.level,
               sections.anchor,
               sections.body
        FROM section_search
        JOIN sections ON sections.id = CAST(section_search.section_id AS INTEGER)
        JOIN pages ON pages.id = sections.page_id
        WHERE section_search MATCH ? AND section_search.source_id = ?
          ${urlFilter ? "AND instr(section_search.url, ?) > 0" : ""}
          ${localeClause}
        ORDER BY bm25(section_search, 0.0, 0.0, 0.0, 4.0, 2.0, 1.0)
        LIMIT ?
      `;
      const values: Array<string | number> = [match, sourceId];
      if (urlFilter) values.push(urlFilter);
      if (locale !== "all") values.push(locale);
      values.push(limit);
      rows = this.database.prepare(sql).all(...values) as SectionRow[];
    } else {
      const like = `%${query.trim()}%`;
      const localeClause = locale === "all" ? "" : "AND page_locale(pages.url) = ?";
      const sql = `
        SELECT pages.url,
               pages.title AS page_title,
               pages.document_title,
               sections.position,
               sections.heading,
               sections.level,
               sections.anchor,
               sections.body
        FROM sections JOIN pages ON pages.id = sections.page_id
        WHERE pages.source_id = ?
          ${urlFilter ? "AND instr(pages.url, ?) > 0" : ""}
          ${localeClause}
          AND (pages.title LIKE ? OR sections.heading LIKE ? OR sections.body LIKE ?)
        ORDER BY CASE WHEN sections.heading LIKE ? THEN 0 WHEN pages.title LIKE ? THEN 1 ELSE 2 END,
                 pages.url,
                 sections.position
        LIMIT ?
      `;
      const values: Array<string | number> = [sourceId];
      if (urlFilter) values.push(urlFilter);
      if (locale !== "all") values.push(locale);
      values.push(like, like, like, like, like, limit);
      rows = this.database.prepare(sql).all(...values) as SectionRow[];
    }
    return rows.map((row) => ({
      url: row.url,
      locale: localeFromUrl(row.url),
      title: row.page_title,
      heading: row.heading,
      level: row.level,
      ...(row.anchor ? { anchor: row.anchor } : {}),
      snippet: snippet(row.body, query, maxSnippetChars)
    }));
  }

  getPageContent(sourceId: string, url: string, heading: string | undefined, maxChars: number): {
    url: string;
    locale: string;
    title: string;
    documentTitle: string;
    headings: Array<{ heading: string; level: number; anchor?: string }>;
    content: string;
    truncated: boolean;
  } | undefined {
    const rows = this.database.prepare(`
      SELECT pages.url,
             pages.title AS page_title,
             pages.document_title,
             sections.position,
             sections.heading,
             sections.level,
             sections.anchor,
             sections.body
      FROM pages JOIN sections ON sections.page_id = pages.id
      WHERE pages.source_id = ? AND pages.url = ?
      ORDER BY sections.position
    `).all(sourceId, url) as SectionRow[];
    if (rows.length === 0) return undefined;

    const selected = heading
      ? rows.filter((row) => row.heading.toLocaleLowerCase() === heading.toLocaleLowerCase() || row.anchor === heading)
      : rows;
    if (selected.length === 0) return undefined;
    const first = rows[0]!;
    const fullContent = selected.map((row) => `${"#".repeat(Math.max(1, row.level))} ${row.heading}\n${row.body}`.trim()).join("\n\n");
    return {
      url: first.url,
      locale: localeFromUrl(first.url),
      title: first.page_title,
      documentTitle: first.document_title,
      headings: (heading ? selected : rows).map((row) => ({
        heading: row.heading,
        level: row.level,
        ...(row.anchor ? { anchor: row.anchor } : {})
      })),
      content: fullContent.slice(0, maxChars),
      truncated: fullContent.length > maxChars
    };
  }
}
