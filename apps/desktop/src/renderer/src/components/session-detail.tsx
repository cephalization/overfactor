import type { Session } from "@overfactor/sdk";
import { SessionDiff } from "@/components/session-diff.tsx";
import { AGENT_LABELS, DiffStats, STATE_STYLES } from "@/components/session-sidebar.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Separator } from "@/components/ui/separator.tsx";
import { cn } from "@/lib/utils.ts";

/**
 * The review surface for one session: header with identity and lifecycle,
 * then the live diff of its worktree. The transcript joins in a later slice.
 */
export function SessionDetail({ baseUrl, session }: { baseUrl: string; session: Session }) {
  const state = STATE_STYLES[session.state];
  return (
    // Fluid up to a cap chosen for split diffs: ~2×85-col panes plus the
    // file tree (~110rem). Unified mode just enjoys the extra room.
    <div className="mx-auto flex w-full max-w-[110rem] flex-col gap-5 p-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold tracking-tight">
          {session.title ?? "Untitled session"}
        </h1>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={cn("size-2 rounded-full", state.dot)} />
          <span className="text-sm text-muted-foreground">{state.label}</span>
          <Badge variant="outline">{AGENT_LABELS[session.agent]}</Badge>
          <DiffStats session={session} />
          <span className="font-mono text-xs text-muted-foreground" title={session.cwd}>
            {session.repoPath}
          </span>
          <span className="text-xs text-muted-foreground">
            · active {new Date(session.updatedAt).toLocaleTimeString()}
          </span>
        </div>
      </div>
      <Separator />
      <SessionDiff baseUrl={baseUrl} session={session} />
    </div>
  );
}
