import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type DaemonInfo,
  daemonInfoSchema,
  type HookEvent,
  hookEventSchema,
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

export const DEFAULT_POST_TIMEOUT_MS = 1500;

export interface PostHookEventDependencies {
  readDaemonInfo?: typeof readDaemonInfo;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * The one wire contract for integrations: validate the event, discover the
 * daemon, POST with a bounded timeout. Returns "no-daemon" when discovery
 * finds nothing; throws on validation or network failure — callers own the
 * never-break-the-agent policy (catch/log/drop as appropriate).
 */
export async function postHookEvent(
  event: HookEvent,
  dependencies?: PostHookEventDependencies,
): Promise<"delivered" | "no-daemon"> {
  const validated = hookEventSchema.parse(event);
  const info = await (dependencies?.readDaemonInfo ?? readDaemonInfo)();
  if (info === null) return "no-daemon";
  await (dependencies?.fetch ?? fetch)(`${daemonBaseUrl(info)}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(validated),
    signal: AbortSignal.timeout(dependencies?.timeoutMs ?? DEFAULT_POST_TIMEOUT_MS),
  });
  return "delivered";
}
