import { execFileSync } from "node:child_process";
import { mkdtemp, realpath } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureLocalBranch, listBranches, localBranchExists } from "../src/branches.ts";

/** A clone with a local bare "origin" so remote-branch behavior is real. */
async function makeCloneWithOrigin(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "overfactor-branches-")));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.t" },
      stdio: "pipe",
    });
  const seed = join(root, "seed");
  git(root, "init", "-q", "-b", "main", "seed");
  writeFileSync(join(seed, "f.txt"), "a\n");
  git(seed, "add", ".");
  git(seed, "-c", "user.name=t", "-c", "user.email=t@t.t", "commit", "-qm", "init");
  git(seed, "branch", "feat/remote-only");
  git(root, "clone", "-q", "--bare", seed, "origin.git");
  git(root, "clone", "-q", "origin.git", "clone");
  const clone = join(root, "clone");
  git(clone, "branch", "feat/local-only");
  return clone;
}

describe("branch tracking git operations", () => {
  it("lists local and remote branches deduped with remote prefixes stripped", async () => {
    const clone = await makeCloneWithOrigin();
    expect(await listBranches(clone)).toEqual(["feat/local-only", "feat/remote-only", "main"]);
  });

  it("materializes a remote-only branch locally without a checkout", async () => {
    const clone = await makeCloneWithOrigin();
    expect(await localBranchExists(clone, "feat/remote-only")).toBe(false);
    await ensureLocalBranch(clone, "feat/remote-only");
    expect(await localBranchExists(clone, "feat/remote-only")).toBe(true);
    // Idempotent, and unknown branches throw.
    await ensureLocalBranch(clone, "feat/remote-only");
    await expect(ensureLocalBranch(clone, "no-such-branch")).rejects.toThrow();
  });
});
