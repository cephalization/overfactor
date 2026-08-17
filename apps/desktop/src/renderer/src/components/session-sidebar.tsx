import type { ChangeRequest, LifecycleState, Session } from "@overfactor/sdk";
import { Archive, ArchiveRestore, FolderPlus, GitBranch, X } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar.tsx";
import { filterSidebarSessions, groupSidebarItems } from "@/lib/sidebar-groups.ts";
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

const SESSION_STATES: LifecycleState[] = ["working", "idle", "blocked", "ended"];

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
  onSetArchived,
}: {
  sessions: Session[];
  crs: ChangeRequest[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onSetArchived: (id: string, archived: boolean) => void;
} & RepoSectionProps) {
  const [visibleStates, setVisibleStates] = useState<Set<LifecycleState>>(
    () => new Set(SESSION_STATES),
  );
  const [showArchived, setShowArchived] = useState(false);
  const visibleSessions = filterSidebarSessions(sessions, visibleStates, showArchived);
  const repoGroups = groupSidebarItems(repos, visibleSessions, crs);

  const toggleState = (state: LifecycleState) => {
    setVisibleStates((current) => {
      const next = new Set(current);
      if (next.has(state)) next.delete(state);
      else next.add(state);
      return next;
    });
  };

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
        <div className="flex items-center gap-1 border-t border-sidebar-border pt-2">
          {SESSION_STATES.map((state) => {
            const visible = visibleStates.has(state);
            const style = STATE_STYLES[state];
            return (
              <Tooltip key={state}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-pressed={visible}
                    className={cn(
                      "flex size-7 items-center justify-center rounded-md text-sidebar-foreground/50 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                      visible ? "bg-sidebar-accent" : "opacity-40",
                    )}
                    onClick={() => toggleState(state)}
                  >
                    <span className={cn("size-2.5 rounded-full", style.dot)} />
                    <span className="sr-only">{style.label}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={4}>
                  {visible ? "Hide" : "Show"} {style.label.toLowerCase()} chats
                </TooltipContent>
              </Tooltip>
            );
          })}
          <span className="mx-1 h-4 w-px bg-sidebar-border" aria-hidden="true" />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-pressed={showArchived}
                className={cn(
                  "flex size-7 items-center justify-center rounded-md text-sidebar-foreground/50 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                  showArchived ? "bg-sidebar-accent text-sidebar-accent-foreground" : "opacity-60",
                )}
                onClick={() => setShowArchived((current) => !current)}
              >
                <Archive className="size-3.5" />
                <span className="sr-only">Archived chats</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {showArchived ? "Hide" : "Show"} archived chats
            </TooltipContent>
          </Tooltip>
        </div>
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
                  className="top-2.5 right-4 size-7 w-7"
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
                      <SessionMenu
                        sessions={crSessions}
                        selectedId={selectedId}
                        onSelect={onSelect}
                        onSetArchived={onSetArchived}
                      />
                    )}
                  </div>
                ))}
                {repo.branchGroups.map((branchGroup) => (
                  <div key={`branch:${branchGroup.branch ?? ""}`} className="space-y-1">
                    <div className="flex h-7 items-center gap-1.5 px-2 text-xs text-sidebar-foreground/70">
                      <GitBranch className="size-3.5 shrink-0" />
                      <span className="truncate font-medium">{branchGroup.label}</span>
                    </div>
                    <SessionMenu
                      sessions={branchGroup.sessions}
                      selectedId={selectedId}
                      onSelect={onSelect}
                      onSetArchived={onSetArchived}
                    />
                  </div>
                ))}
                {repo.crGroups.length === 0 && repo.branchGroups.length === 0 && (
                  <p className="px-2 py-2 text-xs text-muted-foreground">
                    {sessions.some((session) => session.repoPath === repo.path)
                      ? "No chats match the current filters."
                      : "No sessions yet. Start an agent in this repo."}
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
  onSetArchived,
}: {
  sessions: Session[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onSetArchived: (id: string, archived: boolean) => void;
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
                <span className="flex items-center gap-1">
                  <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                    {AGENT_LABELS[session.agent]}
                  </Badge>
                  {session.archived && (
                    <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                      Archived
                    </Badge>
                  )}
                </span>
                <DiffStats session={session} />
              </span>
              <span
                className="w-full truncate pl-4 font-mono text-[10px] text-sidebar-foreground/55"
                title={session.model ?? "Model not reported"}
              >
                {session.model ?? "Model not reported"}
              </span>
            </SidebarMenuButton>
            <SidebarMenuAction
              showOnHover
              className="top-1 right-2 size-7 w-7"
              title={session.archived ? "Unarchive chat" : "Archive chat"}
              aria-label={session.archived ? "Unarchive chat" : "Archive chat"}
              onClick={(event) => {
                event.stopPropagation();
                onSetArchived(session.id, !session.archived);
              }}
            >
              {session.archived ? <ArchiveRestore /> : <Archive />}
            </SidebarMenuAction>
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}
