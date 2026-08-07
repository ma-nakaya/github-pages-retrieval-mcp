import { access, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const copilotManifest = JSON.parse(await readFile(resolve(root, "plugin.json"), "utf8"));
const claudeManifest = JSON.parse(
  await readFile(resolve(root, ".claude-plugin/plugin.json"), "utf8")
);

for (const manifest of [copilotManifest, claudeManifest]) {
  for (const field of ["name", "version", "description", "skills", "mcpServers"]) {
    if (typeof manifest[field] !== "string" || !manifest[field]) {
      throw new Error(`plugin.json requires a non-empty ${field}.`);
    }
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(manifest.name)) {
    throw new Error("plugin.json name must be kebab-case.");
  }
}

await access(resolve(root, copilotManifest.skills));
await access(resolve(root, copilotManifest.mcpServers));
await access(resolve(root, claudeManifest.skills));
await access(resolve(root, claudeManifest.mcpServers));

const skillRoots = new Set([copilotManifest.skills, claudeManifest.skills]);
let skillCount = 0;
for (const skillRoot of skillRoots) {
  const directories = (await readdir(resolve(root, skillRoot), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory());
  for (const directory of directories) {
    await access(resolve(root, skillRoot, directory.name, "SKILL.md"));
    skillCount += 1;
  }
}
if (skillCount === 0) throw new Error("The plugin must include at least one skill.");

for (const path of [".claude-plugin/marketplace.json", ".github/plugin/marketplace.json"]) {
  const marketplace = JSON.parse(await readFile(resolve(root, path), "utf8"));
  if (!Array.isArray(marketplace.plugins) || marketplace.plugins[0]?.source !== ".") {
    throw new Error(`${path} must expose this repository as a plugin source.`);
  }
}

const claudeMcp = JSON.parse(await readFile(resolve(root, ".mcp.json"), "utf8"));
const copilotMcp = JSON.parse(await readFile(resolve(root, "mcp/copilot.json"), "utf8"));
if (!claudeMcp.mcpServers?.["github-pages-retrieval"]?.command) {
  throw new Error("Claude .mcp.json must define github-pages-retrieval.");
}
if (!copilotMcp.mcpServers?.["github-pages-retrieval"]?.command) {
  throw new Error("Copilot MCP config must define github-pages-retrieval.");
}
