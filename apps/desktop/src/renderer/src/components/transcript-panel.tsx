import type { Session, TranscriptEntry } from "@overfactor/sdk";
import { Copy, Download, MoreHorizontal, PanelRightClose } from "lucide-react";
import { useEffect, useRef } from "react";
import { Streamdown } from "streamdown";
import { AGENT_LABELS } from "@/components/session-sidebar.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { useSessionTranscript } from "@/lib/daemon.ts";
import { cn } from "@/lib/utils.ts";

const NEAR_BOTTOM_PX = 120;

/** Raw entry content: tool entries are fence-wrapped server-side — unwrap. */
function plainContent(entry: TranscriptEntry): string {
  const fenced = /^```[a-z]*\n([\s\S]*?)\n```$/.exec(entry.markdown);
  return fenced?.[1] ?? entry.markdown;
}

/** Copy/download live behind this menu to keep the entries themselves quiet. */
function EntryMenu({ entry }: { entry: TranscriptEntry }) {
  const download = (): void => {
    const blob = new Blob([plainContent(entry)], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${entry.toolName ?? entry.role}-${entry.id.replaceAll(/[^a-zA-Z0-9-]/g, "")}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/entry:opacity-100 data-[state=open]:opacity-100"
          title="Entry actions"
        >
          <MoreHorizontal />
          <span className="sr-only">Entry actions</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => void navigator.clipboard.writeText(plainContent(entry))}>
          <Copy /> Copy content
        </DropdownMenuItem>
        <DropdownMenuItem onClick={download}>
          <Download /> Download
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function EntryHeader({ entry, session }: { entry: TranscriptEntry; session: Session }) {
  if (entry.role === "tool") {
    return (
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] text-muted-foreground">
          {entry.toolName ?? "tool"}
        </span>
        <div className="h-px flex-1 bg-border" />
        <EntryMenu entry={entry} />
      </div>
    );
  }
  const label =
    entry.role === "user" ? "You" : entry.role === "assistant" ? AGENT_LABELS[session.agent] : "";
  return (
    <div className="flex items-center gap-2">
      {label !== "" && (
        <span
          className={cn(
            "text-xs font-semibold",
            entry.role === "assistant" ? "text-primary" : "text-muted-foreground",
          )}
        >
          {label}
        </span>
      )}
      <div className="flex-1" />
      <EntryMenu entry={entry} />
    </div>
  );
}

/**
 * Live transcript of the selected session, parsed by the daemon from the
 * agent's transcript file and kept fresh by "transcripts" WS invalidations.
 * Sticks to the bottom while the user is near it; leaves them alone when
 * they've scrolled up to read.
 */
export function TranscriptPanel({
  baseUrl,
  session,
  onCollapse,
}: {
  baseUrl: string;
  session: Session;
  onCollapse: () => void;
}) {
  const transcript = useSessionTranscript(baseUrl, session);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedToBottom = useRef(true);

  const entryCount = transcript.data?.entries.length ?? 0;
  useEffect(() => {
    const container = scrollRef.current;
    if (container !== null && pinnedToBottom.current) {
      container.scrollTop = container.scrollHeight;
    }
  }, [entryCount]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <Button variant="ghost" size="sm" onClick={onCollapse} title="Show transcript">
          <PanelRightClose />
          Transcript
        </Button>

        {transcript.data !== undefined && transcript.data.totalCount > entryCount && (
          <span className="ml-auto text-[10px] text-muted-foreground">
            last {entryCount} of {transcript.data.totalCount}
          </span>
        )}
      </div>
      <div
        ref={scrollRef}
        onScroll={(event) => {
          const el = event.currentTarget;
          pinnedToBottom.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
        }}
        className="transcript-prose min-h-0 flex-1 overflow-y-auto px-3 py-3"
      >
        {transcript.isPending ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : transcript.isError ? (
          <p className="text-sm text-destructive">
            Could not load the transcript: {transcript.error.message}
          </p>
        ) : transcript.data.entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No transcript yet
            {session.transcriptPath === null
              ? " — the agent has not reported a transcript file"
              : ""}
            .
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {transcript.data.entries.map((entry) => (
              <div key={entry.id} className="group/entry flex flex-col gap-1">
                <EntryHeader entry={entry} session={session} />
                <div
                  className={cn(
                    "min-w-0 text-sm",
                    entry.role === "tool" && "opacity-70 [&_pre]:max-h-40 [&_pre]:overflow-y-auto",
                    entry.role === "system" && "text-muted-foreground",
                  )}
                >
                  <Streamdown controls={false}>{entry.markdown}</Streamdown>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
