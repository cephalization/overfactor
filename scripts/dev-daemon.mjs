import { spawn, spawnSync } from "node:child_process";
import { statSync } from "node:fs";

/**
 * Dev-mode daemon runner for the root `dev` script. The daemon-build lane
 * (`vp pack --watch`) cleans `packages/daemon/dist` on startup, so launching
 * `node --watch dist/cli.mjs` directly races the clean and dies with
 * MODULE_NOT_FOUND when it loses. Wait until the CLI bundle exists and has
 * been stable briefly (the initial clean + re-emit finished), then hand off
 * to `node --watch`, which restarts the daemon on every subsequent rebuild.
 */

const CLI = "packages/daemon/dist/cli.mjs";
const STABLE_MS = 500;
const POLL_MS = 100;

function mtimeOrNull(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

let stableSince = null;
let lastMtime = null;
for (;;) {
  const mtime = mtimeOrNull(CLI);
  const now = Date.now();
  if (mtime === null || mtime !== lastMtime) {
    stableSince = mtime === null ? null : now;
    lastMtime = mtime;
  } else if (stableSince !== null && now - stableSince >= STABLE_MS) {
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, POLL_MS));
}

spawnSync(process.execPath, [CLI, "daemon", "stop"], { stdio: "inherit" });

const child = spawn(process.execPath, ["--watch", CLI, "daemon", "start", "--foreground"], {
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  process.exit(signal !== null ? 1 : (code ?? 1));
});
