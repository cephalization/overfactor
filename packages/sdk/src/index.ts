import { z } from "zod";

/**
 * Shared contracts between the Overfactor daemon, agent integrations, and the
 * desktop app. Every I/O boundary (hook payloads, HTTP bodies, WS messages,
 * files read off disk) validates against these schemas — never trust raw input.
 */

export const agentKindSchema = z.enum(["claude-code", "pi"]);
export type AgentKind = z.infer<typeof agentKindSchema>;

export const lifecycleStateSchema = z.enum(["working", "idle", "blocked", "ended"]);
export type LifecycleState = z.infer<typeof lifecycleStateSchema>;

export const diffStatsSchema = z.object({
  filesChanged: z.int().nonnegative(),
  insertions: z.int().nonnegative(),
  deletions: z.int().nonnegative(),
});
export type DiffStats = z.infer<typeof diffStatsSchema>;

/** A session as served by the daemon (`GET /sessions`). */
export const sessionSchema = z.object({
  /** The agent's native session id (e.g. Claude Code's `session_id`). */
  id: z.string().min(1),
  agent: agentKindSchema,
  /** Derived from the first user prompt; null until one arrives. */
  title: z.string().nullable(),
  state: lifecycleStateSchema,
  /** Working directory the agent runs in (diff attribution boundary). */
  cwd: z.string().min(1),
  /** Root of the configured repo containing `cwd`. */
  repoPath: z.string().min(1),
  transcriptPath: z.string().nullable(),
  /** Branch checked out in the session's worktree; null when detached/unknown. */
  branch: z.string().nullable(),
  /**
   * Effective Change Request id: the manual pin when set, else the CR derived
   * from the worktree branch; null for ungrouped sessions (default branch,
   * detached, or branch not yet resolved).
   */
  crId: z.int().positive().nullable(),
  /** `git diff` stats of the session's worktree; null until first computed. */
  diff: diffStatsSchema.nullable(),
  startedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Session = z.infer<typeof sessionSchema>;

/** A Change Request: sessions grouped into a unit of work, keyed by repo+branch. */
export const changeRequestSchema = z.object({
  id: z.int().positive(),
  repoPath: z.string().min(1),
  branch: z.string().min(1),
  title: z.string().min(1),
  prNumber: z.int().positive().nullable(),
  prState: z.string().nullable(),
  prUrl: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ChangeRequest = z.infer<typeof changeRequestSchema>;

const hookEventBase = {
  sessionId: z.string().min(1),
  agent: agentKindSchema,
  cwd: z.string().min(1),
} as const;

/**
 * Agent-agnostic lifecycle events integrations POST to the daemon
 * (`POST /events`). Integrations map their agent's native hook payloads onto
 * these; the daemon never sees agent-specific shapes.
 */
export const hookEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session-start"),
    ...hookEventBase,
    transcriptPath: z.string().nullable(),
  }),
  z.object({ type: z.literal("user-prompt"), ...hookEventBase, prompt: z.string() }),
  z.object({ type: z.literal("activity"), ...hookEventBase, tool: z.string().optional() }),
  /** Agent finished its turn and is waiting for input. */
  z.object({ type: z.literal("stopped"), ...hookEventBase }),
  /** Agent needs the user (permission prompt, unanswered question). */
  z.object({ type: z.literal("attention"), ...hookEventBase, message: z.string().optional() }),
  z.object({ type: z.literal("session-end"), ...hookEventBase, reason: z.string().optional() }),
]);
export type HookEvent = z.infer<typeof hookEventSchema>;

/** Response of `GET /sessions/:id/diff`: the raw `git diff HEAD` patch of the session's worktree. */
export const sessionDiffSchema = z.object({
  /** Unified multi-file patch; null when the diff cannot be computed. */
  patch: z.string().nullable(),
});
export type SessionDiff = z.infer<typeof sessionDiffSchema>;

/**
 * One rendered transcript entry, normalized across agents. Integration
 * packages parse their agent's native transcript format into these.
 */
export const transcriptEntrySchema = z.object({
  id: z.string().min(1),
  role: z.enum(["user", "assistant", "tool", "system"]),
  /** Markdown body; huge tool output is truncated server-side. */
  markdown: z.string(),
  toolName: z.string().optional(),
  /** Stable native id shared by a tool invocation and its result. */
  toolCallId: z.string().optional(),
  /** Distinguishes invocations from results so the renderer can group runs. */
  toolPhase: z.enum(["call", "result"]).optional(),
  timestamp: z.iso.datetime().optional(),
});
export type TranscriptEntry = z.infer<typeof transcriptEntrySchema>;

/** Response of `GET /sessions/:id/transcript` (tail of the conversation). */
export const sessionTranscriptSchema = z.object({
  entries: z.array(transcriptEntrySchema),
  /** Total entries in the transcript; entries may be a tail of this. */
  totalCount: z.int().nonnegative(),
});
export type SessionTranscript = z.infer<typeof sessionTranscriptSchema>;

/** Messages the daemon pushes to app subscribers over WebSocket. */
export const wsServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("invalidate"),
    collection: z.enum(["sessions", "repos", "crs", "transcripts"]),
  }),
]);
export type WsServerMessage = z.infer<typeof wsServerMessageSchema>;

/** Body of `POST /repos` and `DELETE /repos`. */
export const repoPathRequestSchema = z.object({
  /** Absolute path to a git repo root (its `.git` must exist). */
  path: z.string().min(1),
});
export type RepoPathRequest = z.infer<typeof repoPathRequestSchema>;

/** Response of `GET /health` — lets clients identify a daemon even when daemon.json is missing. */
export const healthResponseSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
  pid: z.int().positive(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** Shape of `~/.overfactor/daemon.json`, written only after a successful bind. */
export const daemonInfoSchema = z.object({
  port: z.int().positive(),
  pid: z.int().positive(),
  startedAt: z.iso.datetime(),
  version: z.string(),
});
export type DaemonInfo = z.infer<typeof daemonInfoSchema>;

/** Shape of `~/.overfactor/config.json`. */
export const overfactorConfigSchema = z.object({
  /** Absolute paths of repos whose sessions the daemon tracks. */
  repos: z.array(z.string()).default([]),
});
export type OverfactorConfig = z.infer<typeof overfactorConfigSchema>;
