> **Agents:** load only your section with `sed -n '/^## Agent testing/,$p' TESTING.md`

# Testing Overfactor

## Quick start

```bash
git submodule update --init && vp install && vp run -r build   # once per checkout
pnpm overfactor install claude-code                            # once; writes ~/.claude/settings.json
pnpm overfactor install pi                                     # once; writes ~/.pi/agent/settings.json
vp run dev                                                     # daemon + app, hot reloading; Ctrl-C cleans up
```

`vp run dev` is idempotent — it rebuilds, replaces any running daemon, and watches everything (daemon restarts on rebuild; renderer/main hot-reload). Automated suite: `vp check && vp test`. Full sweep: `vp run ready`.

If testing outside `vp run dev` (e.g. a detached `overfactor daemon start`), rebuild after source changes (`vp run -r build`) and restart the daemon — CLI, hook shim, and workspace imports resolve from `dist/`.

## Manual testing (humans)

Run the quick start, then walk the list. Each item states the expected result.

1. **Daemon discovery** — Quit the daemon (`overfactor daemon stop`) with the app open: main pane shows "Daemon not running". Start it again: the app reconnects within ~2 s, header shows the port.
2. **Track a repo (GUI)** — Repos → folder-plus button → pick a git repo: it appears in the list (basename, full path on hover). Pick a non-git directory: inline "Not a git repo" error, nothing tracked.
3. **Track a repo (CLI, live)** — With the app open: `pnpm overfactor repo add <path>` — the repo appears in the sidebar without any restart.
4. **Claude session appears** — Run `claude` inside a tracked repo and send a prompt: a session row appears within seconds, titled from your first prompt, with a pulsing green dot (working).
5. **Pi session appears** — Run `pi` in this trusted repo (use `/reload` if the integration was added after startup) and send a prompt: a Pi-labeled session row appears with the Pi session JSONL path and the same title/diff behavior.
6. **Lifecycle states** — While either agent runs tools: green/pulsing; when its turn settles: gray (idle). Claude Code permission notifications additionally show amber (blocked); Pi currently exposes no equivalent general attention event.
7. **Diff stats** — Have the agent edit tracked files: the row's `+/−` line counts and file count update live (staged + unstaged vs HEAD; untracked files are not counted).
8. **Untrack** — ✕ next to a repo removes it; new sessions in that repo no longer appear.
9. **Restart resilience** — `overfactor daemon stop && overfactor daemon start`: the app reconnects on its own and previously seen sessions are still listed (sqlite persistence).
10. **Change Request grouping** — Run sessions in a feature-branch worktree (`git worktree add ../wt -b feat/x`, then agents inside it): they appear under a `CR-N · <branch title>` sidebar group. Sessions on the repo's default branch appear under "Ungrouped chats".
11. **Session titles** — A resumed session (or one whose prompt event was missed) titles itself from the agent's own generated title (Claude Code `ai-title` / Pi session name) within ~2s of the daemon seeing its transcript. Double-click the detail-pane title (or hover → pencil) to rename inline: Enter saves, Escape cancels; the rename shows in the sidebar immediately and is never overwritten by later agent titles.
12. **Transcript panel** — With a session selected, the right-hand resizable panel shows the conversation (markdown, tool calls as labeled code cards). The transcript header and the session row's third line show the model from the latest assistant message; switch models and complete another response to verify both update live. Send the agent a new message: the panel updates live and stays pinned to the bottom unless you've scrolled up. Drag the handle to resize.
13. **Continue a Pi conversation** — Select an active Pi session: a composer appears below the transcript. Enter sends; Shift+Enter adds a newline. While Pi is working, submissions queue as follow-ups. Drop files or use the paperclip: attachment previews show above the composer, and submitting adds their absolute paths to the prompt. Claude Code sessions and ended Pi sessions do not show the composer because their current integrations cannot accept live input.
14. **Branch review navigation** — Reviews are branch-level: click a branch or CR header row in the sidebar (it highlights) and the guided review fills the main pane. Every session on that branch shares the same review; a session's detail header has a "View review" link that jumps to it. Session detail itself shows only the session's own worktree diff.
15. **Guided review generation** — Open a branch review with changes and no review yet: a model input (placeholder `sonnet`, the pinned default — reviews never inherit your CLI default model) and a "Generate review" button appear, with a preview of the `claude -p … --model <alias>` command that updates as you type. The review header afterwards shows `engine (model)`, and Regenerate reuses the recorded model. Click it: a generating state shows, then (via your own `claude -p` login) a stepped walkthrough renders — step index (01/04), step title, reviewer-directed guidance, that step's file chips and diffs only, prev/next navigation, and a step list. Steps are ordered core change → wiring → tests, with mechanical churn last under "Supporting changes". Within a step, lockfiles, generated output (dist/, *.min.js, *.snap, protobuf output, …), and diffs over ~300 changed lines render as collapsed bars with a reason badge — click to expand. "Mark reviewed" marks the step and advances; the mark survives app and daemon restarts. Files changed after generation appear as a final "New changes since generation" step; Regenerate folds them in while keeping unchanged step names stable. The review covers the branch's committed diff against the default branch plus uncommitted worktree changes; a clean branch reports nothing to review; a missing `claude` CLI surfaces a "no-engine" error.
16. **PR detection** — With `gh` logged in, push a tracked branch and open a PR for it: within ~2 minutes (or immediately on daemon start) its CR row gains a colored `#N` badge (green open / purple merged / red closed) that opens the PR on GitHub, and the guided review auto-generates the moment the PR is first detected. Merging or closing the PR updates the badge on the next scan. Without gh, PR features are absent and everything else works.
17. **Track a branch or PR manually** — Each tracked repo has a branch-plus button next to its ✕. It opens a fuzzy-searchable list of local and remote branches (default branch excluded); picking one creates its CR — materializing remote-only branches locally without a checkout — and opens its guided review, letting you review collaborator work with no local session. Pasting a GitHub PR URL of that repo instead shows a "Fetch … into a worktree" action: it fetches the PR head (fork PRs included), creates a worktree under `~/.overfactor/worktrees/`, titles the CR from the PR, stamps the badge, and auto-generates the review. A PR URL from a different repo is rejected with a clear error.
18. **Session detail + diff view** — Click a session row: it highlights and the main pane shows the session header (state, agent, diff stats, repo) above the full diff — per-file cards with syntax highlighting, change-type icons, +/− counts, a toggleable file tree (git-status colors; click a file to jump to its card), and a unified/split toggle. Edit a tracked file while watching: stats and the diff body update live. A clean worktree says so instead of showing an empty diff. Code surfaces follow the OS light/dark scheme along with the shell.

