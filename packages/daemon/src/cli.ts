#!/usr/bin/env node
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { installClaudeCodeIntegration } from "@overfactor/integration-claude-code/install";
import { healthResponseSchema } from "@overfactor/sdk";
import { overfactorDir, readDaemonInfo, readOverfactorConfig } from "@overfactor/sdk/node";
import { defineCommand, runMain } from "citty";
import { createLogger } from "./logger.ts";
import { addRepo } from "./repos.ts";
import { DEFAULT_PORT, startDaemon } from "./server.ts";

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

async function isHealthy(): Promise<{ port: number; pid: number } | null> {
  const info = await readDaemonInfo();
  if (info !== null) {
    const health = await probeHealth(info.port);
    if (health !== null) return health;
  }
  // daemon.json may be missing or stale; the port is fixed, so probe it too.
  const fallbackPort =
    process.env.OVERFACTOR_PORT !== undefined
      ? Number.parseInt(process.env.OVERFACTOR_PORT, 10)
      : DEFAULT_PORT;
  if (info?.port === fallbackPort) return null;
  return probeHealth(fallbackPort);
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
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((r) => setTimeout(r, 100));
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
    const running = await isHealthy();
    if (running === null) {
      console.log("daemon is not running");
      return;
    }
    process.kill(running.pid, "SIGTERM");
    // Wait for actual process exit, not just the health check disappearing —
    // shutdown cleanup (removing daemon.json) must finish before a restart.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        process.kill(running.pid, 0);
      } catch {
        console.log("daemon stopped");
        return;
      }
    }
    throw new Error(`daemon (pid ${running.pid}) did not exit after SIGTERM`);
  },
});

const daemonStatus = defineCommand({
  meta: { name: "status", description: "Show daemon status" },
  async run() {
    const running = await isHealthy();
    console.log(
      running === null
        ? "daemon is not running"
        : `daemon running (pid ${running.pid}, port ${running.port})`,
    );
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
