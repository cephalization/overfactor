import { z } from "zod";

/**
 * Shared contracts between the Overfactor daemon, agent integrations, and the
 * desktop app. Every I/O boundary (hook payloads, HTTP bodies, WS messages,
 * files read off disk) validates against these schemas — never trust raw input.
 */

export const agentKindSchema = z.enum(["claude-code", "pi"]);
export type AgentKind = z.infer<typeof agentKindSchema>;

const reviewSettingValueSchema = z.string().trim().min(1).max(200);

/** Default engine policy used until the user chooses one in Settings. */
export const reviewSettingsSchema = z.discriminatedUnion("agent", [
  z.object({
    agent: z.literal("claude-code"),
    /** Claude Code owns its provider/authentication; only its model alias is configurable. */
    provider: z.null(),
    model: reviewSettingValueSchema,
  }),
  z.object({
    agent: z.literal("pi"),
    provider: reviewSettingValueSchema,
    model: reviewSettingValueSchema,
  }),
]);
export type ReviewSettings = z.infer<typeof reviewSettingsSchema>;

export const DEFAULT_REVIEW_SETTINGS: ReviewSettings = {
  agent: "claude-code",
  provider: null,
  model: "sonnet",
};

/** One authenticated provider/model pair available to a review engine. */
export const reviewModelOptionSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  name: z.string().min(1),
});
export type ReviewModelOption = z.infer<typeof reviewModelOptionSchema>;

export const reviewModelsResponseSchema = z.object({
  models: z.array(reviewModelOptionSchema),
});
export type ReviewModelsResponse = z.infer<typeof reviewModelsResponseSchema>;

/** Optional features an agent integration can expose to Overfactor clients. */
export const agentCapabilitySchema = z.enum(["continue-conversation", "generate-review"]);
export type AgentCapability = z.infer<typeof agentCapabilitySchema>;

/** Public manifest served by the daemon for each installed agent integration. */
export const agentIntegrationManifestSchema = z.object({
  agent: agentKindSchema,
  capabilities: z.array(agentCapabilitySchema),
});
export type AgentIntegrationManifest = z.infer<typeof agentIntegrationManifestSchema>;

export function agentSupportsCapability(
  integrations: readonly AgentIntegrationManifest[],
  agent: AgentKind,
  capability: AgentCapability,
): boolean {
  return (
    integrations
      .find((integration) => integration.agent === agent)
      ?.capabilities.includes(capability) ?? false
  );
}

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
  /** Most recent model reported by an assistant transcript entry. */
  model: z.string().min(1).nullable(),
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
  /** User-controlled visibility flag; archived sessions remain fully accessible. */
  archived: z.boolean(),
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

/** App request to continue a conversation through a capable agent integration. */
const conversationPromptSchema = z.string().trim().min(1).max(100_000);

export const continueConversationRequestSchema = z.object({
  prompt: conversationPromptSchema,
});
export type ContinueConversationRequest = z.infer<typeof continueConversationRequestSchema>;

export const continueConversationResponseSchema = z.object({
  queued: z.literal(true),
  messageId: z.uuid(),
});
export type ContinueConversationResponse = z.infer<typeof continueConversationResponseSchema>;

/** One queued message delivered by the daemon to an agent integration. */
export const conversationMessageSchema = z.object({
  id: z.uuid(),
  prompt: conversationPromptSchema,
  createdAt: z.iso.datetime(),
});
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;

export const conversationInboxResponseSchema = z.object({
  message: conversationMessageSchema.nullable(),
});
export type ConversationInboxResponse = z.infer<typeof conversationInboxResponseSchema>;

export const conversationMessageAckSchema = z.object({
  messageId: z.uuid(),
});
export type ConversationMessageAck = z.infer<typeof conversationMessageAckSchema>;

export const conversationMessageAckResponseSchema = z.object({ ok: z.literal(true) });
export type ConversationMessageAckResponse = z.infer<typeof conversationMessageAckResponseSchema>;

/** One intent group in a curated review: what the change does, not where it lives. */
export const reviewGroupSchema = z.object({
  name: z.string().min(1).max(120),
  /** 1-3 sentences: what the group does and why. */
  summary: z.string().min(1).max(2000),
  /** Repo-relative paths of the changed files this group covers. */
  files: z.array(z.string().min(1)).min(1),
});
export type ReviewGroup = z.infer<typeof reviewGroupSchema>;

export const reviewStatusSchema = z.enum(["generating", "ready", "failed"]);
export type ReviewStatus = z.infer<typeof reviewStatusSchema>;

/** Addresses one review: the branch of a repo (the unit of work under review). */
export const reviewSubjectSchema = z.object({
  repoPath: z.string().min(1),
  branch: z.string().min(1),
});
export type ReviewSubject = z.infer<typeof reviewSubjectSchema>;

