import { describe, expect, it } from "vitest";
import { daemonInfoSchema, hookEventSchema, sessionSchema } from "../src/index.ts";

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
      title: "Fix the flaky test",
      state: "working",
      cwd: "/repo",
      repoPath: "/repo",
      transcriptPath: null,
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
      title: null,
      state: "idle",
      cwd: "/repo",
      repoPath: "/repo",
      transcriptPath: null,
      diff: { filesChanged: -1, insertions: 0, deletions: 0 },
      startedAt: "2026-08-15T12:00:00.000Z",
      updatedAt: "2026-08-15T12:01:00.000Z",
    });
    expect(result.success).toBe(false);
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
