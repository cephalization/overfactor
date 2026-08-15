# Goals

The outcomes Overfactor is pursuing, in priority order. Not a task tracker, issue list, or changelog — see git history and any issue tracker for that.

1. **Slice one — daemon → live sidebar.** A standalone daemon receives events from a Claude Code integration (hooks) via the typed SDK; the Electron app shows the live session sidebar from the design mock. Done when: starting a `claude` session in a configured repo makes it appear in the sidebar within seconds, with title, agent, lifecycle state (working/idle/blocked), and live diff stats (`git diff` of its worktree); read-only (no input to agents), one repo, no CR grouping.
2. **pi integration** — second agent plugin, proving the SDK generalizes beyond one harness.
3. **Change Requests** — group sessions into CRs (automatic + pinning + chat selector); GitHub issue/PR detection against them.
4. **Guided review** — intent-grouped review generated per PR, regenerated diff-aware on update; keyboard-first.
5. **Sandboxes** — CR branch running in Docker behind Caddy at a stable `cr-N.<app>.localhost` domain.
6. **Team sync** — live-share style session sharing (architecture TBD; plan for a sync engine + server process).
