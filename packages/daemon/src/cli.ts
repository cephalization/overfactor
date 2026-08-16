#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { openSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { installClaudeCodeIntegration } from "@overfactor/integration-claude-code/install";
import { healthResponseSchema } from "@overfactor/sdk";
import {
  daemonInfoPath,
  overfactorDir,
  readDaemonInfo,
  readOverfactorConfig,
} from "@overfactor/sdk/node";
import { defineCommand, runMain } from "citty";
import { createLogger } from "./logger.ts";
import { addRepo } from "./repos.ts";
import { DEFAULT_PORT, startDaemon } from "./server.ts";

const execFileAsync = promisify(execFile);

async function probeHealth(port: number): Promise<{ port: number; pid: number } | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) return null;
    const health = healthResponseSchema.parse(await response.json());
    return { port, pid: health.pid };
  } catch {
    return null;
  }
}

interface DaemonProcess {
  port: number;
  pid: number;
}

function fallbackPort(): number {
  return process.env.OVERFACTOR_PORT !== undefined
    ? Number.parseInt(process.env.OVERFACTOR_PORT, 10)
    : DEFAULT_PORT;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** ESRCH-safe kill: the target exiting between poll and signal is success, not an error. */
function killProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }
}

/**
 * Pid actually LISTENing on the daemon port, via lsof. This — never a pid
 * read off a possibly-stale daemon.json — is the only pid the CLI will
 * signal without a `/health` answer: after a crash + reboot the OS can hand
 * the recorded pid to an innocent process. "free" means nothing listens;
 * "unknown" means lsof is unavailable and we must not guess.
 */
async function portListenerPid(port: number): Promise<number | "free" | "unknown"> {
  try {
    const { stdout } = await execFileAsync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"]);
    const pid = Number.parseInt(stdout.trim().split("\n")[0] ?? "", 10);
    return Number.isNaN(pid) ? "free" : pid;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "unknown" : "free";
  }
}

/** Polls `check` every `intervalMs`, up to `attempts` times. */
async function waitFor(
  check: () => boolean | Promise<boolean>,
  attempts: number,
  intervalMs = 100,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await new Promise((r) => setTimeout(r, intervalMs));
    if (await check()) return true;
  }
  return false;
}

async function isHealthy(): Promise<DaemonProcess | null> {
  const info = await readDaemonInfo();
  if (info !== null) {
    const health = await probeHealth(info.port);
    if (health !== null) return health;
  }
  // daemon.json may be missing or stale; the port is fixed, so probe it too.
  if (info?.port === fallbackPort()) return null;
  return probeHealth(fallbackPort());
}

const daemonStart = defineCommand({
  meta: { name: "start", description: "Start the daemon (detached unless --foreground)" },
  args: {
    foreground: { type: "boolean", description: "Run in this terminal", default: false },
  },
  async run({ args }) {
    const running = await isHealthy();
    if (running !== null) {
      console.log(`daemon already running (pid ${running.pid}, port ${running.port})`);
      return;
    }
    // Bind-is-the-lock: a stale daemon.json with a free port must not block
    // startup. Only a live listener that won't answer /health blocks us.
    const info = await readDaemonInfo();
    const port = info?.port ?? fallbackPort();
    const owner = await portListenerPid(port);
    if (typeof owner === "number") {
      throw new Error(
        `an unresponsive daemon (pid ${owner}) holds port ${port}; run \`overfactor daemon stop\``,
      );
    }
    if (args.foreground) {
      const log = createLogger();
      // Last resort: die loudly, not silently — the crash reason must reach
      // the terminal/log so a supervised dev daemon is debuggable.
      process.on("uncaughtException", (error) => {
        log.fatal({ error }, "daemon crashed (uncaught exception)");
        process.exit(1);
      });
      process.on("unhandledRejection", (error) => {
        log.fatal({ error }, "daemon crashed (unhandled rejection)");
        process.exit(1);
      });
      const daemon = await startDaemon({ log });
      const shutdown = (): void => {
        void daemon.close().finally(() => process.exit(0));
      };
      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
      // Keep the process alive; startDaemon's server holds the event loop.
      return;
    }
    await mkdir(overfactorDir(), { recursive: true });
    const logFd = openSync(join(overfactorDir(), "daemon.log"), "a");
    const child = spawn(
      process.execPath,
      [process.argv[1] ?? "", "daemon", "start", "--foreground"],
      {
        detached: true,
        stdio: ["ignore", logFd, logFd],
      },
    );
    child.unref();
    if (await waitFor(async () => (await isHealthy()) !== null, 30)) {
      const healthy = await isHealthy();
      if (healthy !== null) {
        console.log(`daemon started (pid ${healthy.pid}, port ${healthy.port})`);
        return;
      }
    }
    throw new Error(`daemon did not become healthy; see ${join(overfactorDir(), "daemon.log")}`);
  },
});

