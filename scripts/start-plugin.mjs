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
const isWindows = process.platform === "win32";

function runSetup(commandName, args) {
  const result = spawnSync(commandName, args, {
    cwd: pluginRoot,
    env: process.env,
    encoding: "utf8",
    shell: isWindows && commandName.endsWith(".cmd"),
    stdio: ["ignore", "pipe", "pipe"]
  });

  // Keep setup logs off the JSON-RPC stdout channel.
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!existsSync(join(pluginRoot, "node_modules", "tsx", "package.json"))) {
  const npm = isWindows ? "npm.cmd" : "npm";
  runSetup(npm, ["ci"]);
}

const { chromium } = await import("playwright");
if (!existsSync(chromium.executablePath())) {
  runSetup(process.execPath, [join(pluginRoot, "node_modules", "playwright", "cli.js"), "install", "chromium"]);
}

const child = spawn(process.execPath, [join(pluginRoot, "node_modules", "tsx", "dist", "cli.mjs"), "src/index.ts"], {
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
