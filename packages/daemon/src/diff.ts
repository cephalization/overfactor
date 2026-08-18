import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DiffStats } from "@overfactor/sdk";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Worktree git reads go through system git in a subprocess. This supersedes
 * the pure-TS just-git path for the daemon's hot loop: on a 7.2k-file repo
 * just-git's diff costs ~1.5s and ~660MB peak RSS in-process vs system git's
 * ~40ms/~10MB, and it misreports committed symlinks as modified
 * (https://github.com/blindmansion/just-git/issues/4). just-git remains
 * vendored for the sandbox slice (worktree creation, embeddable server).
 * System git is a safe requirement: these machines run git-based coding
 * agents by definition.
 */
async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: MAX_BUFFER });
    return stdout;
  } catch {
    return null;
  }
}

function parseNumstat(stdout: string): DiffStats {
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const [added, removed] = line.split("\t");
    filesChanged += 1;
    // Binary files report "-" for both counts.
    const addedCount = Number.parseInt(added ?? "", 10);
    const removedCount = Number.parseInt(removed ?? "", 10);
    if (!Number.isNaN(addedCount)) insertions += addedCount;
    if (!Number.isNaN(removedCount)) deletions += removedCount;
  }
  return { filesChanged, insertions, deletions };
}

/**
 * `git diff HEAD --numstat` of the worktree containing `cwd`: staged +
 * unstaged changes to tracked files (untracked files are not counted).
 * Returns null when stats cannot be computed (not a repo, no commits yet) —
 * callers keep the previous value rather than showing zeros.
 */
export async function computeDiffStats(cwd: string): Promise<DiffStats | null> {
  const stdout = await git(cwd, ["diff", "--no-ext-diff", "HEAD", "--numstat"]);
  return stdout === null ? null : parseNumstat(stdout);
}

/**
 * The full `git diff HEAD` patch of the worktree containing `cwd` — same
 * scope as computeDiffStats. Computed on demand (per request), never
 * persisted.
 */
export async function computeDiffPatch(cwd: string): Promise<string | null> {
  // --no-ext-diff: users may configure diff.external (difftastic etc.), which
  // replaces the unified patch with tool output the renderer cannot parse.
  return git(cwd, ["diff", "--no-ext-diff", "HEAD"]);
}

/**
 * Branch checked out in the worktree containing `cwd`; null for a detached
 * HEAD or outside a repo. This is the automatic Change Request grouping key.
 */
export async function currentBranch(cwd: string): Promise<string | null> {
  const stdout = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (stdout === null) return null;
  const branch = stdout.trim();
  return branch === "" || branch === "HEAD" ? null : branch;
}

/**
 * The repo's default branch (what sessions must diverge from to form a CR).
 * Prefers origin/HEAD, falls back to local main/master, then null.
 */
export async function defaultBranch(repoPath: string): Promise<string | null> {
  const originHead = await git(repoPath, ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"]);
  if (originHead !== null) {
    const name = originHead.trim().replace(/^origin\//, "");
    if (name !== "") return name;
  }
  for (const candidate of ["main", "master"]) {
    const exists = await git(repoPath, ["show-ref", "--verify", `refs/heads/${candidate}`]);
    if (exists !== null) return candidate;
  }
  return null;
}

/**
 * Root of the MAIN worktree for the repo containing `cwd`. For a linked
 * worktree (`git worktree add`) this is the primary checkout the worktree
 * belongs to — the path users track. Null outside repos or for bare repos.
 */
export async function mainWorktreeRoot(cwd: string): Promise<string | null> {
  const stdout = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (stdout === null) return null;
  const commonDir = stdout.trim();
  if (!commonDir.endsWith("/.git")) return null;
  return commonDir.slice(0, -"/.git".length);
}

/**
 * Committed changes of a CR branch relative to the repo's default branch
 * (three-dot: merge-base to branch tip). The CR review subject combines this
 * with the uncommitted worktree patch of a live session on the branch.
 */
export async function computeBranchPatch(
  repoPath: string,
  baseBranch: string,
  branch: string,
): Promise<string | null> {
  return git(repoPath, ["diff", "--no-ext-diff", `${baseBranch}...${branch}`]);
}
