import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type AuthState = {
  status: "unknown" | "ready" | "auth_required";
  checkedAt: string;
  reason?: string;
};

type StateFile = Record<string, AuthState>;

function statePath(stateDir: string): string {
  return join(stateDir, "auth-state.json");
}

export async function readAuthState(stateDir: string, sourceId: string): Promise<AuthState> {
  try {
    const raw = await readFile(statePath(stateDir), "utf8");
    const states = JSON.parse(raw) as StateFile;
    return states[sourceId] ?? { status: "unknown", checkedAt: new Date(0).toISOString() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "unknown", checkedAt: new Date(0).toISOString() };
    }
    throw error;
  }
}

export async function writeAuthState(stateDir: string, sourceId: string, state: AuthState): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  let states: StateFile = {};
  try {
    states = JSON.parse(await readFile(statePath(stateDir), "utf8")) as StateFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  states[sourceId] = state;
  await writeFile(statePath(stateDir), `${JSON.stringify(states, null, 2)}\n`, { mode: 0o600 });
}
