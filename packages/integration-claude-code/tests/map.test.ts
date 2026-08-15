import { describe, expect, it } from "vitest";
import { claudeHookPayloadSchema, toHookEvent } from "../src/index.ts";

const base = {
  session_id: "sess-1",
  transcript_path: "/transcripts/sess-1.jsonl",
  cwd: "/repo",
};

describe("claudeHookPayloadSchema", () => {
  it("accepts payloads with unknown extra fields", () => {
    const payload = claudeHookPayloadSchema.parse({
      ...base,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      permission_mode: "default",
    });
    expect(payload.tool_name).toBe("Bash");
  });

  it("rejects unknown hook event names", () => {
    const result = claudeHookPayloadSchema.safeParse({
      ...base,
      hook_event_name: "SomethingNew",
    });
    expect(result.success).toBe(false);
  });
});

describe("toHookEvent", () => {
  it("maps SessionStart to session-start with transcript path", () => {
    const event = toHookEvent(
      claudeHookPayloadSchema.parse({ ...base, hook_event_name: "SessionStart" }),
    );
    expect(event).toEqual({
      type: "session-start",
      sessionId: "sess-1",
      agent: "claude-code",
      cwd: "/repo",
      transcriptPath: "/transcripts/sess-1.jsonl",
    });
  });

  it("maps UserPromptSubmit to user-prompt", () => {
    const event = toHookEvent(
      claudeHookPayloadSchema.parse({
        ...base,
        hook_event_name: "UserPromptSubmit",
        prompt: "Fix the bug",
      }),
    );
    expect(event).toMatchObject({ type: "user-prompt", prompt: "Fix the bug" });
  });

  it("maps tool use to activity with the tool name", () => {
    const event = toHookEvent(
      claudeHookPayloadSchema.parse({
        ...base,
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
      }),
    );
    expect(event).toMatchObject({ type: "activity", tool: "Edit" });
  });

  it("maps Notification to attention and Stop to stopped", () => {
    expect(
      toHookEvent(
        claudeHookPayloadSchema.parse({
          ...base,
          hook_event_name: "Notification",
          message: "Needs permission",
        }),
      ),
    ).toMatchObject({ type: "attention", message: "Needs permission" });
    expect(
      toHookEvent(claudeHookPayloadSchema.parse({ ...base, hook_event_name: "Stop" })),
    ).toMatchObject({ type: "stopped" });
  });

  it("maps SessionEnd to session-end with reason", () => {
    const event = toHookEvent(
      claudeHookPayloadSchema.parse({ ...base, hook_event_name: "SessionEnd", reason: "exit" }),
    );
    expect(event).toMatchObject({ type: "session-end", reason: "exit" });
  });
});
