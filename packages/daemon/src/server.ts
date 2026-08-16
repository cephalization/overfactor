import { watch as watchFs } from "node:fs";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { DaemonInfo, WsServerMessage } from "@overfactor/sdk";
import {
  daemonInfoPath,
  overfactorDir,
  readDaemonInfo,
  readOverfactorConfig,
} from "@overfactor/sdk/node";
import { watch, type FSWatcher as ChokidarWatcher } from "chokidar";
import type { WSContext } from "hono/ws";
import { extractSessionTitle as extractClaudeTitle } from "@overfactor/integration-claude-code/transcript";
import { extractSessionTitle as extractPiTitle } from "@overfactor/integration-pi/transcript";
import { createApp, DAEMON_VERSION, resolveRepoForCwd } from "./app.ts";
import { openDb } from "./db.ts";
import { computeDiffStats, currentBranch, defaultBranch, mainWorktreeRoot } from "./diff.ts";
import { GitIgnoreMatcher, isBuiltInIgnoredPath } from "./gitignore.ts";
import { createLogger, type Logger } from "./logger.ts";
import { SessionStore } from "./store.ts";

/** Fixed default port: binding it is the single-instance lock. */
export const DEFAULT_PORT = 41417;

const DIFF_DEBOUNCE_MS = 300;
const WATCHER_REARM_DELAY_MS = 5000;

function extractTitle(agent: string, content: string): string | null {
  if (agent === "claude-code") return extractClaudeTitle(content);
  if (agent === "pi") return extractPiTitle(content);
  return null;
}

/**
 * Only macOS and Windows back `fs.watch({ recursive: true })` with the
 * platform watcher (FSEvents / ReadDirectoryChangesW) and no startup crawl.
 * On other platforms Node emulates recursion in JS with a synchronous
 * full-tree scan and one inotify watch per file — worse than chokidar, which
 * at least skips ignored subtrees during its crawl.
 */
const NATIVE_RECURSIVE_WATCH = process.platform === "darwin" || process.platform === "win32";

export interface RunningDaemon {
  port: number;
  close: () => Promise<void>;
}

/**
 * Starts the daemon: binds 127.0.0.1 (EADDRINUSE means another instance owns
 * the port), then writes `daemon.json`, watches configured repos for diff
 * changes, and broadcasts WS invalidations on any session change.
 */
