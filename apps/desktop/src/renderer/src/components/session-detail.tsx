import type { Session } from "@overfactor/sdk";
import { AGENT_LABELS, DiffStats, STATE_STYLES } from "@/components/session-sidebar.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Separator } from "@/components/ui/separator.tsx";
import { cn } from "@/lib/utils.ts";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className="font-mono text-sm break-all">{children}</span>
    </div>
  );
}

/**
 * Everything the daemon knows about one session. Grows into the review
 * surface (diff viewer, transcript) in later slices.
 */
export function SessionDetail({ session }: { session: Session }) {
  const state = STATE_STYLES[session.state];
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold tracking-tight">
          {session.title ?? "Untitled session"}
        </h1>
        <div className="flex items-center gap-2">
          <span className={cn("size-2 rounded-full", state.dot)} />
          <span className="text-sm text-muted-foreground">{state.label}</span>
          <Badge variant="outline">{AGENT_LABELS[session.agent]}</Badge>
          <DiffStats session={session} />
        </div>
      </div>
      <Separator />
      <div className="grid grid-cols-1 gap-4">
        <Field label="Session ID">{session.id}</Field>
        <Field label="Repo">{session.repoPath}</Field>
        {session.cwd !== session.repoPath && <Field label="Working directory">{session.cwd}</Field>}
        {session.transcriptPath !== null && (
          <Field label="Transcript">{session.transcriptPath}</Field>
        )}
        <Field label="Started">{new Date(session.startedAt).toLocaleString()}</Field>
        <Field label="Last activity">{new Date(session.updatedAt).toLocaleString()}</Field>
      </div>
      <Separator />
      <p className="text-sm text-muted-foreground">
        Diff review and the live transcript land here in a later slice.
      </p>
    </div>
  );
}
