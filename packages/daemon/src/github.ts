import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Octokit } from "octokit";
import { z } from "zod";
import type { Logger } from "./logger.ts";

const execFileAsync = promisify(execFile);

/**
 * GitHub access piggybacks the user's `gh` login (no auth UX, same posture
 * as the review engine's `claude -p`): token from `gh auth token`, all API
 * calls through octokit. Absent/broken gh degrades to "no PR features".
 */

export interface PullRequestInfo {
  number: number;
  title: string;
  state: "open" | "merged" | "closed";
  url: string;
  /** The PR's head branch name (without the fork owner prefix). */
  headRef: string;
}

export interface GithubClient {
  listOpenPulls: (owner: string, repo: string) => Promise<PullRequestInfo[]>;
  getPull: (owner: string, repo: string, number: number) => Promise<PullRequestInfo | null>;
}

export interface GithubRepo {
  owner: string;
  repo: string;
}

/** "git@github.com:o/r.git" or "https://github.com/o/r(.git)" → {o, r}. */
export function parseGithubRemote(url: string): GithubRepo | null {
  const match =
    /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(url.trim()) ??
    /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  if (match?.[1] === undefined || match[2] === undefined) return null;
  return { owner: match[1], repo: match[2] };
}

/** "https://github.com/o/r/pull/7" (query/fragment/subpage tolerated) → parts. */
export function parsePullUrl(url: string): (GithubRepo & { number: number }) | null {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(
    url.trim(),
  );
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) return null;
  return { owner: match[1], repo: match[2], number: Number.parseInt(match[3], 10) };
}

/** The repo's `origin` remote parsed as a GitHub repo, or null. */
export async function githubOrigin(repoPath: string): Promise<GithubRepo | null> {
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], {
      cwd: repoPath,
    });
    return parseGithubRemote(stdout);
  } catch {
    return null;
  }
}

const pullSchema = z.looseObject({
  number: z.int().positive(),
  title: z.string(),
  state: z.enum(["open", "closed"]),
  merged_at: z.string().nullable().optional(),
  html_url: z.string(),
  head: z.looseObject({ ref: z.string() }),
});

function toPullInfo(pull: z.infer<typeof pullSchema>): PullRequestInfo {
  return {
    number: pull.number,
    title: pull.title,
    state: pull.state === "open" ? "open" : (pull.merged_at ?? null) !== null ? "merged" : "closed",
    url: pull.html_url,
    headRef: pull.head.ref,
  };
}

/** Octokit-backed client, or null when `gh` is missing or not logged in. */
export async function createGithubClient(log?: Logger): Promise<GithubClient | null> {
  let token: string;
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"]);
    token = stdout.trim();
    if (token === "") throw new Error("empty token");
  } catch {
    log?.info("gh auth token unavailable — PR detection disabled");
    return null;
  }
  const octokit = new Octokit({ auth: token });
  return {
    listOpenPulls: async (owner, repo) => {
      const response = await octokit.rest.pulls.list({
        owner,
        repo,
        state: "open",
        per_page: 100,
      });
      return response.data.map((pull) => toPullInfo(pullSchema.parse(pull)));
    },
    getPull: async (owner, repo, number) => {
      try {
        const response = await octokit.rest.pulls.get({ owner, repo, pull_number: number });
        return toPullInfo(pullSchema.parse(response.data));
      } catch {
        return null;
      }
    },
  };
}
