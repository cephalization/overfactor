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
12. **Transcript panel** — With a session selected, the right-hand resizable panel shows the conversation (markdown, tool calls as labeled code cards). Send the agent a new message: the panel updates live and stays pinned to the bottom unless you've scrolled up. Drag the handle to resize.
13. **Review modes** — Above the diff, toggle "All files" (tree + flat file cards) vs "Curated review" (change groups with sticky summaries and per-group "Mark reviewed"; heuristic directory grouping until Guided Review generates intent groups).
14. **Session detail + diff view** — Click a session row: it highlights and the main pane shows the session header (state, agent, diff stats, repo) above the full diff — per-file cards with syntax highlighting, change-type icons, +/− counts, a toggleable file tree (git-status colors; click a file to jump to its card), and a unified/split toggle. Edit a tracked file while watching: stats and the diff body update live. A clean worktree says so instead of showing an empty diff. Code surfaces follow the OS light/dark scheme along with the shell.

## Agent testing (agent-browser)

Prereqs: `agent-browser` on PATH (`agent-browser skills get electron` for background). Everything below is sandboxed — **never** point tests at the real `~/.overfactor`, and never run `install claude-code` (it hooks the human's own agent sessions).

The native directory picker cannot be driven over CDP — track repos through the daemon's HTTP API instead; humans cover the picker (manual item 2). Simulate agent sessions by piping Claude Code-shaped payloads through the real hook shim; no live agent needed.

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
