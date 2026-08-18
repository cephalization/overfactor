import type { ChangeRequest, LifecycleState, ReviewSubject, Session } from "@overfactor/sdk";
import type { Selection } from "@/app.tsx";
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  FolderPlus,
  GitBranch,
  GitBranchPlus,
  GitPullRequestArrow,
  X,
} from "lucide-react";
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
import { TrackBranchDialog } from "@/components/track-branch-dialog.tsx";
import { filterSidebarSessions, groupSidebarItems } from "@/lib/sidebar-groups.ts";
import { cn } from "@/lib/utils.ts";

export const STATE_STYLES = {
  working: { label: "Working", dot: "bg-emerald-500 animate-pulse" },
  idle: { label: "Idle", dot: "bg-zinc-400" },
  blocked: { label: "Blocked", dot: "bg-amber-500" },
  ended: { label: "Ended", dot: "bg-zinc-300" },
} satisfies Record<LifecycleState, { label: string; dot: string }>;

export const AGENT_LABELS = {
  "claude-code": "Claude Code",
  pi: "pi",
} satisfies Record<Session["agent"], string>;

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

/**
 * A selectable branch/CR header row: clicking opens the branch's guided
 * review in the main pane, making review a first-class navigation peer of
 * sessions.
 */
function ReviewRowButton({
  active,
  title,
  onClick,
  children,
}: {
  active: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "group/review flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        active && "bg-sidebar-accent text-sidebar-accent-foreground",
      )}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
      {/* Sized like SidebarGroupAction (size-7) so the chevron's glyph sits
          in the same column as the repo row's ✕ icon button above it. */}
      <span className="flex size-7 shrink-0 items-center justify-center">
        <ChevronRight className="size-3.5 text-sidebar-foreground/40 transition-colors group-hover/review:text-sidebar-accent-foreground" />
      </span>
    </button>
  );
}

/** GitHub PR state → badge tint. */
const PR_BADGE_STYLES = {
  open: "border-emerald-600/50 text-emerald-600 dark:border-emerald-400/50 dark:text-emerald-400",
  merged: "border-purple-600/50 text-purple-600 dark:border-purple-400/50 dark:text-purple-400",
  closed: "border-red-600/50 text-red-600 dark:border-red-400/50 dark:text-red-400",
} satisfies Record<string, string>;

function prBadgeStyle(state: string | null): string {
  if (state === null || !(state in PR_BADGE_STYLES)) return "text-sidebar-foreground/60";
  // SAFETY: the `in` check above guarantees `state` is a PR_BADGE_STYLES key.
  return PR_BADGE_STYLES[state as keyof typeof PR_BADGE_STYLES];
}

function PrBadge({ cr }: { cr: ChangeRequest }) {
  if (cr.prNumber === null) return null;
  const url = cr.prUrl;
  return (
    <span
      role="link"
      title={`${cr.prState ?? "PR"} — open on GitHub`}
      className={cn(
        "ml-auto shrink-0 rounded-full border px-1.5 font-mono text-[10px]",
        prBadgeStyle(cr.prState),
      )}
      onClick={(event) => {
        event.stopPropagation();
        // Routed to shell.openExternal by the main process.
        if (url !== null) window.open(url);
      }}
    >
      #{cr.prNumber}
    </span>
  );
}

export function SessionSidebar({
  baseUrl,
  sessions,
  crs,
  selection,
  onSelect,
  onSelectReview,
  repos,
  onAddRepo,
  onRemoveRepo,
  addRepoError,
  onSetArchived,
}: {
  baseUrl: string;
  sessions: Session[];
  crs: ChangeRequest[];
  selection: Selection | null;
  onSelect: (id: string) => void;
  onSelectReview: (subject: ReviewSubject) => void;
  onSetArchived: (id: string, archived: boolean) => void;
} & RepoSectionProps) {
  const [trackRepo, setTrackRepo] = useState<string | null>(null);
  const selectedId = selection?.kind === "session" ? selection.id : null;
  const reviewActive = (subject: ReviewSubject): boolean =>
    selection?.kind === "review" &&
    selection.subject.repoPath === subject.repoPath &&
    selection.subject.branch === subject.branch;
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
                <>
                  <SidebarGroupAction
                    className="top-2.5 right-11 size-7 w-7"
                    title="Track a branch or PR"
                    onClick={() => setTrackRepo(repo.path)}
                  >
                    <GitBranchPlus />
                    <span className="sr-only">Track a branch or PR in {basename(repo.path)}</span>
                  </SidebarGroupAction>
                  <SidebarGroupAction
                    className="top-2.5 right-4 size-7 w-7"
                    title={`Stop tracking ${basename(repo.path)}`}
                    onClick={() => onRemoveRepo(repo.path)}
                  >
                    <X />
                    <span className="sr-only">Stop tracking {basename(repo.path)}</span>
                  </SidebarGroupAction>
                </>
              )}
              <SidebarGroupContent className="space-y-3">
                {repo.crGroups.map(({ cr, sessions: crSessions }) => (
                  <div key={`cr:${cr.id}`} className="space-y-1">
                    <ReviewRowButton
                      active={reviewActive({ repoPath: cr.repoPath, branch: cr.branch })}
                      title={`Review ${cr.branch} · ${cr.repoPath}`}
                      onClick={() => onSelectReview({ repoPath: cr.repoPath, branch: cr.branch })}
                    >
                      <GitPullRequestArrow className="size-3.5 shrink-0" />
                      <span className="shrink-0 font-semibold">CR-{cr.id}</span>
                      <span className="truncate">· {cr.title}</span>
                      <PrBadge cr={cr} />
                    </ReviewRowButton>
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
                    {branchGroup.branch === null ? (
                      <div className="flex h-7 items-center gap-1.5 px-2 text-xs text-sidebar-foreground/70">
                        <GitBranch className="size-3.5 shrink-0" />
                        <span className="truncate font-medium">{branchGroup.label}</span>
                      </div>
                    ) : (
                      <ReviewRowButton
                        active={reviewActive({ repoPath: repo.path, branch: branchGroup.branch })}
                        title={`Review ${branchGroup.branch} · ${repo.path}`}
                        onClick={() =>
                          onSelectReview({ repoPath: repo.path, branch: branchGroup.branch ?? "" })
                        }
                      >
                        <GitBranch className="size-3.5 shrink-0" />
                        <span className="truncate font-medium">{branchGroup.label}</span>
                      </ReviewRowButton>
                    )}
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
      <TrackBranchDialog
        baseUrl={baseUrl}
        repoPath={trackRepo}
        onOpenChange={(open) => {
          if (!open) setTrackRepo(null);
        }}
        onTracked={onSelectReview}
      />
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
                <span className="flex size-3.5 shrink-0 items-center justify-center">
                  <span className={cn("size-2 rounded-full", state.dot)} aria-label={state.label} />
                </span>
                <span className="truncate text-sm font-medium">
                  {session.title ?? "Untitled session"}
                </span>
              </span>
              <span className="flex w-full items-center justify-between gap-2 pl-[1.375rem]">
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
                className="w-full truncate pl-[1.375rem] font-mono text-[10px] text-sidebar-foreground/55"
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
