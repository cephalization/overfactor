# Findings

Technical discoveries, constraints, resolved bugs, and decisions that future work should know. Not a task tracker or changelog — see `GOALS.md` and git history for those.

Each entry: date, status, affected area, practical implication.

## 2026-08-15 — decided — architecture: core stack

Settled in design review (Tony), supersedes nothing:

- **Shell**: Electron from day one (not daemon-served web UI). UI in **React**.
- **Daemon**: standalone **TypeScript/Node** process, separate from Electron; the app is a client. Daemon outlives the app window.
- **Transport**: daemon serves HTTP + WebSocket on `127.0.0.1`, port published to `~/.overfactor/daemon.json`. Short-lived hook processes POST events (HTTP ingest); the app subscribes over WS. Both sides go through the typed SDK.
- **Agent integration model** (reference: https://github.com/herdrdev/herdr — integrations + socket API): a strongly typed SDK published to npm; per-agent integrations are installed _into each agent's own hook/extension system_ (Claude Code hooks invoking a small CLI; pi extensions are `.ts` files in `~/.pi/agent/extensions/`) and push lifecycle + session-identity events to the daemon. Unlike herdr, Overfactor does not own the PTY, so there is no screen-scraping fallback — hooks + the agent's transcript files carry everything. Integration order: claude-code first, pi second (pi exists to prove the SDK isn't shaped around one harness).
- **Diff attribution**: a session's diff is `git diff` of the worktree it runs in (its cwd). Sessions sharing a worktree show identical stats — accepted until Overfactor launches sessions into per-session worktrees itself (the target workflow, later slice).

## 2026-08-15 — decided — libraries

Guiding rule (Tony): minimize hand-written code not covered by a purpose-built, well-maintained library; use each library idiomatically as its docs prescribe. Versions verified current on npm 2026-08-15.

**UI (Electron renderer)**

- React; **shadcn/ui strictly via the shadcn CLI, never hand-edited**, with the idiomatic CSS-variable theme setup so theme tweaks propagate app-wide.
- **Tailwind v4** (latest).
- **@pierre/diffs** for git diff + code rendering. Theming decision: _two theme domains_ — shadcn tokens govern the app shell; pierre/shiki themes govern code surfaces (chosen once to harmonize, incl. dark/light). Do not bridge pierre's theming onto shadcn vars.
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
- **Single-instance daemon needs no lockfile lib**: binding the localhost port _is_ the lock; write `~/.overfactor/daemon.json` only after a successful bind. (`proper-lockfile` is unmaintained since 2022 — avoid.)

**Electron build**

- **electron-vite 5** (main/preload/renderer, Vite-native) + **electron-builder** (package/sign/update).

## 2026-08-15 — implemented — slice one (daemon → live sidebar): constraints and revisions

Slice one is built: `packages/sdk`, `packages/daemon` (with `overfactor` CLI), `packages/integration-claude-code`, `packages/just-git` (submodule), `apps/desktop`. End-to-end smoke-tested (hook shim → daemon → sessions API with lifecycle transitions and live diff stats). Non-obvious findings:

**Contract topology (revises "typed `hc` client ships in the SDK")**

- zod schemas + `~/.overfactor` discovery helpers live in `@overfactor/sdk` (root export is isomorphic; Node-only helpers under `@overfactor/sdk/node`). The Hono `AppType` and `createDaemonClient` (`hc`) live in `@overfactor/daemon/client` — a runtime-light subpath. Reason: putting `hc<AppType>` in the SDK creates an sdk↔daemon build cycle (daemon needs sdk's runtime; sdk's dts would need daemon's types). Revisit only when the SDK actually publishes to npm.
- The hook shim uses bare `fetch` + SDK schemas (no hono/client) — it runs on every tool call; cold start is the budget.
- Single-instance lock is a **fixed default port (41417)**; `OVERFACTOR_PORT` and `OVERFACTOR_DIR` env overrides exist (tests and smoke runs use them). An ephemeral port would break bind-as-lock.

**Toolchain (vite-plus 0.2.9)**

- The scaffold's `vite`/`vitest` catalog aliases + overrides (`npm:@voidzero-dev/vite-plus-core@latest` etc.) are a 0.1.x-era scheme and now break: `@voidzero-dev/vite-plus-test` latest lags at 0.1.24 and drags in an old core whose rolldown binding is incompatible with vite-plus 0.2.9. Removed the aliases/overrides entirely (matches vite-plus's own docs workspace). Packages with tests devDep real `vitest` (^4.1.10 — the exact version vite-plus 0.2.9 bundles) so type-aware lint resolves it.
- `pack.dts.tsgo: true` requires `@typescript/native-preview` (root devDep) — the scaffold never installed it.
- tsdown's `exports: true` regenerates `bin` and names it after the package directory; daemon/integration hand-maintain `exports`/`bin` (`exports: false`) to keep the `overfactor` and `overfactor-claude-hook` bin names.
- pnpm 11 uses `allowBuilds` (map, in pnpm-workspace.yaml) for build-script approval; better-sqlite3 and electron are approved, just-git's bun-test-only natives (ssh2, zstd, …) declined.
- `vp run -F '!just-git'` excludes a package from recursive task runs, but `-F` cannot be combined with `-r`. Root `ready` script and the root vite config `test.exclude`/`lint.ignorePatterns`/`fmt.ignorePatterns` all carve out `packages/just-git` (own toolchain: oxlint config, bun tests, plain tsc build).

**just-git v2 (validation passed)**

- `createGit({ fs: durableFileSystemFromNodeFs(fsPromises), cwd })` + `exec("diff HEAD --numstat")` computes diff stats over real repos **including `git worktree add` linked worktrees** — the planned first integration test (`packages/daemon/tests/diff.test.ts`) passes. No system-git shellouts in the daemon.
- Diff semantics chosen for slice one: staged + unstaged changes to tracked files vs HEAD (`diff HEAD`); untracked files are not counted. Revisit when sessions get per-session worktrees.
- just-git dists from `dist/`, so fresh checkouts need `vp run -r build` (its build is plain tsc; no bun required outside its test suite).

**Electron / UI**

- electron-vite 5 peers vite ^5–^7 (not 8): `apps/desktop` pins `vite: ^7` and `@vitejs/plugin-react: ^5` (plugin-react 6 imports vite 8's `./internal` export and crashes on vite 7).
- The shadcn CLI is pnpm-catalog-aware: it writes `catalog:` deps and appends catalog entries. It did not add `clsx`/`tailwind-merge`/`tw-animate-css` (added manually). Generated `components/ui/**` + `hooks/use-mobile.ts` are excluded from fmt/lint — "never hand-edited" includes the formatter, so future `shadcn add --overwrite` stays diff-clean.
- Preload runs with `sandbox: false` (required for ESM preloads); context isolation stays on. IPC results are zod-validated in preload before crossing the typed bridge (`daemonInfoSchema` for daemon discovery, a non-empty nullable path for the directory picker); renderer call sites retain schema checks as defense in depth. HTTP and WS payloads remain validated in the renderer (`sessionSchema[]` on fetches, `wsServerMessageSchema` on WS messages).

**Repo tracking (added with the GUI picker)**

- Tracked-repo mutations flow through one module (`packages/daemon/src/repos.ts`) used by both the HTTP API (`GET/POST/DELETE /repos`) and the CLI. The GUI never writes config itself: Electron main only runs the native directory picker (IPC `overfactor:pick-directory`); the renderer POSTs the chosen path to the daemon, which validates `.git` exists. Config-file writes from either side hit the daemon's config watcher, which reloads in-memory state and broadcasts a WS `repos` invalidation — so CLI adds appear live in an open app and vice versa.

**Found via agent-driven UI testing (agent-browser over CDP; see TESTING.md)**

- **CORS**: the electron-vite dev renderer runs on `http://localhost:<port>` while the daemon is `127.0.0.1` — cross-origin, so without CORS every renderer fetch fails and the sidebar stays empty (WS still connects; only fetches die). The daemon now runs hono/cors allowing loopback origins (`localhost`/`127.0.0.1` any port) plus `"null"` (packaged file:// pages). Known gap, documented intentionally: any local browser page can call the loopback API (blast radius: fake sessions, track/untrack repos — all zod-validated). The real fix when auth matters is a bearer token in `daemon.json` (mode 0600) that browsers on other origins can't read.
- **daemon.json lifecycle races**: `daemon stop` used to return when the health check died — _before_ the old process removed `daemon.json` — so an immediate `start` could have its freshly written file deleted by the old process, orphaning a healthy daemon the CLI could no longer see. Fixes: `stop` waits for actual process exit (`kill(pid, 0)`); shutdown only removes `daemon.json` if its pid is our own; `GET /health` returns the pid and the CLI falls back to probing the fixed port when `daemon.json` is missing; the daemon republishes `daemon.json` if it is deleted while running.
- **Agent-testability hook**: `OVERFACTOR_CDP_PORT=<port>` makes the desktop app expose Chrome DevTools Protocol (`app.commandLine.appendSwitch("remote-debugging-port", …)` before ready) so agent-browser can `connect` and drive it. Session buttons expose state/title/agent/diff in their accessible names — snapshot-grep beats screenshots for assertions. The native directory picker is not CDP-drivable; agents exercise repo tracking via `POST /repos`.

**Dev loop (`vp run dev`)**

- One idempotent command: prebuild (`vp run -F '@overfactor/daemon...' build`), then **concurrently -k** runs three `vp pack --watch` lanes, the daemon under **`node --watch`** (restarts whenever its dist or a workspace dep's dist changes), and `electron-vite dev -w`. The daemon lane runs `daemon stop &&` first, so re-running takes over any existing daemon; `-k` means Ctrl-C (or any lane dying, including closing the app window) tears the whole stack down — verified: no orphan processes, daemon.json removed.
- **"Error: Electron uninstall" gotcha**: pnpm's side-effects cache materializes new electron peer-variants (e.g. `electron@43.4.0_supports-color@…` appearing when an unrelated dep shifts peers) _without_ the downloaded binary. Electron 43's `index.js` self-heals on require, so the desktop dev script preflights with `node -e "require('electron')"` — idempotent, no-op when the binary exists.

**First real-usage debugging (hooks installed, "no sessions")**

- **Silent daemon death under `node --watch`**: when the daemon crashes, `node --watch` prints the error once and waits for file changes — the dev stack looks alive (concurrently lanes green, stale `daemon.json` on disk) while every hook event is silently dropped. Hardened: WS broadcast wraps each `send` and evicts failing sockets (renderer hot-reloads churn connections; a send racing a close was the likely killer), the config watcher got an error handler, the repo watcher now ignores `.git`/`node_modules` at the watcher level (not just in the handler — watching a monorepo's node_modules burns descriptors), and the foreground daemon installs uncaughtException/unhandledRejection handlers that log `daemon crashed (…)` via pino before exiting, so a dead daemon is always visible in the `[daemon]` lane and `~/.overfactor/daemon.log`. Dropped events (untracked cwd) are now warned about too.
- **just-git v2 cannot diff repos containing submodules**: a gitlink index entry (mode 160000, a directory in the worktree) hits an unguarded file read → `EISDIR`, exit 1 — reproduced on a minimal two-file repo. Since this repo vendors just-git _as a submodule_, every diff of Overfactor itself failed. Documented deviation from "no system-git shellouts": `computeDiffStats` falls back to `git diff HEAD --numstat` via execFile when just-git errors (pure-TS path stays primary). Report upstream and drop the fallback when v2 handles gitlinks.

**Deferred (intentionally)**

- drizzle-kit migrations: the daemon creates its single table with inline DDL kept in lockstep with the drizzle schema; a migration pipeline starts when the schema outgrows one table.
- launchd module and `gh`→octokit: not needed by slice one; unchanged decisions, not yet implemented.

## 2026-08-15 — implemented — Pi integration

`packages/integration-pi` is a Pi package installed **user-level** via `overfactor install pi`, which adds the package path to `~/.pi/agent/settings.json` (Pi's default install target) — sessions report from every repo, not just this one. The original project-local `.pi/settings.json` install was a trap: it only loaded the extension for Pi sessions inside the Overfactor repo, so sessions in other tracked repos silently emitted nothing. The extension source loads from the repo path, so `/reload` still picks up local changes while developing it. It uses Pi 0.82.1's native lifecycle events rather than transcript polling:

- `session_start` emits `session-start`, followed by `stopped` when Pi starts idle; `before_agent_start` emits the title-bearing `user-prompt` event only after input handling/template expansion has actually produced an agent run.
- `agent_start` and `tool_execution_start` mark work active; `agent_settled` (not `agent_end`) marks the session idle because it fires only after retries, compaction, and queued continuations finish.
- `session_shutdown` ends replaced/quitting sessions, but ignores `reload` because reload replaces only the extension runtime and keeps the same Pi session.
- Pi has no general native "needs user attention" event (and intentionally has no built-in permission prompts), so the shared `blocked` state is not emitted by this integration yet.
- A serialized HTTP sender preserves event order; delivery goes through the SDK's shared `postHookEvent` (validate → discover → bounded POST), the same wire contract the Claude Code shim uses. Failures never affect Pi, but they are loggable: set `OVERFACTOR_DEBUG=1` to surface swallowed errors on stderr (a silently-swallowed schema drift is otherwise undebuggable).
- **Pi awaits `session_shutdown` handlers with no timeout of its own**, and the sender's `send()` resolves with the whole serialized queue — so the shutdown handler races the flush against a 500ms cap (`SHUTDOWN_FLUSH_TIMEOUT_MS`). Without the cap, quitting Pi right after a tool-heavy turn stalled the (already torn-down) terminal for up to ~15s of serial 1500ms POST timeouts against a wedged daemon.

The package lists `@earendil-works/pi-coding-agent` as a `*` peer per Pi package guidance and pins 0.82.1 as its development/type-check version. Its transitive `@google/genai` and `protobufjs` install scripts are explicitly declined; shipped package artifacts are sufficient for extension typing/runtime.

## 2026-08-15 — resolved — daemon watcher starvation and stuck-process recovery

The repo watcher could make the daemon look alive-but-dead: chokidar recursively crawled every tracked repo before its native watcher became ready. With the large Phoenix checkout tracked, the daemon reached ~3.2 GB RSS, spent its main thread creating/closing FSEvent streams, held port 41417 without answering `/health`, and eventually took down the `vp run dev` process group.

- Repo change detection uses Node's native recursive `fs.watch` **on macOS/Windows only** — those are the platforms where it maps to the OS watcher (FSEvents/ReadDirectoryChangesW) with no startup crawl. On Linux, Node emulates recursion in JS with a synchronous full-tree scan and one inotify watch per file (worse than chokidar), so the daemon falls back to chokidar with watcher-level `.git`/`node_modules` ignores there. Chokidar also still watches the tiny `~/.overfactor` config directory.
- Watch events pass through a lazy `ignore` 7.0.5 matcher (root + nested `.gitignore` chain, negation, ignored-parent rule, cache invalidation on `.gitignore` change). Ordering matters: the unconditional `.git`/`node_modules` exclusion runs **before** the invalidation check, otherwise `pnpm install` (thousands of `node_modules/**/.gitignore` events) wipes the cache per event. The async ignore check re-checks `closing` and current tracked-repo config when it resolves, so in-flight events cannot re-arm timers past shutdown or after an untrack. Errored watchers re-arm after 5s (Node kills the handle before emitting `error`; without re-arm one transient error froze diff stats until restart).
- Known matcher gap: `.git/info/exclude` and the global `core.excludesFile` are not consulted (just-git has a git-faithful ignore engine, but v2 doesn't export it — upstream candidate). The cost is bounded because `setDiffForCwd` is a no-op when recomputed stats are unchanged: noise events cause a debounced recompute but no `updatedAt` churn and no WS invalidation.
- The CLI distinguishes healthy / unresponsive / stale: `stop` only ever signals a pid that answered `/health` or that **lsof verifies is LISTENing on the daemon port** — never a pid read off a possibly-stale `daemon.json` (pid recycling would kill an innocent process); with the port free it just removes the stale file. `start` is blocked only by a live listener (bind-is-the-lock; a stale file alone never blocks), and SIGTERM→SIGKILL escalation exists for wedged event loops. Graceful shutdown closes WS clients and remaining connections before `server.close()` — otherwise an open app connection keeps `close()` pending forever and every stop ends in SIGKILL.

A live probe against this repo verified that a `*.local` event leaves session `updatedAt` unchanged while an unignored file event triggers diff recomputation. With both Overfactor and Phoenix tracked, the replacement daemon remained responsive at ~130 MB RSS with roughly 30 open files (re-measured post-review-fixes: 114 MB RSS, 33 fds, sub-millisecond `/health`).

Watch-side memory is solved; **diff-side is the next constraint**: `computeDiffStats` runs in-process, and just-git's pure-TS `diff HEAD --numstat` on the Phoenix checkout (7.2k tracked files, 13 GB) takes ~1.3 s with a ~640 MB peak RSS in an isolated measurement (system git: 45 ms). No session has run in Phoenix yet, so the daemon hasn't paid this — but the first agent session there will spike daemon RSS per debounced recompute. When that lands, move diff computation to a subprocess (or system-git it for large repos) rather than letting V8 hold the spike.

## 2026-08-15 — implemented — Change Request foundation (goal 3, stage 1)

Sessions now group into CRs automatically, keyed by **(tracked repo, worktree branch)**. Sessions on the repo's default branch (origin/HEAD, falling back to main/master) stay in "Ungrouped chats", matching the design mock. A manual pin (`POST /sessions/:id/cr`) overrides automatic grouping; effective CR is computed at read time (pin ?? branch match). Constraints discovered:

- **Worktree git reads moved to system git subprocesses**, superseding "just-git for worktree diffs": on a 7.2k-file repo just-git cost ~1.5s/~660MB in-process vs system git's ~40ms/~10MB, and it misreports committed symlinks (upstream: https://github.com/blindmansion/just-git/issues/4, maintainer aware). Decided (Tony): just-git **dogfooding concentrates on the sandbox slice** — worktree creation and the embeddable server, the workload v2 was vendored for — rather than the daemon's read-only hot path. The daemon↔just-git dependency edge returns when sandboxes land.
- **`--no-ext-diff` is mandatory** on every `git diff` the daemon runs: users configure `diff.external` (this machine: difftastic), which replaces the unified patch with tool output the renderer cannot parse. Caught by the app tests running under real user gitconfig.
- **Linked `git worktree` checkouts live outside the tracked repo root**, so events from them fail prefix matching. The resolver falls back to `git rev-parse --git-common-dir` to find the main worktree — and must compare via a **realpath index** of tracked repos, because git reports physical paths while config may store symlinked ones (/tmp vs /private/tmp).
- Old daemon.db files are migrated in place (PRAGMA table_info + ALTER TABLE) for the new `branch`/`cr_id` session columns; the `change_requests` table is keyed unique on (repo_path, branch).
- Deferred to the next stages: GitHub PR detection (gh→octokit) onto the CR's `pr_*` columns, the pin/chat-selector UI, a CR-level pane, and file-watching inside linked worktrees (their diffs currently refresh on hook events only).

## 2026-08-16 — implemented — transcript sync + review-mode toggle

The session detail is now a two-pane review surface: diff experiences on the left ("All files" | "Curated review"), the live transcript in a resizable right panel (shadcn resizable / react-resizable-panels; note its current API takes `orientation`, not `direction`).

- **Transcript parsing is agent-owned**: `@overfactor/integration-claude-code/transcript` and `@overfactor/integration-pi/transcript` parse their agents' native files into the SDK's neutral `TranscriptEntry` (loose schemas — formats grow fields). Claude Code: skip `isMeta`/`isSidechain` lines and thinking blocks; map tool_use ids → names so tool_results are labeled. Pi (v3): `message` lines with roles user/assistant/toolResult, `toolCall` blocks, `compaction` → system entry; `custom_message` context injections skipped.
- The daemon serves a parsed tail (`GET /sessions/:id/transcript`, last 200 entries + totalCount) and watches live sessions' transcript files, broadcasting a debounced `transcripts` WS invalidation — verified: appended transcript lines appear in the panel without refresh.
- **Markdown via streamdown**, which requires a tailwind `@source` directive pointing at its dist (see globals.css); tool entries render as labeled code cards. Panel pins to bottom only while the user is already near it.
- Tool transcript entries carry native `toolCallId` + `toolPhase` metadata. Empty native results are retained as `_No output._` so completion remains observable. The renderer uses this to collapse adjacent tool runs into expandable count dividers while leaving the final unmatched invocation visible; expanded dividers are sticky within the transcript scroll container.
- **Scroll architecture changed**: the app is now viewport-bound (`SidebarInset h-svh overflow-hidden`) and the diff pane is its own scroll container — position:sticky (file tree, curated group summaries) binds to the pane. The earlier "document is the scroll container" comment no longer applies.
- Curated review's directory grouping is an explicit structural stand-in: the component's shape (groups → sticky summary + files + mark-reviewed) is what Guided Review's generated intent groups will fill.

## 2026-08-16 — implemented — transcript conversation styling

Transcript rendering now composes the generated shadcn `Message`, `Bubble`, and `Marker` primitives: user prompts use restrained neutral bubbles, assistant prose stays unframed, compaction summaries and tool activity use collapsed expandable markers, and other system notes use separators. The transcript owns an explicit native UI font stack, compact markdown heading scale, wider gutters, and a centered readable content width; code remains on the existing streamdown/shiki theme domain.

## 2026-08-16 — implemented — repo-first sidebar hierarchy

The sidebar now treats repositories as the primary navigation container instead of maintaining separate Repos and chat sections. Every tracked repo is shown (including empty ones); its CRs and non-CR branch groups are nested beneath it. Default-branch sessions remain non-CRs but are visibly grouped under their branch name, while detached/unresolved sessions use a dedicated fallback group. Historical sessions and CRs from untracked repos remain visible, but only tracked repo headers expose the untrack action.

## 2026-08-16 — implemented — session filters and archival

Session archival is a durable sqlite-backed flag independent of lifecycle state: future hook events continue updating an archived session without restoring it. The sidebar hides archived sessions by default, can include them with the Archived filter, and exposes archive/restore actions on chat hover. Lifecycle filter buttons are renderer-local visibility controls; repositories remain visible even when all their chats are filtered out. Existing databases migrate archived to false.

## 2026-08-16 — implemented — last-used session model

Sessions persist the most recent model found on an assistant transcript record and expose it through the shared SDK. The transcript is the source of truth rather than startup hooks: both Pi and Claude Code record a model on assistant messages, so this tracks model switches and works for historical sessions without expanding agent-specific hook contracts. The daemon refreshes model/title metadata together as live transcript files change and backfills existing ended sessions at startup. Until an assistant message reports a model, the value remains null and the UI shows “Model not reported.” The model appears as the third row of each sidebar chat and in the transcript header. Metadata extraction re-reads the whole transcript on every change, so both integrations substring-filter lines (`"ai-title"`/`"session_info"`/`"model"`) before JSON parsing, and the startup backfill skips sessions that already recorded a model — parsing every line of large transcripts on each daemon start was a measurable regression.

## 2026-08-16 — implemented — continuing conversations from the transcript

Agent integrations now publish SDK-validated capability manifests through `GET /agents`; the renderer checks the `continue-conversation` enum before mounting a transcript composer. Pi advertises the capability, while Claude Code intentionally does not: the current Claude integration is an outbound-only hook shim, and Claude's resume/Remote Control features do not provide a safe local input API for an already-running hook-observed session.

- The app queues validated prompts in the daemon; the live Pi extension polls its session inbox and calls Pi 0.82.1's native `sendUserMessage` API. Idle sessions start a turn immediately; working sessions receive the app prompt as a `followUp`. Messages remain queued until the extension acknowledges native acceptance. The queue is intentionally in-memory and capped at 20 messages per session. Pending prompts survive a Pi `session-end` because Pi can resume the same native session ID in a replacement process; clearing on process exit silently lost accepted prompts during exactly that handoff. They still do not survive a daemon restart. Delivery is at-least-once with a bound: if `sendUserMessage` keeps throwing, the receiver acknowledges (drops) the message after 3 attempts so a poison message cannot block the session's FIFO queue until a daemon restart.
- Pi `/reload` can re-evaluate an extension while background polling work from the previous extension instance is still alive. This was reproduced against the real interactive TUI as duplicate delivery after reload. Conversation receiver ownership therefore lives in a process-global, per-session registry: a newly evaluated instance stops and replaces any stale poller before subscribing. A post-fix TUI reload delivered one queued prompt exactly once.
- The composer uses shadcn CLI-generated `Attachment`, `Input Group`, and `Textarea` primitives. Dropped/selected files remain local attachment previews until submit, when their absolute paths are serialized into the prompt. Electron 43 removed `File.path`, so the context-isolated preload resolves native dropped files with `webUtils.getPathForFile`; the renderer still zod-validates the returned bridge value.

## 2026-08-17 — implemented — tooling: anti-slop lint policy

The repo vendors the anti-slop Oxlint plugin under `tools/oxlint/anti-slop` and enables all 15 rules as errors from the root Vite+ config. `oxlint` and `@oxlint/plugins` are pinned together through the pnpm catalog; the vendored plugin and agent-tool directories are excluded from both linting and formatting. The initial migration preserved behavior while replacing assertion chains, conditional empty spreads, widened object maps, runtime representation checks, and unparsed test fixtures. Boundary-sensitive findings were resolved by validating Electron IPC values in preload, modeling transcript content as schema-produced tagged values while retaining tolerant fallbacks for unfamiliar external shapes, and normalizing arbitrary rejection and watcher values into `Error` instances at the logging boundary. `vp check` is green with the full policy enabled.

## 2026-08-17 — implemented — curated review engine plumbing (goal 3, stage 1)

Reviews are keyed by branch: one per (repoPath, branch), enforced by a unique index, shared by every session working on it. (They briefly shipped keyed by CR-else-session, which duplicated reviews across concurrent default-branch sessions — N sessions on main produced N identical reviews of the same worktree. Pre-release, so the old table shape is dropped on open rather than migrated.) The subject patch is the branch's committed three-dot diff against the default branch **plus** the uncommitted worktree changes of a session on the branch (live preferred), because agents commit late and the uncommitted half is often the whole story; on the default branch the committed half is empty by construction. In the app the review is a first-class navigation peer: sidebar branch/CR header rows are selectable and open the review in the main pane, and session detail links to it ("View review") instead of embedding it. Engines live in the integration packages (invocation knowledge stays with the plugin, advertised via the `generate-review` capability); the daemon's `ReviewRunner` selects one by majority agent among the subject's sessions, single-flights per subject, and normalizes engine output with `normalizeReviewGroups` (drop unknown files, first assignment wins, sweep misses into "Everything else") so a sloppy grouping degrades instead of failing. Practical constraints discovered:

- **Review generation always pins a model** (decided 2026-08-17, Tony's concern): `claude -p` without `--model` inherits the user's CLI default, which may be a top-tier model — silently expensive per generation. The engine defaults to the `sonnet` alias (tracks the latest Sonnet; ample for grouping/guidance), each `ReviewEngine` carries an explicit `defaultModel`, the runner records the effective model on the review row, and the UI shows `engine (model)` in the review header. The settings-page engine policy overrides this later; the invariant to keep is "never inherit a harness's own default model".
- The Claude engine spawns the user's own `claude -p --output-format json` (piggybacks CLI auth; no API keys — same posture as gh→octokit). stdout is a single JSON object with `result: string` and `is_error`; the result may still carry prose/fences, so extraction slices the first `{` to the last `}` and retries once with the validation error folded into the prompt.
- A spawned `claude -p` inherits the environment, so its **own hook shim posts SessionStart/Stop back to the daemon**, materializing a phantom "session" whose title is the review prompt. The engine spawns with `OVERFACTOR_DIR=/nonexistent/...` so hook discovery finds no daemon and the events are dropped. Any future engine that shells out to a hook-installed agent needs the same suppression.
- Reviewed marks persist per group name and survive regeneration only for groups that still exist; `beginReview` upserts to `generating` while preserving prior groups so the UI keeps showing the old review during regeneration. Regeneration passes `previousGroups` to the engine with an instruction to keep unchanged groups stable — verified live: a regeneration over a grown diff kept the original group name.
- Live verification: a real `claude -p` generation over a 2-file fixture diff returned a sensible intent group in ~4s and the UI updated over the WS `reviews` invalidation with no manual refresh.
- Prompt framing matters more than schema: asking for "groups with summaries" produced changelog-style summarization. Reframing as a guided walkthrough — steps in review order (core → wiring → tests, mechanical churn last as "Supporting changes"), summaries addressed to the reviewer with what to verify and where a bug would hide — produced materially better output on the same schema (it caught an added-but-unused dependency unprompted). The UI renders one step at a time (Linear-guided-diff style: step index + narrative + that step's diffs only) instead of stacking all groups in one scroll. Within a step, low-signal files start as collapsed bars (`lib/diff-noise.ts`: lockfile names, generated-output paths/extensions, >300 changed lines) so handwritten changes carry the visual weight; detection is path-heuristic only — being wrong costs the reviewer one expand click, so precision beats recall there.

## 2026-08-17 — resolved — sandboxed UI testing: shared agent-browser state and zombie Electrons

Two failure modes wasted a debugging hour and looked like app bugs:

- `agent-browser` runs one per-user daemon; its **default session is shared across every Claude/terminal session on the machine**. A concurrent session's `open`/`connect` re-pointed and navigated this session's Electron window mid-test (symptoms: clicks that "succeed" but change nothing, the window suddenly showing an unrelated app). Always pass an isolated `--session <name>` for every agent-browser command; never use the default session and never `agent-browser close` without `--session` (it can sever another session's browser). The "Code generation from strings disallowed" errors seen during that debugging were initially blamed on cross-talk but turned out to be the real preload/CSP/zod bug below.
- `pkill -f "electron-vite dev"` kills the wrapper but **orphans the Electron child**, which keeps ports 5173+ and the CDP port. The next launch silently binds 5176 while `agent-browser connect` reattaches to the zombie's stale window on the old port. Kill the Electron processes too (`pgrep -fl "repos/overfactor.*electron/dist.*MacOS/Electron"`) and confirm the app log does not say "Port 5173 is in use" before connecting.

## 2026-08-17 — resolved — `vp run dev` daemon race (app "cannot connect to the daemon")

The daemon-build lane (`vp pack --watch`) **cleans `packages/daemon/dist` when it starts**, deleting `cli.mjs` right as the daemon lane's `node --watch dist/cli.mjs daemon start` spawns. Losing the race meant MODULE_NOT_FOUND; `node --watch` survives and restarts once the rebuild lands, but that leaves the app disconnected for the length of the initial watch rebuild (~30s uncached; indefinitely if a watch build errors), and a failed `daemon stop` in the old `&&` chain could kill the lane outright. The pre-build used to win this race only by timing (build caching); with the cache disabled it lost reliably. The daemon lane now runs `scripts/dev-daemon.mjs`, which waits for `dist/cli.mjs` to exist and stay stable for 500ms (initial clean + re-emit finished) before the stop/start handoff to `node --watch`. General lesson: never point `node --watch` (or anything exec-ing a dist file) at output that a concurrently-starting watcher cleans — sequence on the artifact, not on luck.

## 2026-08-17 — resolved — preload zod parsing dies under the renderer CSP ("Daemon not running" forever)

The app polls `window.overfactor.getDaemonInfo()`; the preload zod-validates the IPC result. This chain broke with `EvalError: Code generation from strings disallowed for this context`, leaving the renderer's poll loop dead and the UI stuck on "Daemon not running" even with a healthy daemon. Root cause is a three-way timing interaction:

- The renderer's CSP (`default-src 'self'`, no `unsafe-eval`) is a `<meta http-equiv>` tag, applied when the document parses. **The preload evaluates before that**, so codegen is still allowed at preload-module-load time.
- zod v4 captures its eval-availability probe and `jit` flag **per object schema at construction**. SDK schemas construct during the preload's import — pre-CSP — so they lock in `fastEnabled = true`.
- The compiled "fastpass" is built lazily at **first parse**, which happens on the renderer's first poll — post-CSP — so `new Function` throws. The `EvalError` is not a `ZodError`, escapes `safeParse`, and rejects across the contextBridge.

The failure is invisible to `agent-browser errors`/`console` (an unhandled rejection inside the bridge) and heisenbug-shaped: any `safeParse` executed at preload time (e.g. a debug probe) compiles the fastpass pre-CSP and "fixes" the app — which is exactly how earlier live verification passed while the cleaned-up build failed. Fix: the preload passes `{ jitless: true }` on every parse of an SDK-constructed schema (per-call `ParseContext.jitless` beats fast-path selection), plus a module-level `z.config({ jitless: true })` covering schemas constructed inside the preload. A top-level `z.config` alone does NOT work — it runs after the SDK's import already constructed its schemas. Renderer code is unaffected (its zod loads post-CSP, so the probe fails cleanly and zod interprets), and daemon/tests keep the fast path.

## 2026-08-18 — implemented — PR detection and manual branch/PR tracking (goal 3)

GitHub access piggybacks `gh auth token` → octokit (decided 2026-08-15; no auth UX). Everything degrades gracefully to "no PR features" when gh is absent. Non-obvious choices:

- **Detection is scoped to branches Overfactor already tracks** (CR rows), never "every open PR in the repo" — one `pulls.list` call per repo per 2-minute scan matched locally against CR branches, so a teammate-heavy repo doesn't flood the sidebar. A stamped PR that leaves the open list is resolved individually to merged/closed. Stamping is no-op-idempotent (no WS churn), and the detection hook — which auto-generates the review — fires only when a CR _gains_ a PR, never on state transitions.
- **Manual tracking creates CRs without sessions**, which required un-hiding session-less CRs in the sidebar grouping (they were filtered out; they are now exactly the collaborator-review case). Tracking the default branch is rejected: a CR for it would capture every default-branch session into a group via the branch-match rule, breaking the "ungrouped main sessions" semantics.
- **Remote-only branches materialize via `git branch --no-track <b> origin/<b>`** — no checkout needed; the three-dot review diff only needs a local ref. PR paste fetches `pull/N/head:<headRef>` (works for fork PRs) and adds a worktree under `~/.overfactor/worktrees/<repo>-pr-<n>-<branch>`; a branch checked out elsewhere can't be force-updated and is reused as-is.
- PR links in the renderer use `window.open`, routed to `shell.openExternal` by a main-process `setWindowOpenHandler` (https-only, everything else denied) — an `<a>` can't nest inside the row's `<button>`.

## 2026-08-18 — resolved — review engine: blind truncation swallowed most of large diffs

A live review of a 391-file branch (phoenix-3 `pxi-execute-ui-sandbox-hardening`, 1.39 MB subject patch) exposed the failure mode of the engine's flat 150k-char slice: git orders diffs alphabetically, so the cut landed mid-`datasetEvaluatorForEdit` — the model grouped only the first ~53 files and `normalizeReviewGroups` swept the other 338 (87%, including the branch's namesake sandbox hardening and the entire Python side) into "Everything else". Within the visible slice it then led with two small robustness fixes, burying the structural core at step 3. Fixes in `packages/integration-claude-code/src/review.ts`:

- **Manifest + per-file body budgeting replace the flat slice** (`renderPatchForReview`): `<files>` always lists every changed file with status (A/M/D) and line counts; `<diff>` includes bodies whole-file until budget, collapses deleted/lockfile/`__generated__` bodies unconditionally, and marks every omission with an explicit stub. Grouping is now complete even when bodies are omitted — the model groups stub files by path, status, and size. Manifest path extraction deliberately matches the daemon's `changedFilesFromPatch` so emitted paths survive normalization.
- **Ordering rule made explicit**: step 1 is the change the branch/CR title names or the one the rest support; small fixes and enabling refactors never lead a large change; deleted files belong with the step that retires them; step count scales to 10 for large changes instead of forcing a catch-all.
- **previousGroups softened**: the old "restructure only where the diff moved" anchored a bad grouping forever (regeneration of the mis-grouped review kept its skeleton). Now: preserve unchanged well-formed groups (reviewed marks key on names), but groups violating the rules — a catch-all, mis-ordered steps — are fair to restructure.
- **Timeout scales with output size**: the every-file-listed contract makes output grow with file count; the 391-file generation exceeded the 5-min default (`claude timed out after 300s`), now 10 min.

Verified live: fresh generation over the same patch produced 10 steps covering all 391 files with no catch-all (runtime sandbox → catalog/approval plumbing → per-domain migrations → registry wiring → UI → server-side retirement → generated artifacts last). Intent remains thin for PR-tracked CRs (no session titles); commit subjects of the branch are a candidate future intent source.

## 2026-08-15 — note — docs: reading design.html

`design.html` is a self-extracting bundle, not plain HTML — content lives in `<script type="__bundler/manifest">` (per-asset gzip+base64 JSON) and `<script type="__bundler/template">` (JSON-encoded HTML string). To read it without a browser: parse those two blocks, base64-decode + gunzip manifest entries, `json.loads` the template. The rendered doc is the internal working spec (concepts, flow, UI mock, decisions); the prior marketing draft is kept separately as "Switchyard Product Sheet".