export async function startDaemon(options?: {
  port?: number;
  log?: Logger;
}): Promise<RunningDaemon> {
  const log = options?.log ?? createLogger();
  const port =
    options?.port ??
    (process.env.OVERFACTOR_PORT !== undefined
      ? Number.parseInt(process.env.OVERFACTOR_PORT, 10)
      : DEFAULT_PORT);

  const dir = overfactorDir();
  await mkdir(dir, { recursive: true });

  const db = openDb(join(dir, "daemon.db"));
  const store = new SessionStore(db);
  let config = await readOverfactorConfig();

  let closing = false;

  // Debounced per-cwd worktree state recomputation: diff stats, checked-out
  // branch, and the branch's Change Request (created on first sight when the
  // branch diverges from the repo default; default-branch sessions stay
  // ungrouped).
  const diffTimers = new Map<string, NodeJS.Timeout>();
  const diffLog = log.child({ subsystem: "diff" });
  const defaultBranches = new Map<string, string | null>();
  const repoDefaultBranch = async (repoPath: string): Promise<string | null> => {
    if (!defaultBranches.has(repoPath)) {
      defaultBranches.set(repoPath, await defaultBranch(repoPath));
    }
    return defaultBranches.get(repoPath) ?? null;
  };
  const refreshWorktreeState = async (cwd: string, repoPath: string): Promise<void> => {
    const [stats, branch] = await Promise.all([computeDiffStats(cwd), currentBranch(cwd)]);
    if (branch !== null && branch !== (await repoDefaultBranch(repoPath))) {
      store.ensureChangeRequest(repoPath, branch);
    }
    store.setWorktreeState(cwd, stats, branch);
  };
  const scheduleDiff = (cwd: string, repoPath: string): void => {
    if (closing) return;
    const existing = diffTimers.get(cwd);
    if (existing !== undefined) clearTimeout(existing);
    diffTimers.set(
      cwd,
      setTimeout(() => {
        diffTimers.delete(cwd);
        refreshWorktreeState(cwd, repoPath).catch((error: unknown) =>
          diffLog.warn({ cwd, error }, "worktree state refresh failed"),
        );
      }, DIFF_DEBOUNCE_MS),
    );
  };

  // Linked `git worktree` checkouts live outside the tracked repo root, so a
  // prefix match alone would drop their events; fall back to resolving the
  // cwd's main worktree and matching that. Git reports physical paths, so
  // tracked repos are also indexed by realpath (e.g. /tmp vs /private/tmp on
  // macOS). Cached per cwd; both caches reset on config reload.
  const worktreeRepoCache = new Map<string, string | null>();
  const realRepoIndex = new Map<string, string>();
  const refreshRealRepoIndex = async (): Promise<void> => {
    realRepoIndex.clear();
    for (const repo of config.repos) {
      try {
        realRepoIndex.set(await realpath(repo), repo);
      } catch {
        // repo path missing on disk; prefix matching still applies
      }
    }
  };
  await refreshRealRepoIndex();
  const resolveRepo = async (cwd: string): Promise<string | null> => {
    const direct = resolveRepoForCwd(config.repos, cwd);
    if (direct !== null) return direct;
    const cached = worktreeRepoCache.get(cwd);
    if (cached !== undefined) return cached;
    const mainRoot = await mainWorktreeRoot(cwd);
    const resolved =
      mainRoot === null
        ? null
        : (resolveRepoForCwd(config.repos, mainRoot) ?? realRepoIndex.get(mainRoot) ?? null);
    worktreeRepoCache.set(cwd, resolved);
    return resolved;
  };

  const app = createApp({
    store,
    resolveRepo,
    onEvent: (event, repoPath) => scheduleDiff(event.cwd, repoPath),
    onDrop: (event) =>
      log.warn(
        { cwd: event.cwd, sessionId: event.sessionId, type: event.type },
        "dropped event: cwd is in no tracked repo",
      ),
  });

  const nodeWs = createNodeWebSocket({ app });
  const sockets = new Set<WSContext>();
  app.get(
    "/ws",
    nodeWs.upgradeWebSocket(() => ({
      onOpen: (_event, ws) => sockets.add(ws),
      onClose: (_event, ws) => sockets.delete(ws),
    })),
  );

  const broadcast = (collection: WsServerMessage["collection"]): void => {
    const message: WsServerMessage = { type: "invalidate", collection };
    const payload = JSON.stringify(message);
    for (const socket of sockets) {
      // Renderer hot-reloads churn connections; a send racing a close must
      // never take the daemon down. Evict the socket instead.
      try {
        socket.send(payload);
      } catch (error) {
        sockets.delete(socket);
        log.debug({ error }, "dropped ws client on failed send");
      }
    }
  };
  store.events.on("changed", () => broadcast("sessions"));
  store.events.on("crsChanged", () => broadcast("crs"));

  // Live sessions' transcript files are watched so the app's transcript pane
  // stays in sync as the agent talks. The watched set follows session state;
  // file changes broadcast a debounced "transcripts" invalidation and refresh
  // the agent-generated session title (ai-title / session_info) — which also
  // titles resumed sessions immediately, since their transcript already
  // carries one.
  const transcriptWatchers = new Map<string, ChokidarWatcher>();
  const titleTimers = new Map<string, NodeJS.Timeout>();
  let transcriptBroadcastTimer: NodeJS.Timeout | null = null;
  const broadcastTranscripts = (): void => {
    if (closing || transcriptBroadcastTimer !== null) return;
    transcriptBroadcastTimer = setTimeout(() => {
      transcriptBroadcastTimer = null;
      broadcast("transcripts");
    }, DIFF_DEBOUNCE_MS);
  };
  const refreshNativeTitle = (path: string, agent: string): void => {
    const existing = titleTimers.get(path);
    if (existing !== undefined) clearTimeout(existing);
    titleTimers.set(
      path,
      setTimeout(() => {
        titleTimers.delete(path);
        void readFile(path, "utf8")
          .then((content) => {
            const title = extractTitle(agent, content);
            if (title !== null && !closing) store.setNativeTitle(path, title);
          })
          .catch(() => {
            // transcript unreadable right now; the next change retries
          });
      }, DIFF_DEBOUNCE_MS),
    );
  };
  const syncTranscriptWatchers = (): void => {
    if (closing) return;
    const live = new Map(store.liveTranscripts().map(({ path, agent }) => [path, agent]));
    for (const [path, watcher] of transcriptWatchers) {
      if (!live.has(path)) {
        void watcher.close();
        transcriptWatchers.delete(path);
      }
    }
    for (const [path, agent] of live) {
      if (transcriptWatchers.has(path)) continue;
      const watcher = watch(path, { ignoreInitial: true });
      watcher.on("all", () => {
        broadcastTranscripts();
        refreshNativeTitle(path, agent);
      });
      watcher.on("error", () => {
        // transcript may not exist yet; the sync on next session change retries
        void watcher.close();
        transcriptWatchers.delete(path);
      });
      transcriptWatchers.set(path, watcher);
      refreshNativeTitle(path, agent);
    }
  };
  store.events.on("changed", syncTranscriptWatchers);
  syncTranscriptWatchers();

  const server = await new Promise<ServerType>((resolve, reject) => {
    const created = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, () =>
      resolve(created),
    );
    created.once("error", reject);
  });
  nodeWs.injectWebSocket(server);

  const info: DaemonInfo = {
    port,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    version: DAEMON_VERSION,
  };
  const infoPayload = `${JSON.stringify(info, null, 2)}\n`;
  await writeFile(daemonInfoPath(), infoPayload, "utf8");
  log.info({ port, pid: info.pid }, "daemon listening");

  // Watch configured repos: any file change recomputes diffs for live
  // sessions in that repo. Watch the overfactor dir for config.json edits so
  // `overfactor repo add` applies without a restart.
  const watchLog = log.child({ subsystem: "watcher" });
  const repoWatchers = new Map<string, () => void>();
  const rearmTimers = new Set<NodeJS.Timeout>();

  const handleRepoEvent = (repo: string, ignores: GitIgnoreMatcher, filename: string): void => {
    // Built-in exclusion runs before EVERYTHING — a `.gitignore` inside
    // node_modules must not wipe the matcher cache (pnpm install fires
    // thousands of those).
    if (isBuiltInIgnoredPath(filename)) return;
    if (/(^|[\\/])\.gitignore$/.test(filename)) ignores.invalidate();
    void ignores
      .ignores(filename)
      .then((ignored) => {
        // The ignore check is async: by the time it resolves the daemon may
        // be shutting down or the repo untracked — re-check both.
        if (ignored || closing || !config.repos.includes(repo)) return;
        for (const cwd of store.liveCwds(repo)) scheduleDiff(cwd, repo);
      })
      .catch((error: unknown) =>
        watchLog.warn({ repo, filename, error }, "gitignore match failed"),
      );
  };

  const watchRepo = (repo: string): void => {
    repoWatchers.get(repo)?.();
    repoWatchers.delete(repo);
    const ignores = new GitIgnoreMatcher(repo);

    // Node closes a FSWatcher's handle before emitting 'error', so an errored
    // watcher is dead. Re-arm after a delay instead of silently freezing diff
    // stats for the repo until the next daemon restart.
    const onError = (error: unknown): void => {
      watchLog.warn({ repo, error }, "repo watcher error; re-arming");
      repoWatchers.get(repo)?.();
      repoWatchers.delete(repo);
      const timer = setTimeout(() => {
        rearmTimers.delete(timer);
        if (!closing && config.repos.includes(repo)) watchRepo(repo);
      }, WATCHER_REARM_DELAY_MS);
      rearmTimers.add(timer);
    };

    try {
      if (NATIVE_RECURSIVE_WATCH) {
        // Platform watcher, no startup crawl — chokidar's recursive crawl of a
        // large tracked monorepo has starved the daemon's event loop (see
        // FINDINGS.md). Trade-off: .git/node_modules events still arrive and
        // are dropped first thing in the handler.
        const watcher = watchFs(repo, { recursive: true }, (_eventName, filename) => {
          if (filename === null) return;
          handleRepoEvent(repo, ignores, filename);
        });
        watcher.on("error", onError);
        repoWatchers.set(repo, () => watcher.close());
      } else {
        const watcher = watch(repo, {
          ignoreInitial: true,
          ignored: (path) => isBuiltInIgnoredPath(relative(repo, path)),
        });
        watcher.on("all", (_eventName, path) =>
          handleRepoEvent(repo, ignores, relative(repo, path)),
        );
        watcher.on("error", onError);
        repoWatchers.set(repo, () => void watcher.close());
      }
    } catch (error) {
      watchLog.warn({ repo, error }, "could not watch repo");
    }
  };

  const watchRepos = (repos: string[]): void => {
    for (const [repo, close] of repoWatchers) {
      if (!repos.includes(repo)) {
        close();
        repoWatchers.delete(repo);
      }
    }
    for (const repo of repos) {
      if (!repoWatchers.has(repo)) watchRepo(repo);
    }
  };
  watchRepos(config.repos);

  const configWatcher: ChokidarWatcher = watch(dir, { ignoreInitial: true, depth: 0 });
  configWatcher.on("error", (error) => watchLog.warn({ error }, "config watcher error"));
  configWatcher.on("all", (eventName, path) => {
    // Self-heal discovery: if daemon.json disappears while we're alive
    // (crashed sibling's cleanup, manual delete), republish it.
    if (path.endsWith("daemon.json")) {
      if (eventName === "unlink" && !closing) {
        void writeFile(daemonInfoPath(), infoPayload, "utf8").then(() =>
          watchLog.warn("daemon.json was removed while running; republished"),
        );
      }
      return;
    }
    if (!path.endsWith("config.json")) return;
    void readOverfactorConfig().then((next) => {
      config = next;
      worktreeRepoCache.clear();
      void refreshRealRepoIndex();
      watchRepos(config.repos);
      broadcast("repos");
      watchLog.info({ repos: config.repos }, "config reloaded");
    });
  });

  const close = async (): Promise<void> => {
    closing = true;
    for (const timer of diffTimers.values()) clearTimeout(timer);
    diffTimers.clear();
    if (transcriptBroadcastTimer !== null) clearTimeout(transcriptBroadcastTimer);
    for (const timer of titleTimers.values()) clearTimeout(timer);
    titleTimers.clear();
    for (const watcher of transcriptWatchers.values()) void watcher.close();
    transcriptWatchers.clear();
    for (const timer of rearmTimers) clearTimeout(timer);
    rearmTimers.clear();
    await configWatcher.close();
    for (const closeWatcher of repoWatchers.values()) closeWatcher();
    repoWatchers.clear();
    // Unpublish only if the file is still ours — a replacement daemon may
    // already have written its own daemon.json.
    const published = await readDaemonInfo();
    if (published?.pid === process.pid) {
      await rm(daemonInfoPath(), { force: true });
    }
    // server.close() waits for every open connection — upgraded WS sockets
    // and keep-alive HTTP alike — so with the app connected it would never
    // finish and every SIGTERM would end in the CLI's SIGKILL escalation.
    // Close WS clients, then drop remaining connections.
    for (const socket of sockets) {
      try {
        socket.close();
      } catch {
        // already gone
      }
    }
    sockets.clear();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      if ("closeAllConnections" in server) server.closeAllConnections();
    });
  };

  return { port, close };
}
