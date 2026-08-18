import { describe, expect, it } from "vitest";
import {
  agentIntegrationManifestSchema,
  agentSupportsCapability,
  continueConversationRequestSchema,
  conversationMessageSchema,
  daemonInfoSchema,
  hookEventSchema,
  normalizeReviewGroups,
  sessionSchema,
  transcriptEntrySchema,
} from "../src/index.ts";

describe("agent integration capabilities", () => {
  it("lets clients discover optional features by agent", () => {
    const integrations = [
      agentIntegrationManifestSchema.parse({ agent: "claude-code", capabilities: [] }),
      agentIntegrationManifestSchema.parse({
        agent: "pi",
        capabilities: ["continue-conversation"],
      }),
    ];

    expect(agentSupportsCapability(integrations, "pi", "continue-conversation")).toBe(true);
    expect(agentSupportsCapability(integrations, "claude-code", "continue-conversation")).toBe(
      false,
    );
  });
});

describe("conversation schemas", () => {
  it("validates queued continuation prompts", () => {
    expect(continueConversationRequestSchema.parse({ prompt: "  keep going  " })).toEqual({
      prompt: "keep going",
    });
    expect(
      conversationMessageSchema.parse({
        id: "00000000-0000-4000-8000-000000000000",
        prompt: "keep going",
        createdAt: "2026-08-16T12:00:00.000Z",
      }).prompt,
    ).toBe("keep going");
  });

  it("rejects empty prompts", () => {
    expect(continueConversationRequestSchema.safeParse({ prompt: "   " }).success).toBe(false);
  });
});

describe("hookEventSchema", () => {
  it("accepts a session-start event", () => {
    const event = hookEventSchema.parse({
      type: "session-start",
      sessionId: "abc",
      agent: "claude-code",
      cwd: "/repo",
      transcriptPath: "/transcripts/abc.jsonl",
    });
    expect(event.type).toBe("session-start");
  });

  it("rejects unknown event types", () => {
    const result = hookEventSchema.safeParse({
      type: "mystery",
      sessionId: "abc",
      agent: "claude-code",
      cwd: "/repo",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty session id", () => {
    const result = hookEventSchema.safeParse({
      type: "stopped",
      sessionId: "",
      agent: "claude-code",
      cwd: "/repo",
    });
    expect(result.success).toBe(false);
  });
});

describe("sessionSchema", () => {
  it("round-trips a full session", () => {
    const session = sessionSchema.parse({
      id: "abc",
      agent: "claude-code",
      model: "claude-fable-5",
      title: "Fix the flaky test",
      state: "working",
      cwd: "/repo",
      repoPath: "/repo",
      transcriptPath: null,
      branch: "feat/flaky-test",
      crId: 1,
      archived: false,
      diff: { filesChanged: 2, insertions: 10, deletions: 3 },
      startedAt: "2026-08-15T12:00:00.000Z",
      updatedAt: "2026-08-15T12:01:00.000Z",
    });
    expect(session.diff?.filesChanged).toBe(2);
  });

  it("rejects negative diff stats", () => {
    const result = sessionSchema.safeParse({
      id: "abc",
      agent: "claude-code",
      model: null,
      title: null,
      state: "idle",
      cwd: "/repo",
      repoPath: "/repo",
      transcriptPath: null,
      branch: null,
      crId: null,
      archived: false,
      diff: { filesChanged: -1, insertions: 0, deletions: 0 },
      startedAt: "2026-08-15T12:00:00.000Z",
      updatedAt: "2026-08-15T12:01:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});

describe("transcriptEntrySchema", () => {
  it("accepts tool invocation metadata", () => {
    const entry = transcriptEntrySchema.parse({
      id: "entry-1",
      role: "tool",
      markdown: "```json\n{}\n```",
      toolName: "read",
      toolCallId: "call-1",
      toolPhase: "call",
    });
    expect(entry.toolCallId).toBe("call-1");
  });
});

describe("daemonInfoSchema", () => {
  it("rejects a zero port", () => {
    const result = daemonInfoSchema.safeParse({
      port: 0,
      pid: 123,
      startedAt: "2026-08-15T12:00:00.000Z",
      version: "0.0.0",
    });
    expect(result.success).toBe(false);
  });
});

describe("normalizeReviewGroups", () => {
  const changed = ["src/a.ts", "src/b.ts", "tests/a.test.ts"];

  it("passes a complete, disjoint grouping through untouched", () => {
    const groups = [
      { name: "Core", summary: "Does the thing.", files: ["src/a.ts", "src/b.ts"] },
      { name: "Tests", summary: "Covers it.", files: ["tests/a.test.ts"] },
    ];
    expect(normalizeReviewGroups(groups, changed)).toEqual(groups);
  });

  it("drops unknown files, dedupes to first assignment, sweeps the rest", () => {
    const groups = [
      { name: "Core", summary: "Does the thing.", files: ["src/a.ts", "ghost.ts"] },
      { name: "Echo", summary: "Repeats a file.", files: ["src/a.ts"] },
    ];
    expect(normalizeReviewGroups(groups, changed)).toEqual([
      { name: "Core", summary: "Does the thing.", files: ["src/a.ts"] },
      {
        name: "Everything else",
        summary: "Changed files the review did not assign to an intent group.",
        files: ["src/b.ts", "tests/a.test.ts"],
      },
    ]);
  });

  it("drops groups left empty after filtering", () => {
    const groups = [{ name: "Ghosts", summary: "Only unknowns.", files: ["ghost.ts"] }];
    expect(normalizeReviewGroups(groups, changed).map((group) => group.name)).toEqual([
      "Everything else",
    ]);
  });
});
