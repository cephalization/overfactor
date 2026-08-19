# Overfactor

Desktop app + background daemon for managing, reviewing, testing, and changing agent-written code in a shared repo. Agent CLIs (Claude Code and Pi) report their sessions to a local daemon through native hook/extension integrations; the Electron app shows every session live — title, lifecycle state, last-used model, transcript, and the diff it is producing. Capable integrations can continue the conversation directly from the transcript pane and generate branch-level guided review walkthroughs.

See `design.html` for the product spec, `GOALS.md` for priorities, `FINDINGS.md` for technical decisions, `AGENTS.md` for engineering rules, and `TESTING.md` for manual and agent-driven testing steps.

## Layout

- `apps/desktop` — Electron app (electron-vite, React, shadcn/ui, TanStack Query + DB).
- `packages/daemon` — the Overfactor daemon and `overfactor` CLI (Hono HTTP + WS on 127.0.0.1, sqlite persistence, diff stats via just-git).
- `packages/sdk` — zod v4 contracts shared by every I/O boundary, plus daemon discovery helpers.
- `packages/integration-claude-code` — Claude Code hooks/transcript integration and one-shot guided-review engine.
- `packages/integration-pi` — Pi package/extension for lifecycle events, transcripts, live conversation input, and one-shot guided reviews.
- `packages/integration-utils` — harness-neutral review prompt, patch-budgeting, structured-output, and subprocess utilities shared by both integrations.
- `packages/just-git` — git submodule of [just-git](https://github.com/blindmansion/just-git) `v2` (pure-TS git), vendored until v2 ships to npm. Excluded from workspace-wide checks/tests; built by `vp run -r build`.

## Development

This is a pnpm-managed [Vite+](https://viteplus.dev) monorepo — use `vp <command>` for everything.

```bash
git submodule update --init   # just-git v2
vp install
vp run -r build               # builds all packages (incl. just-git's tsc build)
vp run ready                  # format + lint + test + build
```

After any change: `vp check` and `vp test`.

## Running slice one

```bash
# 1. spin up everything (daemon + app, hot reloading; Ctrl-C tears it all down)
vp run dev

# 2. first launch: use the fullscreen onboarding to install either integration (or both)
# CLI alternatives:
pnpm overfactor install claude-code   # writes ~/.claude/settings.json
pnpm overfactor install pi            # writes ~/.pi/agent/settings.json (all projects)
```

The first-run onboarding appears before daemon connection is required, explains the local architecture, installs selected integrations, and previews repository/branch grouping plus curated reviews. Replay it from Settings, or use the sidebar Plugins button to install another integration later. Both installs are user-level, so sessions report from every tracked repo — not just this one. Open Pi sessions pick the extension up after `/reload` or a restart.

`vp run dev` is idempotent: it prebuilds the daemon and its deps, replaces any already-running daemon with the fresh build, watches `packages/*` sources (the daemon auto-restarts on rebuild), and hot-reloads the app (renderer via Vite, main/preload via electron-vite `-w`). For the daemon or app alone: `overfactor daemon start` / `vp run @overfactor/desktop#dev`.

The `overfactor` CLI is linked into the workspace root — run it from anywhere in the repo as `pnpm overfactor <command>` (to put it on your PATH globally: `pnpm -C packages/daemon link --global`). Track a repo from the add button in the sidebar header (native directory picker), or with `pnpm overfactor repo add <path>` — both write the same config and apply live to a running daemon. Start a `claude` or `pi` session inside a tracked repo; it appears under that repo with live state and diff stats. Branch/CR rows open a curated walkthrough, generated through the review agent/provider/model selected on the Settings page. Active Pi sessions expose a transcript composer; dropped files appear as attachment previews and are sent to Pi as absolute paths. Sidebar filters can hide lifecycle states or reveal archived sessions, and each chat can be archived or restored from its hover action. The daemon publishes its port to `~/.overfactor/daemon.json`; the app discovers it automatically and reconnects through daemon restarts.
