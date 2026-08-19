import { createDaemonClient } from "@overfactor/daemon/client";
import {
  agentIntegrationManifestSchema,
  type ChangeRequest,
  changeRequestSchema,
  continueConversationResponseSchema,
  type DaemonInfo,
  daemonInfoSchema,
  overfactorConfigSchema,
  repoBranchesResponseSchema,
  reviewModelsResponseSchema,
  reviewResponseSchema,
  type ReviewSettings,
  reviewSettingsSchema,
  type ReviewSubject,
  type Session,
  sessionDiffSchema,
  sessionSchema,
  sessionTranscriptSchema,
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
const errorResponseSchema = z.object({ error: z.string().optional() }).nullable();

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
        // A branch review's patch is computed from worktree state, so any
        // session/diff-stats change can stale it too.
        if (message.data.collection === "sessions") {
          void queryClient.invalidateQueries({ queryKey: ["reviews"] });
        }
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

/** Branch names a review can target (local + remote); for the track dialog. */
export function useRepoBranches(baseUrl: string, repoPath: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repos", baseUrl, "branches", repoPath],
    enabled,
    queryFn: async () => {
      const response = await createDaemonClient(baseUrl).repos.branches.$get({
        query: { path: repoPath },
      });
      if (!response.ok) throw new Error(`branch list failed (${response.status})`);
      return repoBranchesResponseSchema.parse(await response.json());
    },
  });
}

const trackedCrResponseSchema = z.object({ cr: changeRequestSchema });

/** Track a branch with no detected session; yields a CR (and so a review). */
export function useTrackBranch(baseUrl: string) {
  return useMutation({
    mutationFn: async ({
      repoPath,
      branch,
    }: {
      repoPath: string;
      branch: string;
    }): Promise<ChangeRequest> => {
      const response = await createDaemonClient(baseUrl).repos.branch.$post({
        json: { path: repoPath, branch },
      });
      if (!response.ok) {
        const parsed = errorResponseSchema.safeParse(await response.json().catch(() => null));
        throw new Error(
          (parsed.success ? parsed.data?.error : undefined) ??
            `branch tracking failed (${response.status})`,
        );
      }
      return trackedCrResponseSchema.parse(await response.json()).cr;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["crs"] }),
  });
}

