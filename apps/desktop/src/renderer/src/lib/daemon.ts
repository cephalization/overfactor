import { createDaemonClient } from "@overfactor/daemon/client";
import {
  type DaemonInfo,
  daemonInfoSchema,
  overfactorConfigSchema,
  type Session,
  sessionDiffSchema,
  sessionSchema,
  wsServerMessageSchema,
} from "@overfactor/sdk";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/react-db";
import { QueryClient, useMutation, useQuery } from "@tanstack/react-query";
import ReconnectingWebSocket from "partysocket/ws";
import { useEffect, useState } from "react";
import { z } from "zod";

export const queryClient = new QueryClient();

const POLL_INTERVAL_MS = 2000;

/**
 * Polls the main process for daemon.json (validated — it's a file off disk).
 * Keeps polling after discovery so daemon restarts and port changes are
 * picked up; state only updates when the identity actually changes.
 */
export function useDaemonInfo(): DaemonInfo | null {
  const [info, setInfo] = useState<DaemonInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let current: DaemonInfo | null = null;

    const poll = async (): Promise<void> => {
      const parsed = daemonInfoSchema.nullable().safeParse(await window.overfactor.getDaemonInfo());
      if (cancelled) return;
      const next = parsed.success ? parsed.data : null;
      if (next?.port !== current?.port || next?.pid !== current?.pid) {
        current = next;
        setInfo(next);
      }
      timer = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };
    void poll();

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  return info;
}

export type SessionsCollection = ReturnType<typeof createSessionsCollection>;

/**
 * TanStack DB collection over `GET /sessions`, loaded via queryCollection as
 * prescribed; freshness comes from WS invalidations (see
 * useSessionInvalidation), not from a custom sync implementation.
 */
export function createSessionsCollection(baseUrl: string) {
  const client = createDaemonClient(baseUrl);
  return createCollection(
    queryCollectionOptions({
      queryKey: ["sessions", baseUrl],
      queryClient,
      queryFn: async () =>
        z.array(sessionSchema).parse(await (await client.sessions.$get()).json()),
      getKey: (session: Session) => session.id,
    }),
  );
}

/** Reconnecting WS subscription; daemon "invalidate" messages refetch queries. */
export function useSessionInvalidation(port: number): void {
  useEffect(() => {
    const socket = new ReconnectingWebSocket(`ws://127.0.0.1:${port}/ws`);
    socket.addEventListener("message", (event) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const message = wsServerMessageSchema.safeParse(raw);
      if (message.success && message.data.type === "invalidate") {
        void queryClient.invalidateQueries({ queryKey: [message.data.collection] });
      }
    });
    return () => socket.close();
  }, [port]);
}

const pickedDirectorySchema = z.string().min(1).nullable();

/** Tracked repos from `GET /repos`; kept fresh by WS "repos" invalidations. */
export function useRepos(baseUrl: string) {
  return useQuery({
    queryKey: ["repos", baseUrl],
    queryFn: async () => {
      const response = await createDaemonClient(baseUrl).repos.$get();
      return overfactorConfigSchema.parse(await response.json()).repos;
    },
  });
}

/**
 * Opens the native directory picker, then tracks the chosen repo via the
 * daemon. Resolves to the tracked path, or null when the picker is cancelled.
 * Throws when the daemon rejects the directory (not a git repo).
 */
export function useAddRepo(baseUrl: string) {
  return useMutation({
    mutationFn: async (): Promise<string | null> => {
      const path = pickedDirectorySchema.parse(await window.overfactor.pickDirectory());
      if (path === null) return null;
      const response = await createDaemonClient(baseUrl).repos.$post({ json: { path } });
      if (!response.ok) {
        throw new Error(`Not a git repo: ${path}`);
      }
      return path;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["repos"] }),
  });
}

export function useRemoveRepo(baseUrl: string) {
  return useMutation({
    mutationFn: async (path: string) => {
      await createDaemonClient(baseUrl).repos.$delete({ json: { path } });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["repos"] }),
  });
}

/**
 * Full patch for one session, computed by the daemon on demand. The queryKey
 * lives under the "sessions" prefix on purpose: the daemon's WS "sessions"
 * invalidation (any session/diff-stats change) refetches it too.
 */
export function useSessionDiff(baseUrl: string, sessionId: string) {
  return useQuery({
    queryKey: ["sessions", baseUrl, "diff", sessionId],
    queryFn: async () => {
      const response = await createDaemonClient(baseUrl).sessions[":id"].diff.$get({
        param: { id: sessionId },
      });
      if (!response.ok) throw new Error(`diff request failed (${response.status})`);
      return sessionDiffSchema.parse(await response.json());
    },
  });
}
