import type {
  AgentKind,
  ChangeRequest,
  DiffStats,
  HookEvent,
  LifecycleState,
  Review,
  ReviewGroup,
  ReviewSubject,
  Session,
} from "@overfactor/sdk";
import {
  changeRequestSchema,
  reviewGroupSchema,
  reviewSchema,
  sessionSchema,
} from "@overfactor/sdk";
import { and, eq, type SQL } from "drizzle-orm";
import Emittery from "emittery";
import { z } from "zod";
import {
  type ChangeRequestRow,
  type Db,
  type ReviewRow,
  type SessionRow,
  changeRequests,
  reviews,
  sessions,
} from "./db.ts";

const TITLE_MAX_LENGTH = 80;

type SessionUpdate = Partial<typeof sessions.$inferInsert>;

function titleFromPrompt(prompt: string): string | null {
  const firstLine = prompt.split("\n", 1)[0]?.trim() ?? "";
  if (firstLine.length === 0) return null;
  if (firstLine.length <= TITLE_MAX_LENGTH) return firstLine;
  return `${firstLine.slice(0, TITLE_MAX_LENGTH - 1)}…`;
}

/** "feat/rate-limit_ingest-api" → "rate limit ingest api" (editable later). */
function titleFromBranch(branch: string): string {
  const leaf = branch.includes("/") ? branch.slice(branch.indexOf("/") + 1) : branch;
  const humanized = leaf.replaceAll(/[-_]+/g, " ").trim();
  return humanized === "" ? branch : humanized;
}

