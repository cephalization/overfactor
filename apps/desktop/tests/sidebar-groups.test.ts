import type { ChangeRequest, Session } from "@overfactor/sdk";
import { describe, expect, it } from "vitest";
import {
  filterSidebarSessions,
  groupSidebarItems,
} from "../src/renderer/src/lib/sidebar-groups.ts";

const NOW = "2026-08-16T12:00:00.000Z";

function session({
  id,
  repoPath,
  ...input
}: Partial<Session> & Pick<Session, "id" | "repoPath">): Session {
  return {
    agent: "pi",
    model: "gpt-5.6-sol",
    title: id,
    state: "idle",
    cwd: repoPath,
    transcriptPath: null,
    branch: "main",
    crId: null,
    archived: false,
    diff: null,
    startedAt: NOW,
    updatedAt: NOW,
    ...input,
    id,
    repoPath,
  };
}

function cr({
  id,
  repoPath,
  ...input
}: Partial<ChangeRequest> & Pick<ChangeRequest, "id" | "repoPath">): ChangeRequest {
  return {
    branch: "feature/sidebar",
    title: "sidebar",
    prNumber: null,
    prState: null,
    prUrl: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...input,
    id,
    repoPath,
  };
}

describe("groupSidebarItems", () => {
  it("uses repos as the top-level hierarchy and keeps empty tracked repos", () => {
    const groups = groupSidebarItems(
      ["/repos/alpha", "/repos/empty"],
      [session({ id: "main-1", repoPath: "/repos/alpha" })],
      [],
    );

    expect(groups.map((group) => group.path)).toEqual(["/repos/alpha", "/repos/empty"]);
    expect(groups[0]?.branchGroups[0]).toMatchObject({ branch: "main", label: "main" });
    expect(groups[0]?.branchGroups[0]?.sessions.map((item) => item.id)).toEqual(["main-1"]);
    expect(groups[1]).toMatchObject({ tracked: true, crGroups: [], branchGroups: [] });
  });

  it("places CR sessions and ordinary branch sessions under the same repo", () => {
    const request = cr({ id: 7, repoPath: "/repos/alpha" });
    const groups = groupSidebarItems(
      ["/repos/alpha"],
      [
        session({ id: "cr-session", repoPath: "/repos/alpha", branch: request.branch, crId: 7 }),
        session({ id: "main-session", repoPath: "/repos/alpha" }),
        session({ id: "detached", repoPath: "/repos/alpha", branch: null }),
      ],
      [request],
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.crGroups[0]?.sessions.map((item) => item.id)).toEqual(["cr-session"]);
    expect(groups[0]?.branchGroups.map((group) => group.label)).toEqual([
      "main",
      "Detached / unknown",
    ]);
  });

  it("retains historical sessions from repos that are no longer tracked", () => {
    const request = cr({ id: 9, repoPath: "/repos/old" });
    const groups = groupSidebarItems(
      [],
      [session({ id: "old-session", repoPath: "/repos/old", crId: request.id })],
      [request],
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ path: "/repos/old", tracked: false });
    expect(groups[0]?.crGroups[0]?.cr.id).toBe(9);
    expect(groups[0]?.crGroups[0]?.sessions[0]?.id).toBe("old-session");
  });

  it("filters session states and hides archived sessions by default", () => {
    const sessions = [
      session({ id: "working", repoPath: "/repos/alpha", state: "working" }),
      session({ id: "idle", repoPath: "/repos/alpha", state: "idle" }),
      session({ id: "archived", repoPath: "/repos/alpha", archived: true }),
    ];

    expect(
      filterSidebarSessions(sessions, new Set(["working"]), false).map((item) => item.id),
    ).toEqual(["working"]);
    expect(filterSidebarSessions(sessions, new Set(["idle"]), true).map((item) => item.id)).toEqual(
      ["idle", "archived"],
    );
  });

  it("does not place a session beneath a CR belonging to another repo", () => {
    const groups = groupSidebarItems(
      ["/repos/alpha", "/repos/beta"],
      [session({ id: "session", repoPath: "/repos/alpha", branch: "feature/local", crId: 3 })],
      [cr({ id: 3, repoPath: "/repos/beta" })],
    );

    expect(groups[0]?.crGroups).toEqual([]);
    expect(groups[0]?.branchGroups[0]?.sessions[0]?.id).toBe("session");
    // The CR stays visible under its own repo with no sessions — manually
    // tracked branches and fetched PRs are exactly this session-less case.
    expect(groups[1]?.crGroups.map((group) => group.cr.id)).toEqual([3]);
    expect(groups[1]?.crGroups[0]?.sessions).toEqual([]);
  });
});
