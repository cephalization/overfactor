import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeDiffStats } from "../src/diff.ts";

/**
 * Validates the just-git v2 vendoring decision: stats computed by pure-TS
 * just-git against repos and linked worktrees created by real system git.
 */

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t.t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t.t",
    },
    stdio: "pipe",
  });
}

async function makeRepo(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "overfactor-diff-")));
  const repo = join(dir, "repo");
  git(dir, "init", "repo");
  await writeFile(join(repo, "a.txt"), "one\ntwo\nthree\n");
  await writeFile(join(repo, "b.txt"), "keep\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "initial");
  return repo;
}

describe("computeDiffStats (just-git over real repos)", () => {
  it("returns zeros for a clean worktree", async () => {
    const repo = await makeRepo();
    expect(await computeDiffStats(repo)).toEqual({
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
    });
  });

  it("counts staged and unstaged changes to tracked files", async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, "a.txt"), "one\nTWO\nthree\nfour\n");
    git(repo, "add", "a.txt"); // staged
    await writeFile(join(repo, "b.txt"), "changed\nlines\n"); // unstaged
    expect(await computeDiffStats(repo)).toEqual({
      filesChanged: 2,
      insertions: 4,
      deletions: 2,
    });
  });

  it("computes from a subdirectory of the worktree", async () => {
    const repo = await makeRepo();
    git(repo, "checkout", "-b", "feature");
    await writeFile(join(repo, "a.txt"), "one\ntwo\nthree\nextra\n");
    const { mkdir } = await import("node:fs/promises");
    const sub = join(repo, "sub");
    await mkdir(sub);
    expect(await computeDiffStats(sub)).toEqual({
      filesChanged: 1,
      insertions: 1,
      deletions: 0,
    });
  });

  it("reads a linked worktree created by `git worktree add`", async () => {
    const repo = await makeRepo();
    const linked = join(repo, "..", "linked");
    git(repo, "worktree", "add", linked, "-b", "session-branch");
    await writeFile(join(linked, "a.txt"), "one\n");
    expect(await computeDiffStats(linked)).toEqual({
      filesChanged: 1,
      insertions: 0,
      deletions: 2,
    });
    // The main worktree stays clean — attribution is per worktree.
    expect(await computeDiffStats(repo)).toEqual({
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
    });
  });

  it("computes stats for a repo containing a submodule (system-git fallback)", async () => {
    // just-git v2 EISDIRs on gitlink entries; this exercises the fallback.
    const repo = await makeRepo();
    const inner = join(repo, "..", "inner");
    git(repo, "init", "../inner");
    await writeFile(join(inner, "x.txt"), "x\n");
    git(inner, "add", ".");
    git(inner, "commit", "-m", "inner");
    git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "../inner", "sub");
    git(repo, "commit", "-m", "add submodule");
    await writeFile(join(repo, "a.txt"), "one\ntwo\nthree\nfour\n");
    expect(await computeDiffStats(repo)).toEqual({
      filesChanged: 1,
      insertions: 1,
      deletions: 0,
    });
  });

  it("returns null outside a git repo", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "overfactor-nogit-")));
    expect(await computeDiffStats(dir)).toBeNull();
  });
});
