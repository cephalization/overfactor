import { zValidator } from "@hono/zod-validator";
import type { HookEvent } from "@overfactor/sdk";
import { hookEventSchema, repoPathRequestSchema } from "@overfactor/sdk";
import { readOverfactorConfig } from "@overfactor/sdk/node";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { sep } from "node:path";
import { addRepo, removeRepo } from "./repos.ts";
import type { SessionStore } from "./store.ts";

export const DAEMON_VERSION = "0.0.0";

/** True when `cwd` is `repo` or a directory inside it. */
export function cwdInRepo(cwd: string, repo: string): boolean {
  return cwd === repo || cwd.startsWith(repo.endsWith(sep) ? repo : repo + sep);
}

/** Longest configured repo path containing `cwd`, or null when unconfigured. */
export function resolveRepoForCwd(repos: string[], cwd: string): string | null {
  let best: string | null = null;
  for (const repo of repos) {
    if (cwdInRepo(cwd, repo) && (best === null || repo.length > best.length)) {
      best = repo;
    }
  }
  return best;
}

export interface AppDeps {
  store: SessionStore;
  /** Current configured repos; read per-request so config reloads apply live. */
  repos: () => string[];
  /** Called after an event is accepted (diff recompute scheduling). */
  onEvent?: (event: HookEvent, repoPath: string) => void;
  /** Called when an event is dropped because its cwd is in no tracked repo. */
  onDrop?: (event: HookEvent) => void;
}

/**
 * Browser-context clients of the loopback daemon: the electron-vite dev
 * server origin and the packaged app's file:// pages ("null" origin).
 * Non-browser clients (hook shim, CLI, curl) send no Origin and bypass CORS.
 * The daemon only ever binds 127.0.0.1.
 */
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function createApp(deps: AppDeps) {
  return (
    new Hono()
      .use(
        "*",
        cors({
          origin: (origin) => (origin === "null" || LOCAL_ORIGIN.test(origin) ? origin : null),
        }),
      )
      .get("/health", (c) =>
        c.json({ ok: true as const, version: DAEMON_VERSION, pid: process.pid }),
      )
      .get("/sessions", (c) => c.json(deps.store.list()))
      .post("/events", zValidator("json", hookEventSchema), (c) => {
        const event = c.req.valid("json");
        const repoPath = resolveRepoForCwd(deps.repos(), event.cwd);
        if (repoPath === null) {
          deps.onDrop?.(event);
          return c.json({ accepted: false as const, reason: "unconfigured-repo" as const }, 202);
        }
        deps.store.applyEvent(event, repoPath);
        deps.onEvent?.(event, repoPath);
        return c.json({ accepted: true as const, reason: null }, 202);
      })
      // Repo routes read/write config.json directly so responses are always
      // fresh; the server's file watcher propagates changes into the running
      // config and broadcasts the WS invalidation.
      .get("/repos", async (c) => c.json(await readOverfactorConfig()))
      .post("/repos", zValidator("json", repoPathRequestSchema), async (c) => {
        const result = await addRepo(c.req.valid("json").path);
        if (!result.ok) {
          return c.json({ ok: false as const, reason: result.reason }, 400);
        }
        return c.json({ ok: true as const, repos: result.repos });
      })
      .delete("/repos", zValidator("json", repoPathRequestSchema), async (c) =>
        c.json(await removeRepo(c.req.valid("json").path)),
      )
  );
}

export type App = ReturnType<typeof createApp>;
export type AppType = App;
