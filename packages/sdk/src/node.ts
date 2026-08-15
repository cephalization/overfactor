import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type DaemonInfo,
  daemonInfoSchema,
  type OverfactorConfig,
  overfactorConfigSchema,
} from "./index.ts";

/**
 * Node-only helpers: locating the Overfactor home directory and discovering a
 * running daemon. Kept out of the root export so browser/renderer consumers
 * never pull in `node:` modules.
 */

/** `~/.overfactor`, overridable via `OVERFACTOR_DIR` (used by tests). */
export function overfactorDir(): string {
  return process.env.OVERFACTOR_DIR ?? join(homedir(), ".overfactor");
}

export function daemonInfoPath(): string {
  return join(overfactorDir(), "daemon.json");
}

export function configPath(): string {
  return join(overfactorDir(), "config.json");
}

/**
 * Reads and validates `daemon.json`. Returns null when missing or invalid —
 * the file is only trustworthy as a hint; callers confirm liveness against
 * `GET /health` before relying on it.
 */
export async function readDaemonInfo(): Promise<DaemonInfo | null> {
  try {
    const raw = await readFile(daemonInfoPath(), "utf8");
    return daemonInfoSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Reads and validates `config.json`; missing file yields the empty config. */
export async function readOverfactorConfig(): Promise<OverfactorConfig> {
  try {
    const raw = await readFile(configPath(), "utf8");
    return overfactorConfigSchema.parse(JSON.parse(raw));
  } catch {
    return overfactorConfigSchema.parse({});
  }
}

export function daemonBaseUrl(info: DaemonInfo): string {
  return `http://127.0.0.1:${info.port}`;
}
