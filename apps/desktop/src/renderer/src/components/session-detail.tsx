import type { ReviewSubject, Session } from "@overfactor/sdk";
import { GitBranch, PanelRightOpen, Pencil } from "lucide-react";
import { useState } from "react";
import { SessionDiff } from "@/components/session-diff.tsx";
import { AGENT_LABELS, DiffStats, STATE_STYLES } from "@/components/session-sidebar.tsx";
import { TranscriptPanel } from "@/components/transcript-panel.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Separator } from "@/components/ui/separator.tsx";
import { useRenameSession } from "@/lib/daemon.ts";
import { cn } from "@/lib/utils.ts";

/**
 * Inline-editable session title: click the pencil (or double-click the
 * title), Enter saves, Escape cancels. Manual renames win over agent titles.
 */
function EditableTitle({ baseUrl, session }: { baseUrl: string; session: Session }) {
  const rename = useRenameSession(baseUrl);
  const [draft, setDraft] = useState<string | null>(null);

  if (draft !== null) {
    const commit = (): void => {
      const title = draft.trim();
      if (title !== "" && title !== session.title) {
        rename.mutate({ sessionId: session.id, title });
      }
      setDraft(null);
    };
    return (
      <Input
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") setDraft(null);
        }}
        onBlur={() => setDraft(null)}
        className="h-9 max-w-xl text-xl font-semibold tracking-tight md:text-xl"
      />
    );
  }

  return (
    <div className="group flex items-center gap-2">
      <h1
        className="cursor-text text-xl font-semibold tracking-tight"
        onDoubleClick={() => setDraft(session.title ?? "")}
        title="Double-click to rename"
      >
        {session.title ?? "Untitled session"}
      </h1>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 opacity-0 transition-opacity group-hover:opacity-100"
        onClick={() => setDraft(session.title ?? "")}
        title="Rename session"
      >
        <Pencil />
        <span className="sr-only">Rename session</span>
      </Button>
    </div>
  );
}

/**
 * One session's detail: its own worktree diff on the left, the live
 * transcript in a resizable panel on the right. The guided review lives at
 * the branch level — "View review" jumps to it.
 */
export function SessionDetail({
  baseUrl,
  session,
  onOpenReview,
}: {
  baseUrl: string;
  session: Session;
  onOpenReview: (subject: ReviewSubject) => void;
}) {
  const state = STATE_STYLES[session.state];
  const [transcriptOpen, setTranscriptOpen] = useState(true);

  return (
    <ResizablePanelGroup orientation="horizontal" className="h-full">
      <ResizablePanel defaultSize={62} minSize={35}>
        <div className="h-full overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[110rem] flex-col gap-4 p-6">
            <div className="flex flex-col gap-2">
              <EditableTitle baseUrl={baseUrl} session={session} />
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className={cn("size-2 rounded-full", state.dot)} />
                <span className="text-sm text-muted-foreground">{state.label}</span>
                <Badge variant="outline">{AGENT_LABELS[session.agent]}</Badge>
                <DiffStats session={session} />
                <span className="font-mono text-xs text-muted-foreground" title={session.cwd}>
                  {session.repoPath}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {session.branch !== null && (
                <Button
                  variant="ghost"
                  size="sm"
                  title={`Open the guided review of ${session.branch}`}
                  onClick={() =>
                    session.branch !== null &&
                    onOpenReview({ repoPath: session.repoPath, branch: session.branch })
                  }
                >
                  <GitBranch />
                  View review
                </Button>
              )}
              {!transcriptOpen && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  onClick={() => setTranscriptOpen(true)}
                  title="Show transcript"
                >
                  <PanelRightOpen />
                  Transcript
                </Button>
              )}
            </div>
            <Separator />
            <SessionDiff baseUrl={baseUrl} session={session} />
          </div>
        </div>
      </ResizablePanel>
      {transcriptOpen && (
        <>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={38} minSize={20}>
            <TranscriptPanel
              baseUrl={baseUrl}
              session={session}
              onCollapse={() => setTranscriptOpen(false)}
            />
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  );
}
