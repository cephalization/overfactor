import type { DiffStats, HookEvent, LifecycleState, Session } from "@overfactor/sdk";
import { sessionSchema } from "@overfactor/sdk";
import { eq } from "drizzle-orm";
import Emittery from "emittery";
import { type Db, type SessionRow, sessions } from "./db.ts";

const TITLE_MAX_LENGTH = 80;

function titleFromPrompt(prompt: string): string | null {
  const firstLine = prompt.split("\n", 1)[0]?.trim() ?? "";
  if (firstLine.length === 0) return null;
  if (firstLine.length <= TITLE_MAX_LENGTH) return firstLine;
  return `${firstLine.slice(0, TITLE_MAX_LENGTH - 1)}…`;
}

function rowToSession(row: SessionRow): Session {
  return sessionSchema.parse({
    id: row.id,
    agent: row.agent,
    title: row.title,
    state: row.state,
    cwd: row.cwd,
    repoPath: row.repoPath,
    transcriptPath: row.transcriptPath,
    diff:
      row.filesChanged === null || row.insertions === null || row.deletions === null
        ? null
        : {
            filesChanged: row.filesChanged,
            insertions: row.insertions,
            deletions: row.deletions,
          },
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
  });
}

/**
 * Session state, persisted in sqlite so sessions survive daemon restarts.
 * Emits `changed` after every mutation; the server broadcasts WS invalidations
 * off that signal.
 */
export class SessionStore {
  readonly events = new Emittery<{ changed: undefined }>();

  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Applies a validated hook event; `repoPath` is the configured repo containing the event's cwd. */
  applyEvent(event: HookEvent, repoPath: string): void {
    const timestamp = this.now().toISOString();
    const existing = this.db.select().from(sessions).where(eq(sessions.id, event.sessionId)).get();

    const state: LifecycleState =
      event.type === "stopped"
        ? "idle"
        : event.type === "attention"
          ? "blocked"
          : event.type === "session-end"
            ? "ended"
            : "working";

    if (existing === undefined) {
      this.db
        .insert(sessions)
        .values({
          id: event.sessionId,
          agent: event.agent,
          title: event.type === "user-prompt" ? titleFromPrompt(event.prompt) : null,
          state,
          cwd: event.cwd,
          repoPath,
          transcriptPath: event.type === "session-start" ? event.transcriptPath : null,
          startedAt: timestamp,
          updatedAt: timestamp,
        })
        .run();
    } else {
      this.db
        .update(sessions)
        .set({
          state,
          cwd: event.cwd,
          repoPath,
          updatedAt: timestamp,
          ...(event.type === "user-prompt" && existing.title === null
            ? { title: titleFromPrompt(event.prompt) }
            : {}),
          ...(event.type === "session-start" ? { transcriptPath: event.transcriptPath } : {}),
        })
        .where(eq(sessions.id, event.sessionId))
        .run();
    }

    void this.events.emit("changed");
  }

  /**
   * Records diff stats for every session running in `cwd` (they share a
   * worktree). A recompute that lands on identical stats is a no-op — no
   * `updatedAt` churn and no WS invalidation for noise events (e.g. files the
   * ignore matcher doesn't know about, like global-gitignore entries).
   */
  setDiffForCwd(cwd: string, stats: DiffStats): void {
    const rows = this.db.select().from(sessions).where(eq(sessions.cwd, cwd)).all();
    const changed = rows.some(
      (row) =>
        row.filesChanged !== stats.filesChanged ||
        row.insertions !== stats.insertions ||
        row.deletions !== stats.deletions,
    );
    if (!changed) return;

    const timestamp = this.now().toISOString();
    this.db
      .update(sessions)
      .set({
        filesChanged: stats.filesChanged,
        insertions: stats.insertions,
        deletions: stats.deletions,
        updatedAt: timestamp,
      })
      .where(eq(sessions.cwd, cwd))
      .run();
    void this.events.emit("changed");
  }

  list(): Session[] {
    return this.db.select().from(sessions).all().map(rowToSession);
  }

  /** Distinct cwds of sessions that are still live (not ended), optionally scoped to one repo. */
  liveCwds(repoPath?: string): string[] {
    const rows = this.db.select().from(sessions).all();
    const cwds = new Set<string>();
    for (const row of rows) {
      if (row.state === "ended") continue;
      if (repoPath !== undefined && row.repoPath !== repoPath) continue;
      cwds.add(row.cwd);
    }
    return [...cwds];
  }
}
