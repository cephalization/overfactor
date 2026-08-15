import { hc } from "hono/client";
import type { AppType } from "./app.ts";

export type { AppType } from "./app.ts";

/**
 * Typed RPC client for the daemon's HTTP API (hono/client). Runs anywhere
 * fetch does — this entry pulls in no Node-only or server code.
 */
export function createDaemonClient(baseUrl: string): ReturnType<typeof hc<AppType>> {
  return hc<AppType>(baseUrl);
}

export type DaemonClient = ReturnType<typeof createDaemonClient>;
