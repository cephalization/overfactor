import type { ChangeRequest, Session } from "@overfactor/sdk";

export interface SidebarCrGroup {
  cr: ChangeRequest;
  sessions: Session[];
}

export interface SidebarBranchGroup {
  branch: string | null;
  label: string;
  sessions: Session[];
}

export interface SidebarRepoGroup {
  path: string;
  tracked: boolean;
  crGroups: SidebarCrGroup[];
  branchGroups: SidebarBranchGroup[];
}

/**
 * Builds the repo-first sidebar hierarchy. CRs remain durable branch-backed
 * units, while sessions without a CR are still visually grouped by branch
 * (including the default branch) under their repo.
 */
export function groupSidebarItems(
  repos: string[],
  sessions: Session[],
  crs: ChangeRequest[],
): SidebarRepoGroup[] {
  const trackedRepos = new Set(repos);
  const repoPaths = new Set(repos);
  for (const session of sessions) repoPaths.add(session.repoPath);
  for (const cr of crs) repoPaths.add(cr.repoPath);

  return [...repoPaths].map((path) => {
    const repoSessions = sessions.filter((session) => session.repoPath === path);
    const repoCrs = crs.filter((cr) => cr.repoPath === path);
    const repoCrIds = new Set(repoCrs.map((cr) => cr.id));
    const crGroups = repoCrs.map((cr) => ({
      cr,
      sessions: repoSessions.filter((session) => session.crId === cr.id),
    }));

    const byBranch = new Map<string | null, Session[]>();
    for (const session of repoSessions) {
      if (session.crId !== null && repoCrIds.has(session.crId)) continue;
      byBranch.set(session.branch, [...(byBranch.get(session.branch) ?? []), session]);
    }

    return {
      path,
      tracked: trackedRepos.has(path),
      crGroups,
      branchGroups: [...byBranch].map(([branch, branchSessions]) => ({
        branch,
        label: branch ?? "Detached / unknown",
        sessions: branchSessions,
      })),
    };
  });
}
