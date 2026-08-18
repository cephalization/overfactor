import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookEvent, ReviewEngineRequest, ReviewEngineResult } from "@overfactor/sdk";
import { hookEventSchema } from "@overfactor/sdk";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { changedFilesFromPatch, ReviewRunner, type ReviewEngine } from "../src/review.ts";
import { SessionStore } from "../src/store.ts";

async function makeRepo(): Promise<string> {
  const repo = await realpath(await mkdtemp(join(tmpdir(), "overfactor-review-")));
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
  return repo;
}

function startEvent(repo: string, sessionId = "sess-1"): HookEvent {
  return hookEventSchema.parse({
    type: "session-start",
    sessionId,
    agent: "claude-code",
    cwd: repo,
    transcriptPath: null,
  });
}

/** Store with one session whose worktree is `repo` on branch "main". */
function storeWithSession(repo: string): SessionStore {
  const store = new SessionStore(openDb(":memory:"));
  store.applyEvent(startEvent(repo), repo);
  store.setWorktreeState(repo, null, "main");
  return store;
}

const subjectFor = (repo: string) => ({ repoPath: repo, branch: "main" });

function fakeEngine(result: ReviewEngineResult | Error) {
  const requests: ReviewEngineRequest[] = [];
  const engine: ReviewEngine = {
    agent: "claude-code",
    defaultModel: "sonnet",
    available: () => Promise.resolve(true),
    generate: (request) => {
      requests.push(request);
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
  };
  return { engine, requests };
}

/** Generation completes asynchronously after trigger(); wait for it to land. */
async function waitForSettled(store: SessionStore, subject: { repoPath: string; branch: string }) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const review = store.getReview(subject);
    if (review !== null && review.status !== "generating") return review;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("review never settled");
}

describe("changedFilesFromPatch", () => {
  it("extracts unique b-side paths, including quoted ones", () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "+x",
      'diff --git "a/we ird.ts" "b/we ird.ts"',
      "+y",
      "diff --git a/src/a.ts b/src/a.ts",
    ].join("\n");
    expect(changedFilesFromPatch(patch)).toEqual(["src/a.ts", "we ird.ts"]);
  });
});

describe("ReviewRunner", () => {
  it("generates, normalizes, and stores a review for a lone session", async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, "a.txt"), "one\ntwo\n");
    const store = storeWithSession(repo);

    const seen = fakeEngine({
      groups: [{ name: "Add two", summary: "Appends a line.", files: ["a.txt"] }],
    });
    const runner = new ReviewRunner({
      store,
      defaultBranchFor: async () => "main",
      engines: [seen.engine],
    });

    expect(await runner.trigger(subjectFor(repo))).toBe("started");
    const review = await waitForSettled(store, subjectFor(repo));
    expect(review.status).toBe("ready");
    expect(review.engine).toBe("claude-code");
    // The runner records the engine's explicit default — reviews never
    // silently inherit the harness's own (possibly expensive) default model.
    expect(review.model).toBe("sonnet");
    expect(review.groups).toEqual([
      { name: "Add two", summary: "Appends a line.", files: ["a.txt"] },
    ]);
    expect(review.diffHash).not.toBeNull();
    expect(seen.requests[0]).toMatchObject({ intent: { branch: "main", sessionTitles: [] } });

    const response = await runner.get(subjectFor(repo));
    expect(response.review?.status).toBe("ready");
    expect(response.patch).toContain("+two");
  });

  it("sweeps files the engine missed into a catch-all group", async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, "a.txt"), "one\ntwo\n");
    await writeFile(join(repo, "b.txt"), "new\n");
    execFileSync("git", ["add", "b.txt"], { cwd: repo, stdio: "pipe" });
    const store = storeWithSession(repo);

    const runner = new ReviewRunner({
      store,
      defaultBranchFor: async () => "main",
      engines: [
        fakeEngine({
          groups: [{ name: "Add two", summary: "Appends a line.", files: ["a.txt", "ghost.ts"] }],
        }).engine,
      ],
    });
    await runner.trigger(subjectFor(repo));
    const review = await waitForSettled(store, subjectFor(repo));
    expect(review.groups.map((group) => group.name)).toEqual(["Add two", "Everything else"]);
    expect(review.groups[1]?.files).toEqual(["b.txt"]);
  });

  it("reports empty-diff for a clean worktree", async () => {
    const repo = await makeRepo();
    const store = storeWithSession(repo);
    const runner = new ReviewRunner({
      store,
      defaultBranchFor: async () => "main",
      engines: [fakeEngine(new Error("unused")).engine],
    });
    expect(await runner.trigger(subjectFor(repo))).toBe("empty-diff");
  });

  it("single-flights concurrent triggers for the same subject", async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, "a.txt"), "one\ntwo\n");
    const store = storeWithSession(repo);

    let release: (result: ReviewEngineResult) => void = () => {};
    const gate = new Promise<ReviewEngineResult>((resolve) => {
      release = resolve;
    });
    const runner = new ReviewRunner({
      store,
      defaultBranchFor: async () => "main",
      engines: [
        {
          agent: "claude-code",
          defaultModel: "sonnet",
          available: () => Promise.resolve(true),
          generate: () => gate,
        },
      ],
    });

    expect(await runner.trigger(subjectFor(repo))).toBe("started");
    expect(await runner.trigger(subjectFor(repo))).toBe("already-generating");
    release({ groups: [{ name: "G", summary: "S.", files: ["a.txt"] }] });
    const review = await waitForSettled(store, subjectFor(repo));
    expect(review.status).toBe("ready");
    expect(await runner.trigger(subjectFor(repo))).toBe("started");
  });

  it("prefers a per-trigger model override to the engine default", async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, "a.txt"), "one\ntwo\n");
    const store = storeWithSession(repo);
    const seen = fakeEngine({ groups: [{ name: "G", summary: "S.", files: ["a.txt"] }] });
    const runner = new ReviewRunner({
      store,
      defaultBranchFor: async () => "main",
      engines: [seen.engine],
    });
    expect(await runner.trigger(subjectFor(repo), "opus")).toBe("started");
    const review = await waitForSettled(store, subjectFor(repo));
    expect(review.model).toBe("opus");
  });

  it("marks the review failed when the engine throws", async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, "a.txt"), "one\ntwo\n");
    const store = storeWithSession(repo);
    const runner = new ReviewRunner({
      store,
      defaultBranchFor: async () => "main",
      engines: [fakeEngine(new Error("usage limit reached")).engine],
    });
    await runner.trigger(subjectFor(repo));
    const review = await waitForSettled(store, subjectFor(repo));
    expect(review.status).toBe("failed");
    expect(review.error).toBe("usage limit reached");
  });

  it("reports no-engine when nothing is available", async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, "a.txt"), "one\ntwo\n");
    const store = storeWithSession(repo);
    const runner = new ReviewRunner({
      store,
      defaultBranchFor: async () => "main",
      engines: [
        {
          agent: "claude-code",
          defaultModel: "sonnet",
          available: () => Promise.resolve(false),
          generate: () => Promise.reject(new Error("unavailable")),
        },
      ],
    });
    expect(await runner.trigger(subjectFor(repo))).toBe("no-engine");
  });
});
