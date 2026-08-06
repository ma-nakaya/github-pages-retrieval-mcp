import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pluginData =
  process.env.GPR_PLUGIN_DATA ??
  process.env.CLAUDE_PLUGIN_DATA ??
  process.env.PLUGIN_DATA ??
  join(pluginRoot, ".data");
const command = process.platform === "win32" ? "npx.cmd" : "npx";

if (!existsSync(join(pluginRoot, "node_modules", "tsx", "package.json"))) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const install = spawnSync(npm, ["ci"], {
    cwd: pluginRoot,
    env: process.env,
    stdio: "inherit"
  });

  if (install.error) throw install.error;
  if (install.status !== 0) {
    process.exit(install.status ?? 1);
  }
}

const child = spawn(command, ["tsx", "src/index.ts"], {
  cwd: pluginRoot,
  env: {
    ...process.env,
    GPR_CONFIG_PATH: process.env.GPR_CONFIG_PATH ?? join(pluginData, "config.local.json")
  },
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
