import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { overfactorDir } from "@overfactor/sdk/node";

const execFileAsync = promisify(execFile);

/** Git operations behind manual branch/PR tracking. Throws with git's stderr. */

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function gitOrNull(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}

/**
 * Branch names a review can target: local branches plus remote branches with
 * the remote prefix stripped (a remote-only pick materializes locally via
 * ensureLocalBranch). Deduped and sorted, HEAD pointers excluded.
 */
export async function listBranches(repoPath: string): Promise<string[]> {
  const [local, remote] = await Promise.all([
    gitOrNull(repoPath, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]),
    gitOrNull(repoPath, ["for-each-ref", "--format=%(refname:short)", "refs/remotes"]),
  ]);
  const names = new Set<string>();
  for (const line of (local ?? "").split("\n")) {
    const ref = line.trim();
    if (ref !== "") names.add(ref);
  }
  for (const line of (remote ?? "").split("\n")) {
    // Remote shortnames are "<remote>/<branch>"; strip the remote segment.
    const ref = line.trim();
    if (ref === "" || ref.endsWith("/HEAD")) continue;
    const slash = ref.indexOf("/");
    if (slash !== -1) names.add(ref.slice(slash + 1));
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** True when `branch` resolves as a local ref. */
export async function localBranchExists(repoPath: string, branch: string): Promise<boolean> {
  return (
    (await gitOrNull(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) !==
    null
  );
}

/**
 * Makes `branch` exist locally: no-op when present, else created from
 * `origin/<branch>` without a checkout. Throws when neither exists.
 */
export async function ensureLocalBranch(repoPath: string, branch: string): Promise<void> {
  if (await localBranchExists(repoPath, branch)) return;
  await git(repoPath, ["branch", "--no-track", branch, `origin/${branch}`]);
}

/**
 * Fetches a PR's head into a local branch named after its head ref and adds
 * a linked worktree for it under `~/.overfactor/worktrees`, so reviews (and
 * later, sessions) have a checkout of a collaborator's work. Idempotent:
 * existing branches are force-updated to the PR head unless checked out;
 * an existing worktree is reused.
 */
export async function createPrWorktree(
  repoPath: string,
  prNumber: number,
  headRef: string,
): Promise<{ branch: string; worktreePath: string }> {
  const branch = headRef;
  // fetch pull/N/head works for same-repo and fork PRs alike.
  try {
    await git(repoPath, ["fetch", "origin", `pull/${prNumber}/head:${branch}`, "--force"]);
  } catch (raised) {
    // A branch checked out somewhere cannot be force-updated; reuse as-is.
    if (!(await localBranchExists(repoPath, branch))) throw raised;
  }

  const worktreesRoot = join(overfactorDir(), "worktrees");
  await mkdir(worktreesRoot, { recursive: true });
  const repoBase = repoPath.split("/").filter(Boolean).at(-1) ?? "repo";
  const worktreePath = join(
    worktreesRoot,
    `${repoBase}-pr-${prNumber}-${branch.replaceAll(/[^\w.-]+/g, "-")}`,
  );

  const existing = await gitOrNull(worktreePath, ["rev-parse", "--is-inside-work-tree"]);
  if (existing === null) {
    await git(repoPath, ["worktree", "add", worktreePath, branch]);
  }
  return { branch, worktreePath };
}