/** Fetch a GitHub PR, create a worktree for it, and track it as a CR. */
export function useTrackPr(baseUrl: string) {
  return useMutation({
    mutationFn: async ({
      repoPath,
      url,
    }: {
      repoPath: string;
      url: string;
    }): Promise<ChangeRequest> => {
      const response = await createDaemonClient(baseUrl).repos.pr.$post({
        json: { path: repoPath, url },
      });
      if (!response.ok) {
        const parsed = errorResponseSchema.safeParse(await response.json().catch(() => null));
        throw new Error(
          (parsed.success ? parsed.data?.error : undefined) ??
            `PR tracking failed (${response.status})`,
        );
      }
      return trackedCrResponseSchema.parse(await response.json()).cr;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["crs"] }),
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

export function useSetSessionArchived(baseUrl: string) {
  return useMutation({
    mutationFn: async ({ sessionId, archived }: { sessionId: string; archived: boolean }) => {
      const response = await createDaemonClient(baseUrl).sessions[":id"].archive.$post({
        param: { id: sessionId },
        json: { archived },
      });
      if (!response.ok) throw new Error(`archive update failed (${response.status})`);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["sessions"] }),
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

/** Installed agent integrations and the optional capabilities each advertises. */
export function useAgentIntegrations(baseUrl: string) {
  return useQuery({
    queryKey: ["agents", baseUrl],
    queryFn: async () => {
      const response = await createDaemonClient(baseUrl).agents.$get();
      return z.array(agentIntegrationManifestSchema).parse(await response.json());
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** Persisted default engine/provider/model policy for guided reviews. */
export function useReviewSettings(baseUrl: string) {
  return useQuery({
    queryKey: ["settings", baseUrl, "review"],
    queryFn: async () => {
      const response = await createDaemonClient(baseUrl).settings.review.$get();
      if (!response.ok) throw new Error(`review settings failed (${response.status})`);
      return reviewSettingsSchema.parse(await response.json());
    },
  });
}

export function useUpdateReviewSettings(baseUrl: string) {
  return useMutation({
    mutationFn: async (settings: ReviewSettings) => {
      const response = await createDaemonClient(baseUrl).settings.review.$put({ json: settings });
      if (!response.ok) throw new Error(`review settings update failed (${response.status})`);
      return reviewSettingsSchema.parse(await response.json());
    },
    onSuccess: (settings) => queryClient.setQueryData(["settings", baseUrl, "review"], settings),
  });
}

/** Authenticated Pi models available for review generation. */
export function usePiReviewModels(baseUrl: string, enabled: boolean) {
  return useQuery({
    queryKey: ["agents", baseUrl, "pi", "models"],
    enabled,
    queryFn: async () => {
      const response = await createDaemonClient(baseUrl).agents[":agent"].models.$get({
        param: { agent: "pi" },
      });
      if (!response.ok) throw new Error(`Pi model list failed (${response.status})`);
      return reviewModelsResponseSchema.parse(await response.json()).models;
    },
  });
}

/** Change Requests from `GET /crs`; kept fresh by WS "crs" invalidations. */
export function useCrs(baseUrl: string) {
  return useQuery({
    queryKey: ["crs", baseUrl],
    queryFn: async () => {
      const response = await createDaemonClient(baseUrl).crs.$get();
      return z.array(changeRequestSchema).parse(await response.json());
    },
  });
}

/**
 * Transcript tail for one session, parsed by the daemon from the agent's own
 * transcript file. Lives under the "transcripts" queryKey prefix so the
 * daemon's transcript-file watcher invalidations refetch it.
 */
export function useSessionTranscript(baseUrl: string, session: Session) {
  return useQuery({
    // transcriptPath is part of the key: it can arrive after the first fetch
    // (session-start racing earlier events), and nothing else invalidates the
    // empty result in that case.
    queryKey: ["transcripts", baseUrl, session.id, session.transcriptPath],
    queryFn: async () => {
      const response = await createDaemonClient(baseUrl).sessions[":id"].transcript.$get({
        param: { id: session.id },
      });
      if (!response.ok) throw new Error(`transcript request failed (${response.status})`);
      return sessionTranscriptSchema.parse(await response.json());
    },
  });
}

/** Queue a user-authored prompt for a capable live agent integration. */
export function useContinueConversation(baseUrl: string) {
  return useMutation({
    mutationFn: async ({ sessionId, prompt }: { sessionId: string; prompt: string }) => {
      const response = await createDaemonClient(baseUrl).sessions[":id"].messages.$post({
        param: { id: sessionId },
        json: { prompt },
      });
      if (!response.ok) {
        const parsed = errorResponseSchema.safeParse(await response.json().catch(() => null));
        const error = parsed.success ? parsed.data?.error : undefined;
        throw new Error(error ?? `message delivery failed (${response.status})`);
      }
      continueConversationResponseSchema.parse(await response.json());
    },
  });
}

/**
 * The branch-level guided review (plus a fresh subject patch) for one
 * (repo, branch). Lives under the "reviews" queryKey prefix so the daemon's
 * WS "reviews" invalidations — emitted when generation starts, completes,
 * or fails — refetch it.
 */
export function useBranchReview(baseUrl: string, subject: ReviewSubject) {
  return useQuery({
    queryKey: ["reviews", baseUrl, subject.repoPath, subject.branch],
    queryFn: async () => {
      const response = await createDaemonClient(baseUrl).reviews.$get({ query: subject });
      if (!response.ok) throw new Error(`review request failed (${response.status})`);
      return reviewResponseSchema.parse(await response.json());
    },
  });
}

/** Trigger branch-review generation; rejections carry the daemon's outcome. */
export function useGenerateReview(baseUrl: string) {
  return useMutation({
    mutationFn: async ({ subject, model }: { subject: ReviewSubject; model: string | null }) => {
      const response = await createDaemonClient(baseUrl).reviews.generate.$post({
        json: model === null ? subject : { ...subject, model },
      });
      if (!response.ok) {
        const parsed = errorResponseSchema.safeParse(await response.json().catch(() => null));
        const error = parsed.success ? parsed.data?.error : undefined;
        throw new Error(error ?? `review generation failed (${response.status})`);
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["reviews"] }),
  });
}

/** Persist a per-group reviewed mark; survives restarts and regeneration. */
export function useMarkGroupReviewed(baseUrl: string) {
  return useMutation({
    mutationFn: async (input: { reviewId: number; group: string; reviewed: boolean }) => {
      const response = await createDaemonClient(baseUrl).reviews[":id"].groups.$post({
        param: { id: String(input.reviewId) },
        json: { group: input.group, reviewed: input.reviewed },
      });
      if (!response.ok) throw new Error(`reviewed mark failed (${response.status})`);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["reviews"] }),
  });
}

/** Manual session rename; wins over agent-generated and prompt titles. */
export function useRenameSession(baseUrl: string) {
  return useMutation({
    mutationFn: async ({ sessionId, title }: { sessionId: string; title: string }) => {
      const response = await createDaemonClient(baseUrl).sessions[":id"].title.$post({
        param: { id: sessionId },
        json: { title },
      });
      if (!response.ok) throw new Error(`rename failed (${response.status})`);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["sessions"] }),
  });
}
