import type { HookEvent } from "@overfactor/sdk";
import { postHookEvent, readDaemonInfo } from "@overfactor/sdk/node";

const POST_TIMEOUT_MS = 1500;

/**
 * Upper bound on how long Pi's shutdown may wait for queued events. Pi awaits
 * `session_shutdown` handlers with no timeout of its own, so without this cap
 * a backlog of POSTs against a wedged daemon stalls quit for its full length.
 */
export const SHUTDOWN_FLUSH_TIMEOUT_MS = 500;

export interface HookEventSink {
  send(event: HookEvent): Promise<void>;
}

export interface TransportDependencies {
  readDaemonInfo: typeof readDaemonInfo;
  fetch: typeof fetch;
}

const defaultDependencies: TransportDependencies = {
  readDaemonInfo,
  fetch,
};

/**
 * Creates an ordered, failure-isolated sender for Pi's long-lived process.
 * Events must never delay or break the agent because Overfactor is optional.
 */
export function createHookEventSink(
  dependencies: TransportDependencies = defaultDependencies,
): HookEventSink {
  let tail = Promise.resolve();

  async function deliver(event: HookEvent): Promise<void> {
    try {
      await postHookEvent(event, {
        readDaemonInfo: dependencies.readDaemonInfo,
        fetch: dependencies.fetch,
        timeoutMs: POST_TIMEOUT_MS,
      });
    } catch (error) {
      // The integration is observational: daemon absence, stale discovery,
      // and network failures must never affect Pi. But a swallowed
      // schema/contract error makes the integration an undebuggable no-op,
      // so surface everything when explicitly asked.
      if (process.env.OVERFACTOR_DEBUG !== undefined) {
        console.error("[overfactor] hook event delivery failed:", error);
      }
    }
  }

  return {
    send(event) {
      tail = tail.then(
        () => deliver(event),
        () => deliver(event),
      );
      return tail;
    },
  };
}