const daemonStop = defineCommand({
  meta: { name: "stop", description: "Stop the running daemon" },
  async run() {
    let target = await isHealthy();
    if (target === null) {
      // No /health answer. Signal only a pid verified to hold the daemon
      // port — a pid from a stale daemon.json may have been recycled to an
      // unrelated process.
      const info = await readDaemonInfo();
      const port = info?.port ?? fallbackPort();
      const owner = await portListenerPid(port);
      if (typeof owner === "number") {
        console.log(`daemon is unresponsive (pid ${owner}, port ${port}); stopping it`);
        target = { pid: owner, port };
      } else if (owner === "unknown" && info !== null && processExists(info.pid)) {
        throw new Error(
          `cannot verify pid ${info.pid} owns port ${port} (lsof unavailable); not killing it — inspect and stop it manually`,
        );
      } else if (info !== null) {
        await rm(daemonInfoPath(), { force: true });
        console.log("removed stale daemon.json (no daemon is running)");
        return;
      } else {
        console.log("daemon is not running");
        return;
      }
    }

    const { pid } = target;
    killProcess(pid, "SIGTERM");
    // Wait for actual process exit, not just the health check disappearing —
    // shutdown cleanup (removing daemon.json) must finish before a restart.
    if (await waitFor(() => !processExists(pid), 30)) {
      console.log("daemon stopped");
      return;
    }

    // A wedged event loop cannot run the daemon's SIGTERM handler. Escalate so
    // `daemon stop && daemon start` (including the dev loop) can always recover.
    killProcess(pid, "SIGKILL");
    if (await waitFor(() => !processExists(pid), 20)) {
      // SIGKILL skips the daemon's cleanup; drop its discovery file ourselves.
      const leftover = await readDaemonInfo();
      if (leftover?.pid === pid) await rm(daemonInfoPath(), { force: true });
      console.log("daemon force-stopped after it did not respond to SIGTERM");
      return;
    }
    throw new Error(`daemon (pid ${pid}) did not exit after SIGKILL`);
  },
});

const daemonStatus = defineCommand({
  meta: { name: "status", description: "Show daemon status" },
  async run() {
    const running = await isHealthy();
    if (running !== null) {
      console.log(`daemon running (pid ${running.pid}, port ${running.port})`);
      return;
    }
    const info = await readDaemonInfo();
    const port = info?.port ?? fallbackPort();
    const owner = await portListenerPid(port);
    if (typeof owner === "number") {
      console.log(`daemon process unresponsive (pid ${owner}, port ${port})`);
    } else if (info !== null) {
      console.log("daemon is not running (stale daemon.json; `overfactor daemon stop` cleans it)");
    } else {
      console.log("daemon is not running");
    }
  },
});

const repoAdd = defineCommand({
  meta: { name: "add", description: "Track sessions in a repo" },
  args: {
    path: { type: "positional", description: "Repo path", default: "." },
  },
  async run({ args }) {
    const repoPath = resolve(args.path);
    const result = await addRepo(repoPath);
    if (!result.ok) {
      throw new Error(`${repoPath} is not a git repo (no .git)`);
    }
    console.log(`tracking ${repoPath}`);
  },
});

const repoList = defineCommand({
  meta: { name: "list", description: "List tracked repos" },
  async run() {
    const config = await readOverfactorConfig();
    if (config.repos.length === 0) {
      console.log("no repos tracked; run `overfactor repo add <path>`");
      return;
    }
    for (const repo of config.repos) console.log(repo);
  },
});

const installClaudeCode = defineCommand({
  meta: { name: "claude-code", description: "Install the Claude Code hooks integration" },
  async run() {
    const result = await installClaudeCodeIntegration();
    console.log(`installed hooks into ${result.settingsPath}`);
    console.log(`hook command: ${result.hookCommand}`);
  },
});

const main = defineCommand({
  meta: {
    name: "overfactor",
    description: "Overfactor daemon and integration manager",
  },
  subCommands: {
    daemon: defineCommand({
      meta: { name: "daemon", description: "Manage the daemon process" },
      subCommands: { start: daemonStart, stop: daemonStop, status: daemonStatus },
    }),
    repo: defineCommand({
      meta: { name: "repo", description: "Manage tracked repos" },
      subCommands: { add: repoAdd, list: repoList },
    }),
    install: defineCommand({
      meta: { name: "install", description: "Install agent integrations" },
      subCommands: { "claude-code": installClaudeCode },
    }),
  },
});

void runMain(main);
