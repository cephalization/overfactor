import {
  agentIntegrationManifestSchema,
  changeRequestSchema,
  continueConversationResponseSchema,
  conversationInboxResponseSchema,
  repoBranchesResponseSchema,
  reviewResponseSchema,
  sessionDiffSchema,
  sessionSchema,
  sessionTranscriptSchema,
} from "@overfactor/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp, resolveRepoForCwd } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import type { ReviewTriggerOutcome } from "../src/review.ts";
import { SessionStore } from "../src/store.ts";

const trackedCrResponseSchema = z.object({ cr: changeRequestSchema });

function makeApp(repos: string[]) {
  const store = new SessionStore(openDb(":memory:"));
  const app = createApp({ store, resolveRepo: async (cwd) => resolveRepoForCwd(repos, cwd) });
  return { app, store };
}

const startEvent = {
  type: "session-start",
  sessionId: "sess-1",
  agent: "claude-code",
  cwd: "/repo/sub",
  transcriptPath: null,
};

describe("daemon app", () => {
  it("accepts a valid event and serves the session", async () => {
    const { app } = makeApp(["/repo"]);
    const post = await app.request("/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(startEvent),
    });
    expect(post.status).toBe(202);
    expect(await post.json()).toEqual({ accepted: true, reason: null });

    const sessions = z.array(sessionSchema).parse(await (await app.request("/sessions")).json());
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: "sess-1", state: "working", repoPath: "/repo" });
  });

  it("advertises integration capabilities and queues messages only for Pi", async () => {
    const { app } = makeApp(["/repo"]);
    const integrations = z
      .array(agentIntegrationManifestSchema)
      .parse(await (await app.request("/agents")).json());
    expect(integrations).toEqual([
      { agent: "claude-code", capabilities: ["generate-review"] },
      { agent: "pi", capabilities: ["continue-conversation", "generate-review"] },
    ]);

    await app.request("/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...startEvent, sessionId: "pi-1", agent: "pi" }),
    });
    const queued = await app.request("/sessions/pi-1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Continue from the app" }),
    });
    expect(queued.status).toBe(202);
    const queuedBody = continueConversationResponseSchema.parse(await queued.json());

    // A Pi process can exit and resume the same native session. Keep accepted
    // prompts available across that handoff instead of silently dropping them.
    const ended = await app.request("/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "session-end",
        sessionId: "pi-1",
        agent: "pi",
        cwd: "/repo/sub",
        reason: "quit",
      }),
    });
    expect(ended.status).toBe(202);

    const next = conversationInboxResponseSchema.parse(
      await (await app.request("/sessions/pi-1/messages/next")).json(),
    );
    expect(next.message).toMatchObject({
      id: queuedBody.messageId,
      prompt: "Continue from the app",
    });

    const ack = await app.request("/sessions/pi-1/messages/ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: queuedBody.messageId }),
    });
    expect(ack.status).toBe(200);
    expect(
      conversationInboxResponseSchema.parse(
        await (await app.request("/sessions/pi-1/messages/next")).json(),
      ).message,
    ).toBeNull();

    await app.request("/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(startEvent),
    });
    expect(
      (
        await app.request("/sessions/sess-1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: "Unsupported" }),
        })
      ).status,
    ).toBe(409);
  });

  it("rejects malformed events with 400", async () => {
    const { app, store } = makeApp(["/repo"]);
    const post = await app.request("/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "session-start", sessionId: "" }),
    });
    expect(post.status).toBe(400);
    expect(store.list()).toHaveLength(0);
  });

  it("drops events from unconfigured repos", async () => {
    const { app, store } = makeApp(["/elsewhere"]);
    const post = await app.request("/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(startEvent),
    });
    expect(post.status).toBe(202);
    expect(await post.json()).toEqual({ accepted: false, reason: "unconfigured-repo" });
    expect(store.list()).toHaveLength(0);
  });

  it("archives and restores a session", async () => {
    const { app } = makeApp(["/repo"]);
    await app.request("/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(startEvent),
    });

    const archive = await app.request("/sessions/sess-1/archive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    expect(archive.status).toBe(200);
    const sessions = z.array(sessionSchema).parse(await (await app.request("/sessions")).json());
    expect(sessions[0]?.archived).toBe(true);

    const restore = await app.request("/sessions/sess-1/archive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: false }),
    });
    expect(restore.status).toBe(200);
    expect(
      z.array(sessionSchema).parse(await (await app.request("/sessions")).json())[0]?.archived,
    ).toBe(false);
    expect(
      (
        await app.request("/sessions/nope/archive", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ archived: true }),
        })
      ).status,
    ).toBe(404);
  });

  it("serves a session's patch and 404s unknown sessions", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtemp, realpath, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const join = (...parts: string[]) => path.join(...parts);
    const repo = await realpath(await mkdtemp(join(tmpdir(), "overfactor-app-diff-")));
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: repo,
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.t" },
        stdio: "pipe",
      });
    git("init");
    await writeFile(join(repo, "a.txt"), "one\n");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t.t", "commit", "-m", "init");
    await writeFile(join(repo, "a.txt"), "one\ntwo\n");

    const { app } = makeApp([repo]);
    await app.request("/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...startEvent, cwd: repo }),
    });

    const diff = await app.request("/sessions/sess-1/diff");
    expect(diff.status).toBe(200);
    const body = sessionDiffSchema.parse(await diff.json());
    expect(body.patch).toContain("diff --git a/a.txt b/a.txt");
    expect(body.patch).toContain("+two");

    const missing = await app.request("/sessions/nope/diff");
    expect(missing.status).toBe(404);
  });

  it("serves a parsed transcript tail and 404s unknown sessions", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = await mkdtemp(path.join(tmpdir(), "overfactor-transcript-"));
    const transcriptPath = path.join(dir, "t.jsonl");
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({ type: "user", uuid: "u1", message: { content: "hello agent" } }),
        JSON.stringify({
          type: "assistant",
          uuid: "a1",
          message: { role: "assistant", content: [{ type: "text", text: "hello human" }] },
        }),
      ].join("\n"),
      "utf8",
    );

    const { app } = makeApp(["/repo"]);
    await app.request("/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...startEvent, transcriptPath }),
    });

    const response = await app.request("/sessions/sess-1/transcript");
    expect(response.status).toBe(200);
    const body = sessionTranscriptSchema.parse(await response.json());
    expect(body.totalCount).toBe(2);
    expect(body.entries.map((e) => e.markdown)).toEqual(["hello agent", "hello human"]);

    expect((await app.request("/sessions/nope/transcript")).status).toBe(404);
  });

  it("reports health", async () => {
    const { app } = makeApp([]);
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });
});

