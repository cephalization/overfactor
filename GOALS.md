# Goals

The outcomes Overfactor is pursuing, in priority order. Not a task tracker, issue list, or changelog — see git history and any issue tracker for that.

1. ~~**Slice one — daemon → live sidebar.**~~ **Done 2026-08-15.** A standalone daemon receives events from the Claude Code hooks integration via the typed SDK; the Electron app shows live sessions with title, agent, lifecycle state (working/idle/blocked), and live diff stats, plus repo tracking from the GUI and a read-only session detail pane. Verified against a real `claude` session.
2. ~~**Pi integration**~~ **Done 2026-08-15.** A Pi package installed user-level (`overfactor install pi`) maps native session, prompt, agent, tool, settled, and shutdown events onto the shared SDK and reports them to the daemon from every tracked repo, without affecting Pi when Overfactor is unavailable.
3. **Change Requests** — group sessions into CRs (automatic + pinning + chat selector); GitHub issue/PR detection against them.
4. **Guided review** — intent-grouped review generated per PR, regenerated diff-aware on update; keyboard-first.
5. **Sandboxes** — CR branch running in Docker behind Caddy at a stable `cr-N.<app>.localhost` domain.
6. **Team sync** — live-share style session sharing (architecture TBD; plan for a sync engine + server process).
