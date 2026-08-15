# Findings

Technical discoveries, constraints, resolved bugs, and decisions that future work should know. Not a task tracker or changelog — see `GOALS.md` and git history for those.

Each entry: date, status, affected area, practical implication.

## 2026-08-15 — decided — architecture: core stack

Settled in design review (Tony), supersedes nothing:

- **Shell**: Electron from day one (not daemon-served web UI). UI in **React**.
- **Daemon**: standalone **TypeScript/Node** process, separate from Electron; the app is a client. Daemon outlives the app window.
- **Transport**: daemon serves HTTP + WebSocket on `127.0.0.1`, port published to `~/.overfactor/daemon.json`. Short-lived hook processes POST events (HTTP ingest); the app subscribes over WS. Both sides go through the typed SDK.
- **Agent integration model** (reference: https://github.com/herdrdev/herdr — integrations + socket API): a strongly typed SDK published to npm; per-agent integrations are installed *into each agent's own hook/extension system* (Claude Code hooks invoking a small CLI; pi extensions are `.ts` files in `~/.pi/agent/extensions/`) and push lifecycle + session-identity events to the daemon. Unlike herdr, Overfactor does not own the PTY, so there is no screen-scraping fallback — hooks + the agent's transcript files carry everything. Integration order: claude-code first, pi second (pi exists to prove the SDK isn't shaped around one harness).
- **Diff attribution**: a session's diff is `git diff` of the worktree it runs in (its cwd). Sessions sharing a worktree show identical stats — accepted until Overfactor launches sessions into per-session worktrees itself (the target workflow, later slice).

## 2026-08-15 — decided — libraries

Guiding rule (Tony): minimize hand-written code not covered by a purpose-built, well-maintained library; use each library idiomatically as its docs prescribe. Versions verified current on npm 2026-08-15.

**UI (Electron renderer)**
- React; **shadcn/ui strictly via the shadcn CLI, never hand-edited**, with the idiomatic CSS-variable theme setup so theme tweaks propagate app-wide.
- **Tailwind v4** (latest).
- **@pierre/diffs** for git diff + code rendering. Theming decision: *two theme domains* — shadcn tokens govern the app shell; pierre/shiki themes govern code surfaces (chosen once to harmonize, incl. dark/light). Do not bridge pierre's theming onto shadcn vars.
- **streamdown** for markdown→markup (built for AI streaming; fits live transcripts).
- **TanStack Router** (typed routes for panes/views), **TanStack Virtual** (long transcripts/diffs), **cmdk via shadcn Command**, **react-hotkeys-hook** (keyboard-first review).

**Data sync**
- **TanStack Query + TanStack DB**, prescribed usage: `queryCollection` loads collections; daemon WS events invalidate → refetch (no custom sync implementation). Note: TanStack DB is 0.x — API churn accepted, ride releases.
- **partysocket** for the app's reconnecting WS connection to the daemon.

**Contract / I/O boundaries**
- **zod v4** schemas are the shared type contracts, shipped in the npm SDK. Every I/O boundary validates: hook payloads, HTTP bodies, WS messages, and transcript/state files read off disk. Never trust unvalidated input types.
- **Hono + @hono/zod-validator** on the daemon; **hono/client (`hc`)** gives the typed RPC client in the SDK. Accepted glue: one thin typed helper binding `hc` calls into TanStack Query options.

**Daemon**
- **drizzle-orm + better-sqlite3** for persistence (daemon is plain Node — no Electron ABI concerns).
- **just-git (v2 branch, vendored)** for git operations. Verified 2026-08-15: v2 (unpublished) has what master lacks — a Node fs bridge (`src/fs/node-durable-fs.ts`, `src/store/node-fs.ts`) and true linked-worktree mechanics (`src/lib/worktree-admin.ts`: gitlink `.git` files, `commondir` back-pointers, `worktrees/<id>` admin dirs). Plan: clone `blindmansion/just-git@v2` into `packages/just-git` as a workspace package with its own nested git repo, and build off v2 until it ships to npm; then swap the `workspace:*` dep for the published version. Vendoring notes: (a) prefer a git submodule pinned to v2 so fresh checkouts reproduce — a gitignored plain clone breaks `pnpm install`'s `workspace:*` resolution; (b) exclude `packages/just-git` from `vp check`/`vp test` (it carries its own oxlint/oxfmt config and bun-only tests); its build is plain `tsc`, so `pnpm --filter just-git build` works without bun. Residual risk: tracking an unreleased branch — validate reading a real `git worktree add` worktree as the first integration test, and treat upstream v2 API churn as expected. Upside stands: `createSandboxWorktree` + embeddable server are purpose-built for the later sandbox slice.
- **chokidar** for file watching.

**Daemon/SDK tooling** (settled 2026-08-15; versions verified current on npm)
- **@hono/node-server + @hono/node-ws** — idiomatic Hono-on-Node with WS upgrade (wraps `ws`).
- **pino** for structured logging (child loggers per subsystem; pino-pretty in dev; pino-roll for rotation).
- **citty** for the `overfactor` CLI (daemon start/stop/status, integration install/uninstall). Pre-1.0 — churn accepted, same bet as TanStack DB. The Claude Code **hook shim stays dependency-free by design** (stdin → zod parse → POST → exit): it runs on every tool call, cold-start latency is the budget, no CLI framework there.
- **GitHub: `gh auth token` → octokit.** Token sourced from the user's existing gh login (no auth UX to build), all API calls through octokit for full typing. Requires gh installed — acceptable on machines running coding agents.
- **execa** (process spawning), **drizzle-kit** (migrations), **p-queue + p-retry** (polling/backoff), **uuidv7** (time-sortable IDs), **emittery** (typed internal events), **tsdown via `vp pack`** (SDK build).
- **launchd**: accepted hand-rolled exception — no well-maintained npm launchd manager exists. Small module (~100 lines): `plist` pkg writes the LaunchAgent, execa drives `launchctl bootstrap/bootout`; `KeepAlive` provides crash-restart.
- **Single-instance daemon needs no lockfile lib**: binding the localhost port *is* the lock; write `~/.overfactor/daemon.json` only after a successful bind. (`proper-lockfile` is unmaintained since 2022 — avoid.)

**Electron build**
- **electron-vite 5** (main/preload/renderer, Vite-native) + **electron-builder** (package/sign/update).

## 2026-08-15 — note — docs: reading design.html

`design.html` is a self-extracting bundle, not plain HTML — content lives in `<script type="__bundler/manifest">` (per-asset gzip+base64 JSON) and `<script type="__bundler/template">` (JSON-encoded HTML string). To read it without a browser: parse those two blocks, base64-decode + gunzip manifest entries, `json.loads` the template. The rendered doc is the internal working spec (concepts, flow, UI mock, decisions); the prior marketing draft is kept separately as "Switchyard Product Sheet".