/** Body of `POST /reviews/generate`: the subject plus an optional model override. */
export const generateReviewRequestSchema = reviewSubjectSchema.extend({
  /** Engine model alias/id; omitted means the engine's explicit default. */
  model: z.string().trim().min(1).max(100).optional(),
});
export type GenerateReviewRequest = z.infer<typeof generateReviewRequestSchema>;

/**
 * A guided review as served by the daemon. Reviews are branch-level: every
 * session on (repoPath, branch) shares one review of the branch's total
 * change — committed work against the default branch plus the live
 * worktree's uncommitted changes.
 */
export const reviewSchema = z.object({
  id: z.int().positive(),
  repoPath: z.string().min(1),
  branch: z.string().min(1),
  status: reviewStatusSchema,
  engine: agentKindSchema,
  provider: z.string().nullable(),
  model: z.string().nullable(),
  /** Content hash of the reviewed patch; regeneration staleness keys off it. */
  diffHash: z.string().nullable(),
  groups: z.array(reviewGroupSchema),
  /** Names of groups the user marked reviewed; survives regeneration for unchanged groups. */
  reviewedGroups: z.array(z.string()),
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Review = z.infer<typeof reviewSchema>;

/** Response of `GET /reviews`: the review plus its diff subject for rendering. */
export const reviewResponseSchema = z.object({
  review: reviewSchema.nullable(),
  patch: z.string().nullable(),
});
export type ReviewResponse = z.infer<typeof reviewResponseSchema>;

/**
 * Input handed to an integration's review engine. Carries intent evidence
 * Overfactor uniquely has (session titles) and the previous grouping so
 * regeneration can keep unchanged groups stable.
 */
export const reviewEngineRequestSchema = z.object({
  patch: z.string().min(1),
  intent: z.object({
    crTitle: z.string().nullable(),
    branch: z.string().nullable(),
    sessionTitles: z.array(z.string()),
  }),
  previousGroups: z.array(reviewGroupSchema).nullable(),
});
export type ReviewEngineRequest = z.infer<typeof reviewEngineRequestSchema>;

/** Output contract every review engine must satisfy. */
export const reviewEngineResultSchema = z.object({
  groups: z.array(reviewGroupSchema).min(1),
});
export type ReviewEngineResult = z.infer<typeof reviewEngineResultSchema>;

/**
 * Repairs an engine's grouping against the actual changed-file list: unknown
 * files are dropped, duplicate assignments keep their first group, and files
 * the engine missed are swept into a trailing catch-all group rather than
 * failing the review.
 */
export function normalizeReviewGroups(
  groups: readonly ReviewGroup[],
  changedFiles: readonly string[],
): ReviewGroup[] {
  const known = new Set(changedFiles);
  const assigned = new Set<string>();
  const normalized: ReviewGroup[] = [];
  for (const group of groups) {
    const files = group.files.filter((file) => known.has(file) && !assigned.has(file));
    for (const file of files) assigned.add(file);
    if (files.length > 0) normalized.push({ ...group, files });
  }
  const missed = changedFiles.filter((file) => !assigned.has(file));
  if (missed.length > 0) {
    normalized.push({
      name: "Everything else",
      summary: "Changed files the review did not assign to an intent group.",
      files: missed,
    });
  }
  return normalized;
}

/** Messages the daemon pushes to app subscribers over WebSocket. */
export const wsServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("invalidate"),
    collection: z.enum(["sessions", "repos", "crs", "transcripts", "reviews", "settings"]),
  }),
]);
export type WsServerMessage = z.infer<typeof wsServerMessageSchema>;

/** Response of `GET /repos/branches`: refs a review can be generated for. */
export const repoBranchesResponseSchema = z.object({
  /** Local and remote branch names (remote prefix stripped), deduped, sorted. */
  branches: z.array(z.string()),
  defaultBranch: z.string().nullable(),
});
export type RepoBranchesResponse = z.infer<typeof repoBranchesResponseSchema>;

/** Body of `POST /repos/branch`: track a branch without a detected session. */
export const trackBranchRequestSchema = z.object({
  path: z.string().min(1),
  branch: z.string().min(1),
});
export type TrackBranchRequest = z.infer<typeof trackBranchRequestSchema>;

/** Body of `POST /repos/pr`: fetch a GitHub PR, create a worktree, track it. */
export const trackPrRequestSchema = z.object({
  path: z.string().min(1),
  /** A github.com pull request URL, e.g. https://github.com/o/r/pull/7 */
  url: z.string().min(1),
});
export type TrackPrRequest = z.infer<typeof trackPrRequestSchema>;

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
  /** Agent/provider/model policy for automatic and on-demand reviews. */
  review: reviewSettingsSchema.default(DEFAULT_REVIEW_SETTINGS),
});
export type OverfactorConfig = z.infer<typeof overfactorConfigSchema>;
