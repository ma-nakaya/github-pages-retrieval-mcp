import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { isMissingFile, readJsonFile, writeJsonFile } from "./json-file.js";
import { ALL_SOURCES_ID } from "./source-id.js";

const sourceIdSchema = z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/);

const sourceSchema = z.object({
  id: sourceIdSchema,
  startUrl: z.string().url(),
  authProbeUrl: z.string().url().optional(),
  allowedOrigins: z.array(z.string().url()).min(1),
  profileDir: z.string().min(1)
});

const configSchema = z.object({
  stateDir: z.string().min(1).default(".data"),
  sources: z.array(sourceSchema).min(1)
});

export type SourceConfig = z.infer<typeof sourceSchema>;
export type AppConfig = z.infer<typeof configSchema>;

export type SourceSummary = Pick<SourceConfig, "id" | "startUrl" | "authProbeUrl" | "allowedOrigins">;

function configPath(): string {
  return resolve(process.env.GPR_CONFIG_PATH ?? "config.local.json");
}

function resolvedConfig(parsed: AppConfig, path: string): AppConfig {
  return {
    ...parsed,
    stateDir: resolve(dirname(path), parsed.stateDir),
    sources: parsed.sources.map((source) => ({
      ...source,
      profileDir: resolve(dirname(path), source.profileDir)
    }))
  };
}

function configurationError(path: string, error: unknown): Error {
  const reason = error instanceof Error ? error.message : "unknown error";
  return new Error(`Unable to load ${path}: ${reason}`);
}

async function readStoredConfig(path: string): Promise<AppConfig> {
  return configSchema.parse(await readJsonFile(path));
}

export async function loadConfig(): Promise<AppConfig> {
  const path = configPath();
  try {
    return resolvedConfig(await readStoredConfig(path), path);
  } catch (error) {
    throw configurationError(path, error);
  }
}

export async function loadConfigIfPresent(): Promise<AppConfig | undefined> {
  const path = configPath();
  try {
    return resolvedConfig(await readStoredConfig(path), path);
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw configurationError(path, error);
  }
}

function normalizedStartUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("A Pages source URL must use HTTPS.");
  if (url.username || url.password) throw new Error("A Pages source URL must not contain credentials.");
  url.hash = "";
  return url;
}

function generatedSourceId(url: URL): string {
  const labels = url.hostname.toLocaleLowerCase().split(".");
  const hostname = labels.slice(-3).join(".") === "pages.github.io" || labels.slice(-2).join(".") === "github.io"
    ? labels[0] ?? "pages"
    : url.hostname;
  return hostname
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "") || "pages";
}

function summary(source: SourceConfig): SourceSummary {
  return {
    id: source.id,
    startUrl: source.startUrl,
    ...(source.authProbeUrl ? { authProbeUrl: source.authProbeUrl } : {}),
    allowedOrigins: source.allowedOrigins
  };
}

export async function configureSource(startUrl: string, requestedSourceId?: string): Promise<{
  created: boolean;
  source: SourceSummary;
}> {
  const path = configPath();
  const url = normalizedStartUrl(startUrl);
  let stored: AppConfig | undefined;
  try {
    stored = await readStoredConfig(path);
  } catch (error) {
    if (!isMissingFile(error)) throw configurationError(path, error);
  }

  const existing = stored?.sources.find((source) => isAllowedUrl(source, url));
  if (existing) return { created: false, source: summary(existing) };

  const baseId = requestedSourceId ? sourceIdSchema.parse(requestedSourceId) : generatedSourceId(url);
  const usedIds = new Set(stored?.sources.map((source) => source.id) ?? []);
  if (baseId === ALL_SOURCES_ID) throw new Error(`Source id is reserved for cross-site search: ${ALL_SOURCES_ID}`);
  if (requestedSourceId && usedIds.has(baseId)) throw new Error(`Source id is already configured: ${baseId}`);
  let sourceId = baseId;
  if (!requestedSourceId) {
    for (let suffix = 2; usedIds.has(sourceId); suffix += 1) sourceId = `${baseId}-${suffix}`;
  }

  const stateDir = stored?.stateDir ?? ".data";
  const source = sourceSchema.parse({
    id: sourceId,
    startUrl: url.toString(),
    authProbeUrl: url.toString(),
    allowedOrigins: [url.origin],
    profileDir: join(stateDir, "browser-profiles", sourceId)
  });
  const next = configSchema.parse({ stateDir, sources: [...(stored?.sources ?? []), source] });
  await writeJsonFile(path, next);
  return { created: true, source: summary(source) };
}

export function findSource(config: AppConfig, sourceId: string): SourceConfig {
  const source = config.sources.find((candidate) => candidate.id === sourceId);
  if (!source) {
    throw new Error(`Unknown source: ${sourceId}`);
  }
  return source;
}

export function assertAllowedUrl(source: SourceConfig, value: string): URL {
  const url = new URL(value);
  if (!isAllowedUrl(source, url)) {
    throw new Error(`URL origin is not allowlisted for ${source.id}: ${url.origin}`);
  }
  return url;
}

export function isAllowedUrl(source: SourceConfig, value: string | URL): boolean {
  try {
    const origin = (value instanceof URL ? value : new URL(value)).origin;
    return source.allowedOrigins.some((allowed) => new URL(allowed).origin === origin);
  } catch {
    return false;
  }
}
