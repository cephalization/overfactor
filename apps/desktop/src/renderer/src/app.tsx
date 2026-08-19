import type { DaemonInfo, ReviewSubject } from "@overfactor/sdk";
import { useLiveQuery } from "@tanstack/react-db";
import { useMemo, useState } from "react";
import { BranchReview } from "@/components/branch-review.tsx";
import { Onboarding } from "@/components/onboarding.tsx";
import { ReviewSettingsPage } from "@/components/review-settings.tsx";
import { SessionDetail } from "@/components/session-detail.tsx";
import { SessionSidebar } from "@/components/session-sidebar.tsx";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar.tsx";
import {
  createSessionsCollection,
  useAddRepo,
  useCrs,
  useDaemonInfo,
  useOnboardingSettings,
  useRemoveRepo,
  useRepos,
  useSessionInvalidation,
  useSetSessionArchived,
} from "@/lib/daemon.ts";

/** What the main pane shows: a session, a branch review, or global settings. */
export type Selection =
  | { kind: "session"; id: string }
  | { kind: "review"; subject: ReviewSubject }
  | { kind: "settings" };

export function App() {
  const info = useDaemonInfo();
  const onboarding = useOnboardingSettings();

  if (onboarding.isLoading) {
    return (
      <div className="flex h-svh items-center justify-center">
        <div className="size-5 animate-spin rounded-full border-2 border-muted border-t-foreground" />
      </div>
    );
  }
  if (onboarding.data?.completed !== true) return <Onboarding />;
  if (info === null) return <DaemonOffline />;
  return <Connected key={`${info.pid}:${info.port}`} info={info} />;
}

function DaemonOffline() {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-2">
      <p className="text-lg font-medium">Daemon not running</p>
      <p className="text-sm text-muted-foreground">
        Start it with{" "}
        <code className="rounded bg-muted px-1.5 py-0.5">overfactor daemon start</code>
        {" — "}this window connects automatically.
      </p>
    </div>
  );
}

function Connected({ info }: { info: DaemonInfo }) {
  const baseUrl = `http://127.0.0.1:${info.port}`;
  useSessionInvalidation(info.port);
  return <Workspace info={info} baseUrl={baseUrl} />;
}

function Workspace({ info, baseUrl }: { info: DaemonInfo; baseUrl: string }) {
  const collection = useMemo(() => createSessionsCollection(baseUrl), [baseUrl]);
  const { data: sessions } = useLiveQuery(
    (q) => q.from({ session: collection }).orderBy(({ session }) => session.startedAt, "desc"),
    [collection],
  );
  const repos = useRepos(baseUrl);
  const crs = useCrs(baseUrl);
  const addRepo = useAddRepo(baseUrl);
  const removeRepo = useRemoveRepo(baseUrl);
  const setSessionArchived = useSetSessionArchived(baseUrl);
  const [selection, setSelection] = useState<Selection | null>(null);

  const selectedSession =
    selection?.kind === "session"
      ? ((sessions ?? []).find((session) => session.id === selection.id) ?? null)
      : null;
  const reviewSubject = selection?.kind === "review" ? selection.subject : null;
  const reviewCrTitle =
    reviewSubject === null
      ? null
      : ((crs.data ?? []).find(
          (cr) => cr.repoPath === reviewSubject.repoPath && cr.branch === reviewSubject.branch,
        )?.title ?? null);

  const openReview = (subject: ReviewSubject) => setSelection({ kind: "review", subject });

  return (
    <SidebarProvider>
      <SessionSidebar
        baseUrl={baseUrl}
        sessions={sessions ?? []}
        crs={crs.data ?? []}
        selection={selection}
        onSelect={(id) => setSelection({ kind: "session", id })}
        onSelectReview={openReview}
        onOpenSettings={() => setSelection({ kind: "settings" })}
        repos={repos.data ?? []}
        onAddRepo={() => addRepo.mutate()}
        onRemoveRepo={(path) => removeRepo.mutate(path)}
        addRepoError={addRepo.error?.message ?? null}
        onSetArchived={(sessionId, archived) => setSessionArchived.mutate({ sessionId, archived })}
      />
      {/* Viewport-bound so the detail view's panels (diff / transcript)
          scroll independently. The diff pane is its own scroll container —
          position:sticky (file tree, group summaries) binds to it. */}
      <SidebarInset className="h-svh overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger />
          <span className="text-sm text-muted-foreground">
            Connected to daemon on port {info.port}
          </span>
        </header>
        <main className="min-h-0 flex-1">
          {selectedSession !== null ? (
            <SessionDetail baseUrl={baseUrl} session={selectedSession} onOpenReview={openReview} />
          ) : reviewSubject !== null ? (
            <BranchReview baseUrl={baseUrl} subject={reviewSubject} crTitle={reviewCrTitle} />
          ) : selection?.kind === "settings" ? (
            <ReviewSettingsPage baseUrl={baseUrl} />
          ) : (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-muted-foreground">
                Select a session or a branch to see its details.
              </p>
            </div>
          )}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