function rowToSession(row: SessionRow, effectiveCrId: number | null): Session {
  return sessionSchema.parse({
    id: row.id,
    agent: row.agent,
    model: row.model,
    title: row.title,
    state: row.state,
    cwd: row.cwd,
    repoPath: row.repoPath,
    transcriptPath: row.transcriptPath,
    branch: row.branch,
    crId: effectiveCrId,
    archived: row.archived,
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

function reviewSubjectClause(subject: ReviewSubject): SQL {
  // SAFETY: `and` of two eq clauses is never undefined.
  return and(eq(reviews.repoPath, subject.repoPath), eq(reviews.branch, subject.branch)) as SQL;
}

const storedGroupsSchema = z.array(reviewGroupSchema);
const storedReviewedSchema = z.array(z.string());

function rowToReview(row: ReviewRow): Review {
  return reviewSchema.parse({
    id: row.id,
    repoPath: row.repoPath,
    branch: row.branch,
    status: row.status,
    engine: row.engine,
    provider: row.provider,
    model: row.model,
    diffHash: row.diffHash,
    groups: storedGroupsSchema.parse(JSON.parse(row.groups)),
    reviewedGroups: storedReviewedSchema.parse(JSON.parse(row.reviewedGroups)),
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function rowToChangeRequest(row: ChangeRequestRow): ChangeRequest {
  return changeRequestSchema.parse({
    id: row.id,
    repoPath: row.repoPath,
    branch: row.branch,
    title: row.title,
    prNumber: row.prNumber,
    prState: row.prState,
    prUrl: row.prUrl,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

/**
 * Session state, persisted in sqlite so sessions survive daemon restarts.
 * Emits `changed` after every mutation; the server broadcasts WS invalidations
 * off that signal. `crsChanged` fires when the Change Request set mutates.
 */
export class SessionStore {
  readonly events = new Emittery<{
    changed: undefined;
    crsChanged: undefined;
    reviewsChanged: undefined;
  }>();

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

    const promptTitle = event.type === "user-prompt" ? titleFromPrompt(event.prompt) : null;
    if (existing === undefined) {
      this.db
        .insert(sessions)
        .values({
          id: event.sessionId,
          agent: event.agent,
          title: promptTitle,
          titleSource: promptTitle === null ? null : "prompt",
          state,
          cwd: event.cwd,
          repoPath,
          transcriptPath: event.type === "session-start" ? event.transcriptPath : null,
          startedAt: timestamp,
          updatedAt: timestamp,
        })
        .run();
    } else {
      const updates: SessionUpdate = {
        state,
        cwd: event.cwd,
        repoPath,
        updatedAt: timestamp,
      };
      if (promptTitle !== null && existing.title === null) {
        updates.title = promptTitle;
        updates.titleSource = "prompt";
      }
      if (event.type === "session-start") updates.transcriptPath = event.transcriptPath;
      this.db.update(sessions).set(updates).where(eq(sessions.id, event.sessionId)).run();
    }

    void this.events.emit("changed");
  }

  /**
   * Records worktree-derived state (diff stats, checked-out branch) for every
   * session running in `cwd` (they share a worktree). A recompute that lands
   * on identical values is a no-op — no `updatedAt` churn and no WS
   * invalidation for noise events. Null stats/branch mean "could not resolve":
   * the previous value is kept.
   */
  setWorktreeState(cwd: string, stats: DiffStats | null, branch: string | null): void {
    const rows = this.db.select().from(sessions).where(eq(sessions.cwd, cwd)).all();
    const statsChanged =
      stats !== null &&
      rows.some(
        (row) =>
          row.filesChanged !== stats.filesChanged ||
          row.insertions !== stats.insertions ||
          row.deletions !== stats.deletions,
      );
    const branchChanged = branch !== null && rows.some((row) => row.branch !== branch);
    if (!statsChanged && !branchChanged) return;

    const timestamp = this.now().toISOString();
    const updates: SessionUpdate = { updatedAt: timestamp };
    if (stats !== null) {
      updates.filesChanged = stats.filesChanged;
      updates.insertions = stats.insertions;
      updates.deletions = stats.deletions;
    }
    if (branch !== null) updates.branch = branch;
    this.db.update(sessions).set(updates).where(eq(sessions.cwd, cwd)).run();
    void this.events.emit("changed");
  }

  /**
   * Finds or creates the Change Request for a repo branch (the automatic
   * grouping unit). Title defaults to the humanized branch name.
   */
  ensureChangeRequest(repoPath: string, branch: string): ChangeRequest {
    const existing = this.db
      .select()
      .from(changeRequests)
      .where(and(eq(changeRequests.repoPath, repoPath), eq(changeRequests.branch, branch)))
      .get();
    if (existing !== undefined) return rowToChangeRequest(existing);

    const timestamp = this.now().toISOString();
    const inserted = this.db
      .insert(changeRequests)
      .values({
        repoPath,
        branch,
        title: titleFromBranch(branch),
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning()
      .get();
    void this.events.emit("crsChanged");
    return rowToChangeRequest(inserted);
  }

  listChangeRequests(): ChangeRequest[] {
    return this.db.select().from(changeRequests).all().map(rowToChangeRequest);
  }

  /** Pins a session to a CR (or clears the pin with null). Returns false for unknown sessions. */
  pinSession(sessionId: string, crId: number | null): boolean {
    const row = this.db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (row === undefined) return false;
    this.db
      .update(sessions)
      .set({ crId, updatedAt: this.now().toISOString() })
      .where(eq(sessions.id, sessionId))
      .run();
    void this.events.emit("changed");
    return true;
  }

  /** Archives or restores a session. Returns false for an unknown session. */
  setArchived(sessionId: string, archived: boolean): boolean {
    const row = this.db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (row === undefined) return false;
    if (row.archived === archived) return true;
    this.db
      .update(sessions)
      .set({ archived, updatedAt: this.now().toISOString() })
      .where(eq(sessions.id, sessionId))
      .run();
    void this.events.emit("changed");
    return true;
  }

  /** Effective CR: manual pin wins; else the CR matching the worktree branch. */
  private effectiveCrId(row: SessionRow, autoByRepoBranch: Map<string, number>): number | null {
    if (row.crId !== null) return row.crId;
    if (row.branch === null) return null;
    return autoByRepoBranch.get(`${row.repoPath}\0${row.branch}`) ?? null;
  }

  private autoCrIndex(): Map<string, number> {
    const index = new Map<string, number>();
    for (const cr of this.db.select().from(changeRequests).all()) {
      index.set(`${cr.repoPath}\0${cr.branch}`, cr.id);
    }
    return index;
  }

  list(): Session[] {
    const index = this.autoCrIndex();
    return this.db
      .select()
      .from(sessions)
      .all()
      .map((row) => rowToSession(row, this.effectiveCrId(row, index)));
  }

  get(id: string): Session | null {
    const row = this.db.select().from(sessions).where(eq(sessions.id, id)).get();
    return row === undefined
      ? null
      : rowToSession(row, this.effectiveCrId(row, this.autoCrIndex()));
  }

  /** Distinct transcript paths (with their agent) of live sessions. */
  liveTranscripts(): Array<{ path: string; agent: string }> {
    const byPath = new Map<string, string>();
    for (const row of this.db.select().from(sessions).all()) {
      if (row.state === "ended" || row.transcriptPath === null) continue;
      byPath.set(row.transcriptPath, row.agent);
    }
    return [...byPath.entries()].map(([path, agent]) => ({ path, agent }));
  }

  /**
   * Applies an agent-generated title to sessions using this transcript.
   * Precedence: never overrides a manual rename; replaces prompt-derived and
   * stale native titles.
   */
  setNativeTitle(transcriptPath: string, title: string): void {
    const rows = this.db
      .select()
      .from(sessions)
      .where(eq(sessions.transcriptPath, transcriptPath))
      .all();
    const targets = rows.filter((row) => row.titleSource !== "manual" && row.title !== title);
    if (targets.length === 0) return;

    const timestamp = this.now().toISOString();
    for (const row of targets) {
      this.db
        .update(sessions)
        .set({ title, titleSource: "native", updatedAt: timestamp })
        .where(eq(sessions.id, row.id))
        .run();
    }
    void this.events.emit("changed");
  }

  /** Records the latest assistant model observed in an agent transcript. */
  setLastUsedModel(transcriptPath: string, model: string): void {
    const targets = this.db
      .select()
      .from(sessions)
      .where(eq(sessions.transcriptPath, transcriptPath))
      .all()
      .filter((row) => row.model !== model);
    if (targets.length === 0) return;

    const timestamp = this.now().toISOString();
    for (const row of targets) {
      this.db
        .update(sessions)
        .set({ model, updatedAt: timestamp })
        .where(eq(sessions.id, row.id))
        .run();
    }
    void this.events.emit("changed");
  }

  /** Manual rename: wins over every other title source. */
  renameSession(sessionId: string, title: string): boolean {
    const row = this.db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (row === undefined) return false;
    this.db
      .update(sessions)
      .set({ title, titleSource: "manual", updatedAt: this.now().toISOString() })
      .where(eq(sessions.id, sessionId))
      .run();
    void this.events.emit("changed");
    return true;
  }

  getReview(subject: ReviewSubject): Review | null {
    const row = this.db.select().from(reviews).where(reviewSubjectClause(subject)).get();
    return row === undefined ? null : rowToReview(row);
  }

  getChangeRequest(crId: number): ChangeRequest | null {
    const row = this.db.select().from(changeRequests).where(eq(changeRequests.id, crId)).get();
    return row === undefined ? null : rowToChangeRequest(row);
  }

  /**
   * Starts (or restarts) a generation for a subject: upserts the review row
   * into `generating`, preserving the previous groups and reviewed marks so
   * the UI keeps showing the old review while the new one is produced.
   */
  beginReview(
    subject: ReviewSubject,
    engine: AgentKind,
    provider: string | null,
    model: string | null,
  ): Review {
    const timestamp = this.now().toISOString();
    const existing = this.db.select().from(reviews).where(reviewSubjectClause(subject)).get();
    if (existing !== undefined) {
      this.db
        .update(reviews)
        .set({ status: "generating", engine, provider, model, error: null, updatedAt: timestamp })
        .where(eq(reviews.id, existing.id))
        .run();
    } else {
      this.db
        .insert(reviews)
        .values({
          repoPath: subject.repoPath,
          branch: subject.branch,
          status: "generating",
          engine,
          provider,
          model,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .run();
    }
    void this.events.emit("reviewsChanged");
    // SAFETY: the row was just written above, so the re-read cannot miss.
    return this.getReview(subject) as Review;
  }

  /** Lands generated groups; reviewed marks survive only for groups that still exist. */
  completeReview(subject: ReviewSubject, groups: ReviewGroup[], diffHash: string): void {
    const existing = this.db.select().from(reviews).where(reviewSubjectClause(subject)).get();
    if (existing === undefined) return;
    const groupNames = new Set(groups.map((group) => group.name));
    const reviewedGroups = storedReviewedSchema
      .parse(JSON.parse(existing.reviewedGroups))
      .filter((name) => groupNames.has(name));
    this.db
      .update(reviews)
      .set({
        status: "ready",
        groups: JSON.stringify(groups),
        reviewedGroups: JSON.stringify(reviewedGroups),
        diffHash,
        error: null,
        updatedAt: this.now().toISOString(),
      })
      .where(eq(reviews.id, existing.id))
      .run();
    void this.events.emit("reviewsChanged");
  }

  failReview(subject: ReviewSubject, error: string): void {
    const existing = this.db.select().from(reviews).where(reviewSubjectClause(subject)).get();
    if (existing === undefined) return;
    this.db
      .update(reviews)
      .set({ status: "failed", error, updatedAt: this.now().toISOString() })
      .where(eq(reviews.id, existing.id))
      .run();
    void this.events.emit("reviewsChanged");
  }

  /** Toggles a group's reviewed mark. Returns false for unknown review/group. */
  setGroupReviewed(reviewId: number, groupName: string, reviewed: boolean): boolean {
    const row = this.db.select().from(reviews).where(eq(reviews.id, reviewId)).get();
    if (row === undefined) return false;
    const groups = storedGroupsSchema.parse(JSON.parse(row.groups));
    if (!groups.some((group) => group.name === groupName)) return false;
    const current = new Set(storedReviewedSchema.parse(JSON.parse(row.reviewedGroups)));
    if (reviewed) current.add(groupName);
    else current.delete(groupName);
    this.db
      .update(reviews)
      .set({ reviewedGroups: JSON.stringify([...current]), updatedAt: this.now().toISOString() })
      .where(eq(reviews.id, reviewId))
      .run();
    void this.events.emit("reviewsChanged");
    return true;
  }

  /** Sessions working on a repo branch; intent evidence and worktree source for reviews. */
  sessionsForBranch(subject: ReviewSubject): Session[] {
    return this.list().filter(
      (session) => session.repoPath === subject.repoPath && session.branch === subject.branch,
    );
  }

  /**
   * Stamps GitHub PR identity/state onto a CR. Returns true when this newly
   * attached a PR (the auto-generate trigger); identical values are a no-op
   * with no event, so the poller doesn't cause WS churn.
   */
  setChangeRequestPr(
    crId: number,
    pr: { number: number; state: string; url: string; title?: string },
  ): boolean {
    const row = this.db.select().from(changeRequests).where(eq(changeRequests.id, crId)).get();
    if (row === undefined) return false;
    const titled = pr.title ?? row.title;
    if (
      row.prNumber === pr.number &&
      row.prState === pr.state &&
      row.prUrl === pr.url &&
      row.title === titled
    ) {
      return false;
    }
    const newlyAttached = row.prNumber === null;
    this.db
      .update(changeRequests)
      .set({
        prNumber: pr.number,
        prState: pr.state,
        prUrl: pr.url,
        title: titled,
        updatedAt: this.now().toISOString(),
      })
      .where(eq(changeRequests.id, crId))
      .run();
    void this.events.emit("crsChanged");
    return newlyAttached;
  }

  /** The CR for a repo branch when one exists; never creates one. */
  findChangeRequest(repoPath: string, branch: string): ChangeRequest | null {
    const row = this.db
      .select()
      .from(changeRequests)
      .where(and(eq(changeRequests.repoPath, repoPath), eq(changeRequests.branch, branch)))
      .get();
    return row === undefined ? null : rowToChangeRequest(row);
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
