import { sessionSchema } from "@overfactor/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp, resolveRepoForCwd } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { SessionStore } from "../src/store.ts";

function makeApp(repos: string[]) {
  const store = new SessionStore(openDb(":memory:"));
  const app = createApp({ store, repos: () => repos });
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
