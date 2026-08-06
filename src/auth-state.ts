import { join } from "node:path";
import { isMissingFile, readJsonFile, writeJsonFile } from "./json-file.js";

export type AuthState = {
  status: "unknown" | "ready" | "auth_required";
  checkedAt: string;
  reason?: string;
};

type StateFile = Record<string, AuthState>;
const unknownCheckedAt = new Date(0).toISOString();
let pendingWrite = Promise.resolve();

function statePath(stateDir: string): string {
  return join(stateDir, "auth-state.json");
}

export async function readAuthState(stateDir: string, sourceId: string): Promise<AuthState> {
  const states = await readStateFile(stateDir);
  return states[sourceId] ?? { status: "unknown", checkedAt: unknownCheckedAt };
}

async function readStateFile(stateDir: string): Promise<StateFile> {
  try {
    return await readJsonFile<StateFile>(statePath(stateDir));
  } catch (error) {
    if (isMissingFile(error)) return {};
    throw error;
  }
}

export async function writeAuthState(stateDir: string, sourceId: string, state: AuthState): Promise<void> {
  // Serialize read-modify-write operations so parallel source refreshes cannot lose state.
  const operation = pendingWrite.then(async () => {
    const states = await readStateFile(stateDir);
    states[sourceId] = state;
    await writeJsonFile(statePath(stateDir), states);
  });
  pendingWrite = operation.catch(() => undefined);
  await operation;
}