## Agent testing (agent-browser)

Prereqs: `agent-browser` on PATH (`agent-browser skills get electron` for background). Everything below is sandboxed — **never** point tests at the real `~/.overfactor`, and never run `install claude-code` (it hooks the human's own agent sessions).

**Isolate your agent-browser session.** The agent-browser daemon is shared per user and its default session may be in use by another agent on this machine. Pass `--session <unique-name>` on **every** command (connect, snapshot, click, close) — sharing the default session lets concurrent agents navigate each other's windows, which presents as clicks that succeed but change nothing. Likewise use a unique `OVERFACTOR_CDP_PORT`, and if the app log says "Port 5173 is in use", a zombie Electron survived an earlier `pkill electron-vite` — kill the leftover Electron processes before connecting or you will drive a stale window.

The native directory picker cannot be driven over CDP — track repos through the daemon's HTTP API instead; humans cover the picker (manual item 2). Simulate agent sessions by piping Claude Code-shaped payloads through the real hook shim; no live agent needed. Guided review generation can be exercised without the UI: `POST /reviews/generate {"repoPath","branch"}` (expect 202, or 409 `empty-diff`/`no-engine`), poll `GET /reviews?repoPath=<url-encoded>&branch=<name>` until `status` leaves `generating`, and `POST /reviews/:id/groups {"group","reviewed"}` for marks. Sessions must report the branch before their worktree feeds the review — the daemon resolves it on event-driven diff recomputes, so allow ~2s after the hook events. A real generation shells out to `claude -p` with the daemon owner's login; the engine suppresses its own hook events, so no extra session should appear.

```bash
ROOT=$(git rev-parse --show-toplevel)    # run from the checkout
SBX=$(mktemp -d)                          # sandbox
export OVERFACTOR_DIR="$SBX/home" OVERFACTOR_PORT=45901
mkdir -p "$OVERFACTOR_DIR"

# Fixture repo with one commit (diff stats need a HEAD)
git init -q "$SBX/repo" && cd "$SBX/repo" && printf 'a\nb\n' > f.txt \
  && git add . && git -c user.name=t -c user.email=t@t.t commit -qm init && cd "$ROOT"

# Daemon (inherits the sandbox env), then the app with CDP enabled
node "$ROOT/packages/daemon/dist/cli.mjs" daemon start
cd "$ROOT/apps/desktop" && OVERFACTOR_CDP_PORT=9231 nohup ./node_modules/.bin/electron-vite dev > "$SBX/app.log" 2>&1 &
sleep 5 && agent-browser connect 9231
agent-browser snapshot -i        # expect: "Track a repo" button, "No repos tracked yet"

# Track the fixture repo (what the GUI's picker flow calls)
curl -s -X POST "http://127.0.0.1:$OVERFACTOR_PORT/repos" -H 'content-type: application/json' \
  -d "{\"path\":\"$SBX/repo\"}"

# Simulate a session through the real hook shim
shim() { echo "$1" | node "$ROOT/packages/integration-claude-code/dist/hook.mjs"; }
shim "{\"session_id\":\"t1\",\"transcript_path\":\"$SBX/t.jsonl\",\"cwd\":\"$SBX/repo\",\"hook_event_name\":\"SessionStart\"}"
shim "{\"session_id\":\"t1\",\"transcript_path\":\"$SBX/t.jsonl\",\"cwd\":\"$SBX/repo\",\"hook_event_name\":\"UserPromptSubmit\",\"prompt\":\"Ship the login page\"}"
printf 'a\nB\nc\n' > "$SBX/repo/f.txt"   # dirty the worktree -> diff stats
sleep 2 && agent-browser snapshot -i
# expect a session button: "Working Ship the login page Claude Code +2 −1 1 file"

shim "{\"session_id\":\"t1\",\"transcript_path\":\"$SBX/t.jsonl\",\"cwd\":\"$SBX/repo\",\"hook_event_name\":\"Stop\"}"
sleep 1 && agent-browser snapshot -i     # expect the same button now prefixed "Idle"

# Cleanup — always run, even on failure
agent-browser close
pkill -f "electron-vite dev"
node "$ROOT/packages/daemon/dist/cli.mjs" daemon stop
rm -rf "$SBX"
```

Assertion guide: `agent-browser snapshot -i` exposes lifecycle state, title, agent, and diff stats in each session button's accessible name — grep the snapshot instead of screenshotting. `agent-browser screenshot <path>` is for visual/theming checks only. Other hook events: `PreToolUse`/`PostToolUse` (+ `tool_name`) → working, `Notification` (+ `message`) → blocked, `SessionEnd` (+ `reason`) → ended.

Troubleshooting: sessions are detected only at event time (no transcript scanning or backfill) — a real agent session that never appears usually means its integration isn't installed user-level (`overfactor install claude-code` / `install pi`), the daemon was down when it ran, or its repo wasn't tracked yet. A session missing from the UI but present in `curl -s http://127.0.0.1:$OVERFACTOR_PORT/sessions` means the WS/refetch path broke; "Daemon not running" in the UI with a healthy daemon means `daemon.json` is missing from `$OVERFACTOR_DIR` or the app was launched without the sandbox env. The app's dev logs are in `$SBX/app.log`, the daemon's in `$OVERFACTOR_DIR/daemon.log`.
