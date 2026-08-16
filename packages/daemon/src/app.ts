import { readFile } from "node:fs/promises";
import { zValidator } from "@hono/zod-validator";
import { parseClaudeTranscript } from "@overfactor/integration-claude-code/transcript";
import { parsePiTranscript } from "@overfactor/integration-pi/transcript";
import type { AgentKind, HookEvent, TranscriptEntry } from "@overfactor/sdk";
import { hookEventSchema, repoPathRequestSchema } from "@overfactor/sdk";
import { z } from "zod";
import { readOverfactorConfig } from "@overfactor/sdk/node";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { sep } from "node:path";
import { computeDiffPatch } from "./diff.ts";
import { addRepo, removeRepo } from "./repos.ts";
import type { SessionStore } from "./store.ts";

export const DAEMON_VERSION = "0.0.0";

const TRANSCRIPT_TAIL_LENGTH = 200;

const TRANSCRIPT_PARSERS: Record<AgentKind, (content: string) => TranscriptEntry[]> = {
  "claude-code": parseClaudeTranscript,
  pi: parsePiTranscript,
};

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
  /**
   * Maps an event cwd to its tracked repo (or null to drop the event).
   * The server's resolver also maps linked `git worktree` checkouts — whose
   * paths live outside the tracked repo root — back to the tracked repo.
   */
  resolveRepo: (cwd: string) => Promise<string | null>;
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
      .get("/crs", (c) => c.json(deps.store.listChangeRequests()))
      // Manual rename: wins over agent-generated and prompt-derived titles.
      .post(
        "/sessions/:id/title",
        zValidator("json", z.object({ title: z.string().trim().min(1).max(200) })),
        (c) => {
          const renamed = deps.store.renameSession(c.req.param("id"), c.req.valid("json").title);
          if (!renamed) return c.json({ error: "unknown-session" as const }, 404);
          return c.json({ ok: true as const });
        },
      )
      // Manual pin: overrides automatic branch grouping; null clears the pin.
      .post(
        "/sessions/:id/cr",
        zValidator("json", z.object({ crId: z.int().positive().nullable() })),
        (c) => {
          const pinned = deps.store.pinSession(c.req.param("id"), c.req.valid("json").crId);
          if (!pinned) return c.json({ error: "unknown-session" as const }, 404);
          return c.json({ ok: true as const });
        },
      )
      // Transcript tail, parsed on demand from the agent's own transcript
      // file by the agent's integration package.
      .get("/sessions/:id/transcript", async (c) => {
        const session = deps.store.get(c.req.param("id"));
        if (session === null) {
          return c.json({ error: "unknown-session" as const }, 404);
        }
        if (session.transcriptPath === null) {
          return c.json({ entries: [] as TranscriptEntry[], totalCount: 0 });
        }
        const raw = await readFile(session.transcriptPath, "utf8").catch(() => null);
        if (raw === null) {
          return c.json({ entries: [] as TranscriptEntry[], totalCount: 0 });
        }
        const entries = TRANSCRIPT_PARSERS[session.agent](raw);
        return c.json({
          entries: entries.slice(-TRANSCRIPT_TAIL_LENGTH),
          totalCount: entries.length,
        });
      })
      // Full patch, computed on demand — never persisted. Scope matches the
      // stats: staged + unstaged vs HEAD of the session's worktree.
      .get("/sessions/:id/diff", async (c) => {
        const session = deps.store.get(c.req.param("id"));
        if (session === null) {
          return c.json({ error: "unknown-session" as const }, 404);
        }
        return c.json({ patch: await computeDiffPatch(session.cwd) });
      })
      .post("/events", zValidator("json", hookEventSchema), async (c) => {
        const event = c.req.valid("json");
        const repoPath = await deps.resolveRepo(event.cwd);
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
