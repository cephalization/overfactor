import type { ReviewSubject } from "@overfactor/sdk";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import type { GithubClient, PullRequestInfo } from "../src/github.ts";
import { PrWatcher } from "../src/pr-watcher.ts";
import { SessionStore } from "../src/store.ts";

function pull(partial: Partial<PullRequestInfo> & { number: number }): PullRequestInfo {
  return {
    title: `PR ${partial.number}`,
    state: "open",
    url: `https://github.com/o/r/pull/${partial.number}`,
    headRef: "feat/x",
    ...partial,
  };
}

function fakeGithub(open: PullRequestInfo[], byNumber: PullRequestInfo[] = []): GithubClient {
  const resolved = new Map(byNumber.map((p) => [p.number, p]));
  return {
    listOpenPulls: () => Promise.resolve(open),
    getPull: (_owner, _repo, number) => Promise.resolve(resolved.get(number) ?? null),
  };
}

function makeWatcher(store: SessionStore, github: GithubClient, detected: ReviewSubject[]) {
  return new PrWatcher({
    store,
    github,
    repos: () => ["/repo"],
    originFor: async () => ({ owner: "o", repo: "r" }),
    onPrDetected: (subject) => detected.push(subject),
  });
}

describe("PrWatcher", () => {
  it("stamps open PRs onto matching CRs and fires the detection hook once", async () => {
    const store = new SessionStore(openDb(":memory:"));
    store.ensureChangeRequest("/repo", "feat/x");
    const detected: ReviewSubject[] = [];
    const watcher = makeWatcher(store, fakeGithub([pull({ number: 7 })]), detected);

    await watcher.scan();
    const [cr] = store.listChangeRequests();
    expect(cr).toMatchObject({ prNumber: 7, prState: "open" });
    expect(detected).toEqual([{ repoPath: "/repo", branch: "feat/x" }]);

    // Re-scanning identical state neither re-fires the hook nor churns rows.
    await watcher.scan();
    expect(detected).toHaveLength(1);
  });

  it("resolves a stamped PR that left the open list to merged", async () => {
    const store = new SessionStore(openDb(":memory:"));
    const cr = store.ensureChangeRequest("/repo", "feat/x");
    store.setChangeRequestPr(cr.id, { number: 7, state: "open", url: "u" });
    const detected: ReviewSubject[] = [];
    const watcher = makeWatcher(
      store,
      fakeGithub([], [pull({ number: 7, state: "merged" })]),
      detected,
    );

    await watcher.scan();
    expect(store.listChangeRequests()[0]).toMatchObject({ prNumber: 7, prState: "merged" });
    // State transitions never re-fire detection (no surprise regeneration).
    expect(detected).toEqual([]);
  });

  it("ignores open PRs for branches Overfactor is not tracking", async () => {
    const store = new SessionStore(openDb(":memory:"));
    store.ensureChangeRequest("/repo", "feat/x");
    const detected: ReviewSubject[] = [];
    const watcher = makeWatcher(
      store,
      fakeGithub([pull({ number: 9, headRef: "someone-elses-branch" })]),
      detected,
    );

    await watcher.scan();
    expect(store.listChangeRequests()[0]?.prNumber).toBeNull();
    expect(store.listChangeRequests()).toHaveLength(1);
    expect(detected).toEqual([]);
  });
});
