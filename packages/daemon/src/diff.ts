import { execFile } from "node:child_process";
import fsPromises from "node:fs/promises";
import { promisify } from "node:util";
import type { DiffStats } from "@overfactor/sdk";
import { createGit, durableFileSystemFromNodeFs, type NodeFsPromises } from "just-git";

const execFileAsync = promisify(execFile);

const fs = durableFileSystemFromNodeFs(fsPromises as unknown as NodeFsPromises);

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
 * `git diff HEAD --numstat` of the worktree containing `cwd`. Covers staged +
 * unstaged changes to tracked files; untracked files are not counted (matches
 * `git diff` semantics).
 *
 * Primary path is just-git (pure TS). Known upstream gap: just-git v2 errors
 * with EISDIR on repos containing submodule gitlinks, so any just-git failure
 * falls back to system git (present on any machine running coding agents).
 * Drop the fallback once upstream diffs gitlinks. Returns null when stats
 * cannot be computed either way (not a repo, no commits yet) — callers keep
 * the previous value rather than showing zeros.
 */
export async function computeDiffStats(cwd: string): Promise<DiffStats | null> {
  const git = createGit({ fs, cwd });
  const result = await git.exec("diff HEAD --numstat");
  if (result.exitCode === 0) return parseNumstat(result.stdout);

  try {
    const { stdout } = await execFileAsync("git", ["diff", "HEAD", "--numstat"], {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
    });
    return parseNumstat(stdout);
  } catch {
    return null;
  }
}

/**
 * The full `git diff HEAD` patch of the worktree containing `cwd` — same
 * scope and fallback behavior as computeDiffStats. Computed on demand (per
 * request), never persisted.
 */
export async function computeDiffPatch(cwd: string): Promise<string | null> {
  const git = createGit({ fs, cwd });
  const result = await git.exec("diff HEAD");
  if (result.exitCode === 0) return result.stdout;

  try {
    const { stdout } = await execFileAsync("git", ["diff", "HEAD"], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}
