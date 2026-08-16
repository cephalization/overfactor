import { describe, expect, it } from "vitest";
import {
  activityEvent,
  type PiSessionIdentity,
  sessionEndEvent,
  sessionStartEvent,
  stoppedEvent,
  userPromptEvent,
} from "../src/events.ts";

const identity: PiSessionIdentity = {
  sessionId: "pi-session-1",
  cwd: "/repo",
  transcriptPath: "/sessions/pi-session-1.jsonl",
};

describe("Pi event mapping", () => {
  it("maps session identity onto a Pi session-start event", () => {
    expect(sessionStartEvent(identity)).toEqual({
      type: "session-start",
      sessionId: "pi-session-1",
      agent: "pi",
      cwd: "/repo",
      transcriptPath: "/sessions/pi-session-1.jsonl",
    });
  });

  it("maps prompts, activity, idle, and shutdown lifecycle events", () => {
    expect(userPromptEvent(identity, "Fix the bug")).toMatchObject({
      type: "user-prompt",
      agent: "pi",
      prompt: "Fix the bug",
    });
    expect(activityEvent(identity, "edit")).toMatchObject({
      type: "activity",
      tool: "edit",
    });
    expect(activityEvent(identity)).not.toHaveProperty("tool");
    expect(stoppedEvent(identity)).toMatchObject({ type: "stopped" });
    expect(sessionEndEvent(identity, "quit")).toMatchObject({
      type: "session-end",
      reason: "quit",
    });
  });
});
