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
      archived: false,
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
    store.setWorktreeState("/repo/sub", { filesChanged: 3, insertions: 5, deletions: 1 }, null);
    for (const session of store.list()) {
      expect(session.diff).toEqual({ filesChanged: 3, insertions: 5, deletions: 1 });
    }
  });

  it("skips write and change event when diff stats are unchanged", async () => {
    const store = makeStore();
    store.applyEvent(event({ type: "session-start", transcriptPath: null }), REPO);
    store.setWorktreeState("/repo/sub", { filesChanged: 1, insertions: 2, deletions: 0 }, null);
    const before = store.list()[0]?.updatedAt;

    let emitted = 0;
    store.events.on("changed", () => {
      emitted += 1;
    });
    store.setWorktreeState("/repo/sub", { filesChanged: 1, insertions: 2, deletions: 0 }, null);
    await new Promise((r) => setTimeout(r, 0));

    expect(emitted).toBe(0);
    expect(store.list()[0]?.updatedAt).toBe(before);
  });

  it("groups sessions into CRs by worktree branch, with pin override", () => {
    const store = makeStore();
    store.applyEvent(event({ type: "session-start", transcriptPath: null }), REPO);
    store.applyEvent(
      event({ type: "session-start", sessionId: "sess-2", cwd: "/repo/wt2", transcriptPath: null }),
      REPO,
    );

    const cr = store.ensureChangeRequest(REPO, "feat/rate-limit_ingest-api");
    expect(cr.title).toBe("rate limit ingest api");
    expect(store.ensureChangeRequest(REPO, "feat/rate-limit_ingest-api").id).toBe(cr.id);

    // sess-1's worktree is on the CR branch; sess-2 is on the default branch.
    store.setWorktreeState("/repo/sub", null, "feat/rate-limit_ingest-api");
    store.setWorktreeState("/repo/wt2", null, "main");

    const byId = new Map(store.list().map((s) => [s.id, s]));
    expect(byId.get("sess-1")?.crId).toBe(cr.id);
    expect(byId.get("sess-1")?.branch).toBe("feat/rate-limit_ingest-api");
    expect(byId.get("sess-2")?.crId).toBeNull();

    // Manual pin overrides automatic grouping; clearing it restores auto.
    const other = store.ensureChangeRequest(REPO, "fix/other");
    expect(store.pinSession("sess-1", other.id)).toBe(true);
    expect(store.get("sess-1")?.crId).toBe(other.id);
    expect(store.pinSession("sess-1", null)).toBe(true);
    expect(store.get("sess-1")?.crId).toBe(cr.id);
    expect(store.pinSession("nope", null)).toBe(false);
  });

  it("emits crsChanged only when a CR is created", async () => {
    const store = makeStore();
    let emitted = 0;
    store.events.on("crsChanged", () => {
      emitted += 1;
    });
    store.ensureChangeRequest(REPO, "feat/a");
    store.ensureChangeRequest(REPO, "feat/a");
    await new Promise((r) => setTimeout(r, 0));
    expect(emitted).toBe(1);
    expect(store.listChangeRequests()).toHaveLength(1);
  });

  it("archives and restores sessions without changing lifecycle state", () => {
    const store = makeStore();
    store.applyEvent(event({ type: "session-start", transcriptPath: null }), REPO);

    expect(store.setArchived("sess-1", true)).toBe(true);
    expect(store.get("sess-1")).toMatchObject({ archived: true, state: "working" });
    store.applyEvent(event({ type: "stopped" }), REPO);
    expect(store.get("sess-1")).toMatchObject({ archived: true, state: "idle" });
    expect(store.setArchived("sess-1", false)).toBe(true);
    expect(store.get("sess-1")?.archived).toBe(false);
    expect(store.setArchived("nope", true)).toBe(false);
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

describe("title precedence", () => {
  it("prompt fills empty, native beats prompt, manual beats native", () => {
    const store = makeStore();
    store.applyEvent(event({ type: "session-start", transcriptPath: "/t.jsonl" }), REPO);
    store.applyEvent(event({ type: "user-prompt", prompt: "first prompt" }), REPO);
    expect(store.get("sess-1")?.title).toBe("first prompt");

    store.setNativeTitle("/t.jsonl", "Agent generated title");
    expect(store.get("sess-1")?.title).toBe("Agent generated title");

    // later prompts never override
    store.applyEvent(event({ type: "user-prompt", prompt: "second prompt" }), REPO);
    expect(store.get("sess-1")?.title).toBe("Agent generated title");

    expect(store.renameSession("sess-1", "My name")).toBe(true);
    store.setNativeTitle("/t.jsonl", "Newer agent title");
    expect(store.get("sess-1")?.title).toBe("My name");
    expect(store.renameSession("nope", "x")).toBe(false);
  });

  it("native title update is a no-op when unchanged", async () => {
    const store = makeStore();
    store.applyEvent(event({ type: "session-start", transcriptPath: "/t.jsonl" }), REPO);
    store.setNativeTitle("/t.jsonl", "Stable");
    let emitted = 0;
    store.events.on("changed", () => {
      emitted += 1;
    });
    store.setNativeTitle("/t.jsonl", "Stable");
    await new Promise((r) => setTimeout(r, 0));
    expect(emitted).toBe(0);
  });
});
