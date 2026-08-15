import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { DaemonInfo, WsServerMessage } from "@overfactor/sdk";
import {
  daemonInfoPath,
  overfactorDir,
  readDaemonInfo,
  readOverfactorConfig,
} from "@overfactor/sdk/node";
import { watch, type FSWatcher } from "chokidar";
import type { WSContext } from "hono/ws";
import { createApp, DAEMON_VERSION } from "./app.ts";
import { openDb } from "./db.ts";
import { computeDiffStats } from "./diff.ts";
import { createLogger, type Logger } from "./logger.ts";
import { SessionStore } from "./store.ts";

/** Fixed default port: binding it is the single-instance lock. */
export const DEFAULT_PORT = 41417;

const DIFF_DEBOUNCE_MS = 300;

function isIgnoredPath(path: string): boolean {
  return /(^|\/)(\.git|node_modules)(\/|$)/.test(path);
}

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

  // Debounced per-cwd diff recomputation.
  const diffTimers = new Map<string, NodeJS.Timeout>();
  const diffLog = log.child({ subsystem: "diff" });
  const scheduleDiff = (cwd: string): void => {
    const existing = diffTimers.get(cwd);
    if (existing !== undefined) clearTimeout(existing);
    diffTimers.set(
      cwd,
      setTimeout(() => {
        diffTimers.delete(cwd);
        computeDiffStats(cwd)
          .then((stats) => {
            if (stats !== null) store.setDiffForCwd(cwd, stats);
          })
          .catch((error: unknown) => diffLog.warn({ cwd, error }, "diff computation failed"));
      }, DIFF_DEBOUNCE_MS),
    );
  };

  const app = createApp({
    store,
    repos: () => config.repos,
    onEvent: (event) => scheduleDiff(event.cwd),
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
  let repoWatcher: FSWatcher | null = null;
  const watchRepos = (repos: string[]): void => {
    if (repoWatcher !== null) void repoWatcher.close();
    // Ignore .git/node_modules at the watcher level — watching them in a
    // monorepo burns descriptors and floods events.
    repoWatcher =
      repos.length === 0
        ? null
        : watch(repos, { ignoreInitial: true, ignored: (path) => isIgnoredPath(path) });
    repoWatcher?.on("all", (_eventName, path) => {
      if (isIgnoredPath(path)) return;
      const repo = config.repos.find((r) => path === r || path.startsWith(`${r}/`));
      if (repo === undefined) return;
      for (const cwd of store.liveCwds(repo)) scheduleDiff(cwd);
    });
    repoWatcher?.on("error", (error) => watchLog.warn({ error }, "repo watcher error"));
  };
  watchRepos(config.repos);

  let closing = false;
  const configWatcher = watch(dir, { ignoreInitial: true, depth: 0 });
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
      watchRepos(config.repos);
      broadcast("repos");
      watchLog.info({ repos: config.repos }, "config reloaded");
    });
  });

  const close = async (): Promise<void> => {
    closing = true;
    for (const timer of diffTimers.values()) clearTimeout(timer);
    await configWatcher.close();
    if (repoWatcher !== null) await repoWatcher.close();
    // Unpublish only if the file is still ours — a replacement daemon may
    // already have written its own daemon.json.
    const published = await readDaemonInfo();
    if (published?.pid === process.pid) {
      await rm(daemonInfoPath(), { force: true });
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { port, close };
}
