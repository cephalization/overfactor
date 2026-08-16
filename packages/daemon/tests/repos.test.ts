import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { addRepo, removeRepo } from "../src/repos.ts";
import { SessionStore } from "../src/store.ts";

let previousDir: string | undefined;
let sandbox: string;

beforeEach(async () => {
  previousDir = process.env.OVERFACTOR_DIR;
  sandbox = await mkdtemp(join(tmpdir(), "overfactor-repos-"));
  process.env.OVERFACTOR_DIR = join(sandbox, "home");
});

afterEach(() => {
  if (previousDir === undefined) delete process.env.OVERFACTOR_DIR;
  else process.env.OVERFACTOR_DIR = previousDir;
});

async function makeGitDir(name: string): Promise<string> {
  const repo = join(sandbox, name);
  await mkdir(join(repo, ".git"), { recursive: true });
  return repo;
}

describe("repo config mutations", () => {
  it("rejects directories without .git", async () => {
    await mkdir(join(sandbox, "plain"));
    expect(await addRepo(join(sandbox, "plain"))).toEqual({
      ok: false,
      reason: "not-a-git-repo",
    });
  });

  it("tracks, dedupes, and persists to config.json", async () => {
    const repo = await makeGitDir("repo-a");
    expect(await addRepo(repo)).toEqual({ ok: true, repos: [repo] });
    expect(await addRepo(repo)).toEqual({ ok: true, repos: [repo] });

    const config = JSON.parse(
      await readFile(join(process.env.OVERFACTOR_DIR ?? "", "config.json"), "utf8"),
    );
    expect(config.repos).toEqual([repo]);
  });

  it("removes tracked repos and ignores unknown paths", async () => {
    const repoA = await makeGitDir("repo-a");
    const repoB = await makeGitDir("repo-b");
    await addRepo(repoA);
    await addRepo(repoB);
    expect(await removeRepo(repoA)).toEqual({ repos: [repoB] });
    expect(await removeRepo(join(sandbox, "never-tracked"))).toEqual({ repos: [repoB] });
  });
});

describe("repo routes", () => {
  function makeApp() {
    const store = new SessionStore(openDb(":memory:"));
    return createApp({ store, resolveRepo: async () => null });
  }

  it("round-trips add, list, and remove", async () => {
    const app = makeApp();
    const repo = await makeGitDir("repo-a");

    const post = await app.request("/repos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: repo }),
    });
    expect(post.status).toBe(200);
    expect(await post.json()).toEqual({ ok: true, repos: [repo] });

    const list = await app.request("/repos");
    expect(await list.json()).toEqual({ repos: [repo] });

    const del = await app.request("/repos", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: repo }),
    });
    expect(await del.json()).toEqual({ repos: [] });
    expect(await (await app.request("/repos")).json()).toEqual({ repos: [] });
  });

  it("rejects non-git directories with 400", async () => {
    const app = makeApp();
    await mkdir(join(sandbox, "plain"));
    const post = await app.request("/repos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: join(sandbox, "plain") }),
    });
    expect(post.status).toBe(400);
    expect(await post.json()).toEqual({ ok: false, reason: "not-a-git-repo" });
  });

  it("rejects an empty path with 400", async () => {
    const app = makeApp();
    const post = await app.request("/repos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "" }),
    });
    expect(post.status).toBe(400);
  });
});
