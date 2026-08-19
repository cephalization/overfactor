import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type ConversationMessage,
  conversationInboxResponseSchema,
  type ConversationMessageAck,
  conversationMessageAckResponseSchema,
  conversationMessageAckSchema,
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

/** Shared validated writer for `~/.overfactor/config.json`. */
export async function writeOverfactorConfig(config: OverfactorConfig): Promise<void> {
  const validated = overfactorConfigSchema.parse(config);
  await mkdir(overfactorDir(), { recursive: true });
  await writeFile(configPath(), `${JSON.stringify(validated, null, 2)}\n`, "utf8");
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

export interface ConversationInboxDependencies {
  readDaemonInfo?: typeof readDaemonInfo;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Polls the daemon for the next app-authored message for an agent session.
 * Missing discovery and unknown/stale sessions are normal and return null.
 */
export async function readConversationMessage(
  sessionId: string,
  dependencies?: ConversationInboxDependencies,
): Promise<ConversationMessage | null> {
  const info = await (dependencies?.readDaemonInfo ?? readDaemonInfo)();
  if (info === null) return null;
  const response = await (dependencies?.fetch ?? fetch)(
    `${daemonBaseUrl(info)}/sessions/${encodeURIComponent(sessionId)}/messages/next`,
    { signal: AbortSignal.timeout(dependencies?.timeoutMs ?? DEFAULT_POST_TIMEOUT_MS) },
  );
  if (response.status === 404 || response.status === 409) return null;
  if (!response.ok) throw new Error(`conversation poll failed (${response.status})`);
  return conversationInboxResponseSchema.parse(await response.json()).message;
}

/** Acknowledges a message only after the integration accepted it for delivery. */
export async function acknowledgeConversationMessage(
  sessionId: string,
  acknowledgement: ConversationMessageAck,
  dependencies?: ConversationInboxDependencies,
): Promise<boolean> {
  const validated = conversationMessageAckSchema.parse(acknowledgement);
  const info = await (dependencies?.readDaemonInfo ?? readDaemonInfo)();
  if (info === null) return false;
  const response = await (dependencies?.fetch ?? fetch)(
    `${daemonBaseUrl(info)}/sessions/${encodeURIComponent(sessionId)}/messages/ack`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validated),
      signal: AbortSignal.timeout(dependencies?.timeoutMs ?? DEFAULT_POST_TIMEOUT_MS),
    },
  );
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`conversation acknowledgement failed (${response.status})`);
  conversationMessageAckResponseSchema.parse(await response.json());
  return true;
}