describe("resolveRepoForCwd", () => {
  it("matches the repo root itself and subdirectories", () => {
    expect(resolveRepoForCwd(["/repo"], "/repo")).toBe("/repo");
    expect(resolveRepoForCwd(["/repo"], "/repo/deep/dir")).toBe("/repo");
  });

  it("does not match sibling prefixes", () => {
    expect(resolveRepoForCwd(["/repo"], "/repo-other")).toBeNull();
  });

  it("prefers the longest matching repo", () => {
    expect(resolveRepoForCwd(["/repo", "/repo/nested"], "/repo/nested/x")).toBe("/repo/nested");
  });
});

describe("review routes", () => {
  const reviewGroups = [{ name: "G", summary: "S.", files: ["a.txt"] }];
  const subject = { repoPath: "/repo", branch: "main" };

  function makeReviewApp() {
    const store = new SessionStore(openDb(":memory:"));
    const outcomes: ReviewTriggerOutcome[] = [];
    const triggeredModels: Array<string | null> = [];
    const app = createApp({
      store,
      resolveRepo: async () => "/repo",
      review: {
        get: async (requested) => ({
          review: store.getReview(requested),
          patch: "diff --git a/a.txt b/a.txt",
        }),
        trigger: async (_requested, model) => {
          triggeredModels.push(model);
          return outcomes.shift() ?? "started";
        },
      },
    });
    return { app, store, outcomes, triggeredModels };
  }

  it("503s when no runner is wired", async () => {
    const { app } = makeApp(["/repo"]);
    expect((await app.request("/reviews?repoPath=/repo&branch=main")).status).toBe(503);
    expect(
      (
        await app.request("/reviews/generate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(subject),
        })
      ).status,
    ).toBe(503);
  });

  it("serves the branch review with its patch and validates the subject", async () => {
    const { app, store } = makeReviewApp();
    store.beginReview(subject, "claude-code", null, null);
    store.completeReview(subject, reviewGroups, "hash");

    const response = await app.request(
      `/reviews?repoPath=${encodeURIComponent(subject.repoPath)}&branch=${subject.branch}`,
    );
    expect(response.status).toBe(200);
    const body = reviewResponseSchema.parse(await response.json());
    expect(body.review?.status).toBe("ready");
    expect(body.review?.branch).toBe("main");
    expect(body.patch).toContain("diff --git");

    // A different branch has no review yet but still answers with the patch.
    const empty = reviewResponseSchema.parse(
      await (await app.request("/reviews?repoPath=/repo&branch=other")).json(),
    );
    expect(empty.review).toBeNull();

    expect((await app.request("/reviews?repoPath=/repo")).status).toBe(400);
  });

  it("maps trigger outcomes onto statuses and forwards the model override", async () => {
    const { app, outcomes, triggeredModels } = makeReviewApp();
    const generate = (body: string) =>
      app.request("/reviews/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });

    expect((await generate(JSON.stringify(subject))).status).toBe(202);
    expect((await generate(JSON.stringify({ ...subject, model: "haiku" }))).status).toBe(202);
    expect(triggeredModels).toEqual([null, "haiku"]);
    outcomes.push("empty-diff");
    const conflict = await generate(JSON.stringify(subject));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "empty-diff" });
    expect((await generate(JSON.stringify({ repoPath: "/repo" }))).status).toBe(400);
  });

  it("persists reviewed marks and 404s unknown review groups", async () => {
    const { app, store } = makeReviewApp();
    const review = store.beginReview(subject, "claude-code", null, null);
    store.completeReview(subject, reviewGroups, "hash");

    const mark = await app.request(`/reviews/${review.id}/groups`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ group: "G", reviewed: true }),
    });
    expect(mark.status).toBe(200);
    expect(store.getReview(subject)?.reviewedGroups).toEqual(["G"]);

    const unknown = await app.request(`/reviews/${review.id}/groups`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ group: "Nope", reviewed: true }),
    });
    expect(unknown.status).toBe(404);
  });
});

