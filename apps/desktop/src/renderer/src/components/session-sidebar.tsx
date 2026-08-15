import type { LifecycleState, Session } from "@overfactor/sdk";
import { FolderPlus, X } from "lucide-react";
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
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar.tsx";
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

function RepoSection({ repos, onAddRepo, onRemoveRepo, addRepoError }: RepoSectionProps) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Repos</SidebarGroupLabel>
      <SidebarGroupAction title="Track a repo" onClick={onAddRepo}>
        <FolderPlus />
        <span className="sr-only">Track a repo</span>
      </SidebarGroupAction>
      <SidebarGroupContent>
        {repos.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            No repos tracked yet — add one to start watching sessions.
          </p>
        ) : (
          <SidebarMenu>
            {repos.map((repo) => (
              <SidebarMenuItem key={repo}>
                <SidebarMenuButton title={repo}>
                  <span className="truncate text-sm">{basename(repo)}</span>
                </SidebarMenuButton>
                <SidebarMenuAction
                  title={`Stop tracking ${basename(repo)}`}
                  onClick={() => onRemoveRepo(repo)}
                >
                  <X />
                  <span className="sr-only">Stop tracking {basename(repo)}</span>
                </SidebarMenuAction>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        )}
        {addRepoError !== null && (
          <p className="px-2 py-1 text-xs text-destructive">{addRepoError}</p>
        )}
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

export function SessionSidebar({
  sessions,
  selectedId,
  onSelect,
  ...repoProps
}: {
  sessions: Session[];
  selectedId: string | null;
  onSelect: (id: string) => void;
} & RepoSectionProps) {
  return (
    <Sidebar>
      <SidebarHeader className="px-4 py-3">
        <span className="text-sm font-semibold tracking-tight">Overfactor</span>
      </SidebarHeader>
      <SidebarContent>
        <RepoSection {...repoProps} />
        <SidebarGroup>
          <SidebarGroupLabel>Sessions</SidebarGroupLabel>
          <SidebarGroupContent>
            {sessions.length === 0 ? (
              <p className="px-2 py-4 text-xs text-muted-foreground">
                No sessions yet. Start an agent in a tracked repo.
              </p>
            ) : (
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
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
