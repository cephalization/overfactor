import { sessionSchema } from "@overfactor/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp, resolveRepoForCwd } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { SessionStore } from "../src/store.ts";

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
    const body = (await diff.json()) as { patch: string | null };
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
    const body = (await response.json()) as {
      entries: Array<{ markdown: string }>;
      totalCount: number;
    };
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
