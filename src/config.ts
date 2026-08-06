import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";

const sourceSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/),
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

export async function loadConfig(): Promise<AppConfig> {
  const configPath = process.env.GPR_CONFIG_PATH ?? "config.local.json";
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = configSchema.parse(JSON.parse(raw));
    return {
      ...parsed,
      stateDir: resolve(dirname(configPath), parsed.stateDir),
      sources: parsed.sources.map((source) => ({
        ...source,
        profileDir: resolve(dirname(configPath), source.profileDir)
      }))
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    throw new Error(`Unable to load ${configPath}: ${reason}`);
  }
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
  const allowed = source.allowedOrigins.some((origin) => new URL(origin).origin === url.origin);
  if (!allowed) {
    throw new Error(`URL origin is not allowlisted for ${source.id}: ${url.origin}`);
  }
  return url;
}
