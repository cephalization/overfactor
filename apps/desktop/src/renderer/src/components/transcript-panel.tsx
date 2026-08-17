import { agentSupportsCapability, type Session, type TranscriptEntry } from "@overfactor/sdk";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  MoreHorizontal,
  PanelRightClose,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { ConversationComposer } from "@/components/conversation-composer.tsx";
import { AGENT_LABELS } from "@/components/session-sidebar.tsx";
import { Bubble, BubbleContent } from "@/components/ui/bubble.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker.tsx";
import { Message, MessageContent, MessageHeader } from "@/components/ui/message.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { useAgentIntegrations, useSessionTranscript } from "@/lib/daemon.ts";
import { groupTranscriptEntries, summarizeToolCalls } from "@/lib/transcript-groups.ts";
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
          className="size-6 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/entry:opacity-100 data-[state=open]:opacity-100"
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

function CompactionEntry({ entry }: { entry: TranscriptEntry }) {
  const [expanded, setExpanded] = useState(false);
  const summary = entry.markdown.replace(/^_Session compacted\._\s*/, "");

  return (
    <section className="flex flex-col">
      <Marker
        variant="separator"
        asChild
        className="rounded-md py-1.5 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <button
          type="button"
          aria-expanded={expanded}
          title={`${expanded ? "Collapse" : "Expand"} compaction summary`}
          onClick={() => setExpanded((current) => !current)}
        >
          <MarkerIcon>
            {expanded ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
          </MarkerIcon>
          <MarkerContent className="whitespace-nowrap text-[11px] font-medium">
            Session compacted
          </MarkerContent>
        </button>
      </Marker>
      {expanded && (
        <Message className="group/entry mt-3 border-l border-border/70 pl-4">
          <MessageContent className="gap-1.5">
            <MessageHeader className="gap-2 px-1 text-[11px]">
              <span className="font-medium text-muted-foreground">Compaction summary</span>
              <span className="flex-1" />
              <EntryMenu entry={entry} />
            </MessageHeader>
            <Bubble variant="ghost">
              <BubbleContent className="w-full text-[13px] leading-6 text-foreground/80">
                <Streamdown className="space-y-3" controls={false}>
                  {summary}
                </Streamdown>
              </BubbleContent>
            </Bubble>
          </MessageContent>
        </Message>
      )}
    </section>
  );
}

function ConversationEntry({ entry, session }: { entry: TranscriptEntry; session: Session }) {
  if (entry.role === "system") {
    return entry.markdown.startsWith("_Session compacted._") ? (
      <CompactionEntry entry={entry} />
    ) : (
      <Marker variant="separator" className="py-2 text-xs">
        <MarkerContent className="max-w-[85%] text-pretty">{plainContent(entry)}</MarkerContent>
      </Marker>
    );
  }

  if (entry.role === "tool") {
    const phase = entry.toolPhase === "result" ? "Output" : "Input";
    return (
      <Message className="group/entry">
        <MessageContent className="gap-1.5">
          <MessageHeader className="gap-2 px-1 text-[11px]">
            <span className="font-medium text-foreground/75">{entry.toolName ?? "Tool"}</span>
            <span className="text-muted-foreground/70">{phase}</span>
            <span className="flex-1" />
            <EntryMenu entry={entry} />
          </MessageHeader>
          <Bubble variant="outline" className="w-full max-w-full">
            <BubbleContent className="transcript-tool w-full bg-muted/20 px-3 py-2.5 text-xs leading-5 text-foreground/80 [&_[data-streamdown='code-block-body']]:max-h-56 [&_[data-streamdown='code-block-body']]:overflow-y-auto">
              <Streamdown className="space-y-2" controls={false}>
                {entry.markdown}
              </Streamdown>
            </BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
    );
  }

  const isUser = entry.role === "user";
  const label = isUser ? "You" : AGENT_LABELS[session.agent];

  return (
    <Message align={isUser ? "end" : "start"} className="group/entry">
      <MessageContent className="gap-1.5">
        <MessageHeader className={cn("gap-2 text-[11px]", isUser && "justify-end")}>
          <span className="font-medium text-muted-foreground">{label}</span>
          {!isUser && <span className="flex-1" />}
          <EntryMenu entry={entry} />
        </MessageHeader>
        <Bubble
          align={isUser ? "end" : "start"}
          variant={isUser ? "secondary" : "ghost"}
          className={cn(isUser && "max-w-[90%]")}
        >
          <BubbleContent
            className={cn(
              "text-[13.5px] leading-6",
              isUser ? "px-3.5 py-2.5" : "w-full text-foreground/90",
            )}
          >
            <Streamdown className="space-y-3" controls={false}>
              {entry.markdown}
            </Streamdown>
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}

function ToolGroup({
  calls,
  entries,
  session,
}: {
  calls: TranscriptEntry[];
  entries: TranscriptEntry[];
  session: Session;
}) {
  const [expanded, setExpanded] = useState(false);
  const summary = summarizeToolCalls(calls);
  const callLabel = `${calls.length} tool ${calls.length === 1 ? "call" : "calls"}`;

  return (
    <section className="flex flex-col">
      <Marker
        variant="separator"
        asChild
        className={cn(
          "rounded-md py-1.5 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
          expanded && "sticky -top-6 z-20 bg-background py-2 shadow-sm",
        )}
      >
        <button
          type="button"
          aria-expanded={expanded}
          title={`${expanded ? "Collapse" : "Expand"} ${callLabel}`}
          onClick={() => setExpanded((current) => !current)}
        >
          <MarkerIcon>
            {expanded ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
          </MarkerIcon>
          <MarkerContent className="whitespace-nowrap text-[11px] font-medium">
            {summary}
          </MarkerContent>
        </button>
      </Marker>
      {expanded && (
        <div className="mt-3 flex flex-col gap-5 border-l border-border/70 pl-4">
          {entries.map((entry) => (
            <ConversationEntry key={entry.id} entry={entry} session={session} />
          ))}
        </div>
      )}
    </section>
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
  const integrations = useAgentIntegrations(baseUrl);
  const canContinue =
    session.state !== "ended" &&
    agentSupportsCapability(integrations.data ?? [], session.agent, "continue-conversation");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedToBottom = useRef(true);

  const entryCount = transcript.data?.entries.length ?? 0;
  const renderItems = groupTranscriptEntries(
    transcript.data?.entries ?? [],
    session.state === "working" || session.state === "blocked",
  );
  useEffect(() => {
    const container = scrollRef.current;
    if (container !== null && pinnedToBottom.current) {
      container.scrollTop = container.scrollHeight;
    }
  }, [entryCount]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-4">
        <Button variant="ghost" size="sm" onClick={onCollapse} title="Hide transcript">
          <PanelRightClose />
          Transcript
        </Button>

        <div className="ml-auto flex min-w-0 items-center gap-2">
          <span
            className="max-w-40 truncate font-mono text-[10px] text-muted-foreground"
            title={session.model ?? "Model not reported"}
          >
            {session.model ?? "Model not reported"}
          </span>
          {transcript.data !== undefined && transcript.data.totalCount > entryCount && (
            <span className="shrink-0 text-[10px] text-muted-foreground">
              last {entryCount} of {transcript.data.totalCount}
            </span>
          )}
        </div>
      </div>
      <div
        ref={scrollRef}
        onScroll={(event) => {
          const el = event.currentTarget;
          pinnedToBottom.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
        }}
        className="transcript-prose min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-5 py-6 [overflow-wrap:anywhere]"
      >
        <div className="mx-auto w-full max-w-3xl">
          {transcript.isPending ? (
            <div className="flex flex-col gap-4">
              <Skeleton className="h-20 w-4/5 self-end rounded-xl" />
              <Skeleton className="h-28 w-full rounded-xl" />
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
            <div className="flex flex-col gap-7">
              {renderItems.map((item) =>
                item.type === "entry" ? (
                  <ConversationEntry key={item.entry.id} entry={item.entry} session={session} />
                ) : (
                  <ToolGroup
                    key={item.id}
                    calls={item.calls}
                    entries={item.entries}
                    session={session}
                  />
                ),
              )}
            </div>
          )}
        </div>
      </div>
      {canContinue && <ConversationComposer key={session.id} baseUrl={baseUrl} session={session} />}
    </div>
  );
}
