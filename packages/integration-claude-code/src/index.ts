import type { AgentIntegrationManifest, HookEvent } from "@overfactor/sdk";

/** Claude Code hooks are observational and cannot inject input into the live session. */
export const claudeCodeIntegrationManifest = {
  agent: "claude-code",
  capabilities: [],
} satisfies AgentIntegrationManifest;
import { z } from "zod";

/**
 * Claude Code hook payloads arrive on the shim's stdin as JSON. Loose object:
 * Claude Code adds fields between releases; we validate only what we consume.
 * Verified fields (Claude Code hooks docs): every event carries `session_id`,
 * `transcript_path`, `cwd`, and `hook_event_name`.
 */
export const claudeHookPayloadSchema = z.looseObject({
  session_id: z.string().min(1),
  transcript_path: z.string().optional(),
  cwd: z.string().min(1),
  hook_event_name: z.enum([
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Notification",
    "Stop",
    "SessionEnd",
  ]),
  prompt: z.string().optional(),
  tool_name: z.string().optional(),
  message: z.string().optional(),
  reason: z.string().optional(),
});
export type ClaudeHookPayload = z.infer<typeof claudeHookPayloadSchema>;

/** Maps a Claude Code hook payload onto the agent-agnostic SDK event. */
export function toHookEvent(payload: ClaudeHookPayload): HookEvent {
  const base = {
    sessionId: payload.session_id,
    agent: "claude-code" as const,
    cwd: payload.cwd,
  };
  switch (payload.hook_event_name) {
    case "SessionStart":
      return { type: "session-start", ...base, transcriptPath: payload.transcript_path ?? null };
    case "UserPromptSubmit":
      return { type: "user-prompt", ...base, prompt: payload.prompt ?? "" };
    case "PreToolUse":
    case "PostToolUse":
      return { type: "activity", ...base, tool: payload.tool_name };
    case "Notification":
      return { type: "attention", ...base, message: payload.message };
    case "Stop":
      return { type: "stopped", ...base };
    case "SessionEnd":
      return { type: "session-end", ...base, reason: payload.reason };
  }
}
