import type { HookEvent } from "@overfactor/sdk";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { SessionStore } from "../src/store.ts";

const REPO = "/repo";

function makeStore(): SessionStore {
  return new SessionStore(openDb(":memory:"));
}

function event(partial: Partial<HookEvent> & { type: HookEvent["type"] }): HookEvent {
  return {
    sessionId: "sess-1",
    agent: "claude-code",
    cwd: "/repo/sub",
    ...partial,
  } as HookEvent;
}

describe("SessionStore lifecycle", () => {
  it("creates a working session on session-start", () => {
    const store = makeStore();
    store.applyEvent(event({ type: "session-start", transcriptPath: "/t.jsonl" }), REPO);
    const [session] = store.list();
    expect(session).toMatchObject({
      id: "sess-1",
      state: "working",
      title: null,
      transcriptPath: "/t.jsonl",
      repoPath: REPO,
      diff: null,
    });
  });

  it("titles the session from the first prompt only", () => {
    const store = makeStore();
    store.applyEvent(event({ type: "session-start", transcriptPath: null }), REPO);
    store.applyEvent(event({ type: "user-prompt", prompt: "Fix the flaky test\ndetails" }), REPO);
    store.applyEvent(event({ type: "user-prompt", prompt: "Second prompt" }), REPO);
    expect(store.list()[0]?.title).toBe("Fix the flaky test");
  });

  it("walks working → blocked → working → idle → ended", () => {
    const store = makeStore();
    const states = () => store.list()[0]?.state;
    store.applyEvent(event({ type: "session-start", transcriptPath: null }), REPO);
    expect(states()).toBe("working");
    store.applyEvent(event({ type: "attention", message: "needs permission" }), REPO);
    expect(states()).toBe("blocked");
    store.applyEvent(event({ type: "activity", tool: "Bash" }), REPO);
    expect(states()).toBe("working");
    store.applyEvent(event({ type: "stopped" }), REPO);
    expect(states()).toBe("idle");
    store.applyEvent(event({ type: "session-end", reason: "exit" }), REPO);
    expect(states()).toBe("ended");
  });

  it("creates a session on the fly when start was missed", () => {
    const store = makeStore();
    store.applyEvent(event({ type: "activity", tool: "Edit" }), REPO);
    expect(store.list()[0]).toMatchObject({ id: "sess-1", state: "working", title: null });
  });

  it("records diff stats for all sessions sharing a cwd", () => {
    const store = makeStore();
    store.applyEvent(event({ type: "session-start", transcriptPath: null }), REPO);
    store.applyEvent(
      event({ type: "session-start", sessionId: "sess-2", transcriptPath: null }),
      REPO,
    );
    store.setDiffForCwd("/repo/sub", { filesChanged: 3, insertions: 5, deletions: 1 });
    for (const session of store.list()) {
      expect(session.diff).toEqual({ filesChanged: 3, insertions: 5, deletions: 1 });
    }
  });

  it("excludes ended sessions from live cwds", () => {
    const store = makeStore();
    store.applyEvent(event({ type: "session-start", transcriptPath: null }), REPO);
    store.applyEvent(
      event({
        type: "session-start",
        sessionId: "sess-2",
        cwd: "/repo/other",
        transcriptPath: null,
      }),
      REPO,
    );
    store.applyEvent(event({ type: "session-end", sessionId: "sess-2", cwd: "/repo/other" }), REPO);
    expect(store.liveCwds(REPO)).toEqual(["/repo/sub"]);
  });
});
