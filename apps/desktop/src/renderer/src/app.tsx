import type { DaemonInfo } from "@overfactor/sdk";
import { useLiveQuery } from "@tanstack/react-db";
import { useMemo, useState } from "react";
import { SessionDetail } from "@/components/session-detail.tsx";
import { SessionSidebar } from "@/components/session-sidebar.tsx";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar.tsx";
import {
  createSessionsCollection,
  useAddRepo,
  useCrs,
  useDaemonInfo,
  useRemoveRepo,
  useRepos,
  useSessionInvalidation,
} from "@/lib/daemon.ts";

export function App() {
  const info = useDaemonInfo();
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
  const collection = useMemo(() => createSessionsCollection(baseUrl), [baseUrl]);
  const { data: sessions } = useLiveQuery(
    (q) => q.from({ session: collection }).orderBy(({ session }) => session.startedAt, "desc"),
    [collection],
  );
  const repos = useRepos(baseUrl);
  const crs = useCrs(baseUrl);
  const addRepo = useAddRepo(baseUrl);
  const removeRepo = useRemoveRepo(baseUrl);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = (sessions ?? []).find((session) => session.id === selectedId) ?? null;

  return (
    <SidebarProvider>
      <SessionSidebar
        sessions={sessions ?? []}
        crs={crs.data ?? []}
        selectedId={selectedId}
        onSelect={setSelectedId}
        repos={repos.data ?? []}
        onAddRepo={() => addRepo.mutate()}
        onRemoveRepo={(path) => removeRepo.mutate(path)}
        addRepoError={addRepo.error?.message ?? null}
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
          {selected !== null ? (
            <SessionDetail baseUrl={baseUrl} session={selected} />
          ) : (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-muted-foreground">Select a session to see its details.</p>
            </div>
          )}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
