import type { ChangeRequest, LifecycleState, Session } from "@overfactor/sdk";
import { FolderPlus, GitBranch, X } from "lucide-react";
import { Badge } from "@/components/ui/badge.tsx";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar.tsx";
import { groupSidebarItems } from "@/lib/sidebar-groups.ts";
import { cn } from "@/lib/utils.ts";

export const STATE_STYLES: Record<LifecycleState, { label: string; dot: string }> = {
  working: { label: "Working", dot: "bg-emerald-500 animate-pulse" },
  idle: { label: "Idle", dot: "bg-zinc-400" },
  blocked: { label: "Blocked", dot: "bg-amber-500" },
  ended: { label: "Ended", dot: "bg-zinc-300" },
};

export const AGENT_LABELS: Record<Session["agent"], string> = {
  "claude-code": "Claude Code",
  pi: "pi",
};

export function DiffStats({ session }: { session: Session }) {
  if (session.diff === null) return null;
  const { filesChanged, insertions, deletions } = session.diff;
  return (
    <span className="flex items-center gap-1.5 font-mono text-xs">
      <span className="text-emerald-600 dark:text-emerald-400">+{insertions}</span>
      <span className="text-red-600 dark:text-red-400">−{deletions}</span>
      <span className="text-muted-foreground">
        {filesChanged} {filesChanged === 1 ? "file" : "files"}
      </span>
    </span>
  );
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

export interface RepoSectionProps {
  repos: string[];
  onAddRepo: () => void;
  onRemoveRepo: (path: string) => void;
  addRepoError: string | null;
}

export function SessionSidebar({
  sessions,
  crs,
  selectedId,
  onSelect,
  repos,
  onAddRepo,
  onRemoveRepo,
  addRepoError,
}: {
  sessions: Session[];
  crs: ChangeRequest[];
  selectedId: string | null;
  onSelect: (id: string) => void;
} & RepoSectionProps) {
  const repoGroups = groupSidebarItems(repos, sessions, crs);

  return (
    <Sidebar>
      <SidebarHeader className="gap-1 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold tracking-tight">Overfactor</span>
          <button
            type="button"
            className="flex size-7 items-center justify-center rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none"
            title="Track a repo"
            onClick={onAddRepo}
          >
            <FolderPlus className="size-4" />
            <span className="sr-only">Track a repo</span>
          </button>
        </div>
        {addRepoError !== null && <p className="text-xs text-destructive">{addRepoError}</p>}
      </SidebarHeader>
      <SidebarContent>
        {repoGroups.length === 0 ? (
          <SidebarGroup>
            <SidebarGroupContent>
              <p className="px-2 py-4 text-xs text-muted-foreground">
                No repos tracked yet — add one to start watching sessions.
              </p>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : (
          repoGroups.map((repo) => (
            <SidebarGroup key={repo.path}>
              <SidebarGroupLabel className="text-sm font-semibold" title={repo.path}>
                <span className="truncate">{basename(repo.path)}</span>
              </SidebarGroupLabel>
              {repo.tracked && (
                <SidebarGroupAction
                  title={`Stop tracking ${basename(repo.path)}`}
                  onClick={() => onRemoveRepo(repo.path)}
                >
                  <X />
                  <span className="sr-only">Stop tracking {basename(repo.path)}</span>
                </SidebarGroupAction>
              )}
              <SidebarGroupContent className="space-y-3">
                {repo.crGroups.map(({ cr, sessions: crSessions }) => (
                  <div key={`cr:${cr.id}`} className="space-y-1">
                    <div
                      className="flex h-7 items-center gap-1.5 px-2 text-xs text-sidebar-foreground/70"
                      title={`${cr.branch} · ${cr.repoPath}`}
                    >
                      <span className="shrink-0 font-semibold">CR-{cr.id}</span>
                      <span className="truncate">· {cr.title}</span>
                    </div>
                    {crSessions.length === 0 ? (
                      <p className="px-4 py-1 text-xs text-muted-foreground">No sessions</p>
                    ) : (
                      <div className="pl-2">
                        <SessionMenu
                          sessions={crSessions}
                          selectedId={selectedId}
                          onSelect={onSelect}
                        />
                      </div>
                    )}
                  </div>
                ))}
                {repo.branchGroups.map((branchGroup) => (
                  <div key={`branch:${branchGroup.branch ?? ""}`} className="space-y-1">
                    <div className="flex h-7 items-center gap-1.5 px-2 text-xs text-sidebar-foreground/70">
                      <GitBranch className="size-3.5 shrink-0" />
                      <span className="truncate font-medium">{branchGroup.label}</span>
                    </div>
                    <div className="pl-2">
                      <SessionMenu
                        sessions={branchGroup.sessions}
                        selectedId={selectedId}
                        onSelect={onSelect}
                      />
                    </div>
                  </div>
                ))}
                {repo.crGroups.length === 0 && repo.branchGroups.length === 0 && (
                  <p className="px-2 py-2 text-xs text-muted-foreground">
                    No sessions yet. Start an agent in this repo.
                  </p>
                )}
              </SidebarGroupContent>
            </SidebarGroup>
          ))
        )}
      </SidebarContent>
    </Sidebar>
  );
}

function SessionMenu({
  sessions,
  selectedId,
  onSelect,
}: {
  sessions: Session[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <SidebarMenu>
      {sessions.map((session) => {
        const state = STATE_STYLES[session.state];
        return (
          <SidebarMenuItem key={session.id}>
            <SidebarMenuButton
              className="h-auto flex-col items-start gap-1 py-2"
              isActive={session.id === selectedId}
              onClick={() => onSelect(session.id)}
            >
              <span className="flex w-full items-center gap-2">
                <span
                  className={cn("size-2 shrink-0 rounded-full", state.dot)}
                  aria-label={state.label}
                />
                <span className="truncate text-sm font-medium">
                  {session.title ?? "Untitled session"}
                </span>
              </span>
              <span className="flex w-full items-center justify-between gap-2 pl-4">
                <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                  {AGENT_LABELS[session.agent]}
                </Badge>
                <DiffStats session={session} />
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}