describe("branch tracking routes", () => {
  function makeTrackingApp() {
    const store = new SessionStore(openDb(":memory:"));
    const app = createApp({
      store,
      resolveRepo: async () => "/repo",
      branchTracking: {
        listBranches: async () => ["feat/x", "main"],
        defaultBranchFor: async () => "main",
        trackBranch: async (repoPath, branch) => store.ensureChangeRequest(repoPath, branch),
        trackPr: async (repoPath) => {
          const cr = store.ensureChangeRequest(repoPath, "feat/pr");
          store.setChangeRequestPr(cr.id, {
            number: 7,
            state: "open",
            url: "https://github.com/o/r/pull/7",
            title: "PR title",
          });
          return store.findChangeRequest(repoPath, "feat/pr") ?? cr;
        },
      },
    });
    return { app, store };
  }

  it("503s when tracking is not wired", async () => {
    const { app } = makeApp(["/repo"]);
    expect((await app.request("/repos/branches?path=/repo")).status).toBe(503);
  });

  it("lists branches with the default branch identified", async () => {
    const { app } = makeTrackingApp();
    const response = await app.request("/repos/branches?path=/repo");
    expect(response.status).toBe(200);
    expect(repoBranchesResponseSchema.parse(await response.json())).toEqual({
      branches: ["feat/x", "main"],
      defaultBranch: "main",
    });
  });

  it("tracks a branch but rejects the default branch", async () => {
    const { app, store } = makeTrackingApp();
    const track = (branch: string) =>
      app.request("/repos/branch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/repo", branch }),
      });

    const ok = await track("feat/x");
    expect(ok.status).toBe(200);
    expect(store.findChangeRequest("/repo", "feat/x")).not.toBeNull();

    const rejected = await track("main");
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({ error: "default-branch" });
  });

  it("tracks a PR and returns the stamped CR", async () => {
    const { app } = makeTrackingApp();
    const response = await app.request("/repos/pr", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/repo", url: "https://github.com/o/r/pull/7" }),
    });
    expect(response.status).toBe(200);
    const body = trackedCrResponseSchema.parse(await response.json());
    expect(body.cr).toMatchObject({ branch: "feat/pr", prNumber: 7, title: "PR title" });
  });
});
