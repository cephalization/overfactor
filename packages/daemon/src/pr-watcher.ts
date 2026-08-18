import type { ReviewSubject } from "@overfactor/sdk";
import { z } from "zod";
import type { GithubClient, GithubRepo } from "./github.ts";
import type { Logger } from "./logger.ts";
import type { SessionStore } from "./store.ts";

/**
 * Stamps GitHub PR identity onto tracked Change Requests. Deliberately scoped
 * to branches Overfactor already knows (CR rows) rather than every open PR in
 * the repo — the sidebar should not flood with the whole team's PRs. When a
 * CR first gains a PR, the review auto-generates: the PR moment is exactly
 * when the walkthrough should be waiting.
 */
const raisedErrorSchema = z.unknown().transform((raised): Error => {
  if (raised instanceof Error) return raised;
  const message = z.string().safeParse(raised);
  return new Error(message.success ? message.data : "unknown error", { cause: raised });
});

export interface PrWatcherDeps {
  store: SessionStore;
  github: GithubClient;
  /** Tracked repo paths (live view of the config). */
  repos: () => string[];
  /** The repo's parsed GitHub origin; null skips the repo. */
  originFor: (repoPath: string) => Promise<GithubRepo | null>;
  /** Called when a CR gains a PR it did not have (auto-generate hook). */
  onPrDetected?: (subject: ReviewSubject) => void;
  log?: Logger;
}

export class PrWatcher {
  constructor(private readonly deps: PrWatcherDeps) {}

  async scan(): Promise<void> {
    for (const repoPath of this.deps.repos()) {
      try {
        await this.scanRepo(repoPath);
      } catch (raised) {
        this.deps.log?.warn(
          { repoPath, error: raisedErrorSchema.parse(raised).message },
          "PR scan failed",
        );
      }
    }
  }

  private async scanRepo(repoPath: string): Promise<void> {
    const crs = this.deps.store.listChangeRequests().filter((cr) => cr.repoPath === repoPath);
    if (crs.length === 0) return;
    const origin = await this.deps.originFor(repoPath);
    if (origin === null) return;

    const openPulls = await this.deps.github.listOpenPulls(origin.owner, origin.repo);
    const openByBranch = new Map(openPulls.map((pull) => [pull.headRef, pull]));

    for (const cr of crs) {
      const open = openByBranch.get(cr.branch);
      if (open !== undefined) {
        const newlyAttached = this.deps.store.setChangeRequestPr(cr.id, {
          number: open.number,
          state: open.state,
          url: open.url,
        });
        if (newlyAttached) {
          this.deps.log?.info(
            { repoPath, branch: cr.branch, pr: open.number },
            "PR detected for tracked branch",
          );
          this.deps.onPrDetected?.({ repoPath, branch: cr.branch });
        }
        continue;
      }
      // A stamped PR that is no longer open resolved to merged or closed.
      if (cr.prNumber !== null && cr.prState === "open") {
        const resolved = await this.deps.github.getPull(origin.owner, origin.repo, cr.prNumber);
        if (resolved !== null && resolved.state !== "open") {
          this.deps.store.setChangeRequestPr(cr.id, {
            number: resolved.number,
            state: resolved.state,
            url: resolved.url,
          });
        }
      }
    }
  }
}
