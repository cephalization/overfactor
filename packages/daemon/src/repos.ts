import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readOverfactorConfig, writeOverfactorConfig } from "@overfactor/sdk/node";

/**
 * Tracked-repo mutations on `~/.overfactor/config.json`. The daemon's HTTP
 * API and the CLI both go through here; the daemon additionally watches the
 * file, so CLI edits apply to a running daemon too.
 */

export type AddRepoResult = { ok: true; repos: string[] } | { ok: false; reason: "not-a-git-repo" };

export async function isGitRepo(path: string): Promise<boolean> {
  const gitEntry = await stat(join(path, ".git")).catch(() => null);
  return gitEntry !== null;
}

/** Validates and tracks a repo. Adding an already-tracked repo is a no-op success. */
export async function addRepo(path: string): Promise<AddRepoResult> {
  const repoPath = resolve(path);
  if (!(await isGitRepo(repoPath))) {
    return { ok: false, reason: "not-a-git-repo" };
  }
  const config = await readOverfactorConfig();
  if (!config.repos.includes(repoPath)) {
    config.repos.push(repoPath);
    await writeOverfactorConfig(config);
  }
  return { ok: true, repos: config.repos };
}

/** Untracks a repo. Removing an unknown path is a no-op. */
export async function removeRepo(path: string): Promise<{ repos: string[] }> {
  const repoPath = resolve(path);
  const config = await readOverfactorConfig();
  const remaining = config.repos.filter((repo) => repo !== repoPath);
  if (remaining.length !== config.repos.length) {
    await writeOverfactorConfig({ ...config, repos: remaining });
  }
  return { repos: remaining };
}
