# Agent Guidelines

This document contains stable guidance for anyone making changes in Overfactor. Read it before editing code, then read `FINDINGS.md` for current technical knowledge and `GOALS.md` for product priorities.

## Document Roles

- `AGENTS.md` defines how work should be approached. Keep it concise and stable.
- `FINDINGS.md` records technical discoveries, constraints, resolved bugs, and decisions that future work should know.
- `GOALS.md` orders the outcomes the project is pursuing. It is not a task tracker or changelog.
- `README.md` explains the project to a new developer or user.

Do not duplicate the same information across all four documents. Update the document whose role matches the new information.

## Before Making Changes

1. Read `FINDINGS.md` and `GOALS.md`.
2. Inspect the affected code, components, and existing patterns before choosing an implementation.
3. Check the exact installed package versions in the manifest (e.g. `package.json`) before relying on a library's behavior.
4. When consulting external documentation, use the version matching what is actually installed — behavior changes materially between releases.
5. Preserve unrelated work in a dirty worktree.

## Architecture Rules

- Prefer existing components, patterns, and tokens before introducing another abstraction or dependency.
- Avoid compatibility layers or backwards-compatibility shims without a concrete, currently-real requirement driving them.
- Do not design for hypothetical future requirements; keep implementations no bigger than the task in front of you.

## Validation

Run the project's standard checks (typecheck/lint/tests) after every change. For changes touching build config, routing, or platform-level concerns, run any heavier verification available (e.g. a full build/export).

*(Placeholder: fill in the exact commands once the stack and tooling are chosen.)*

## Documentation Updates

Update `FINDINGS.md` when work reveals a non-obvious constraint, reusable pattern, root cause, or decision. Include the date, status, affected area, and practical implication.

Update `GOALS.md` only when product priorities or completion criteria change. Do not add implementation checklists, issue-level tasks, or transient bugs there.

Change `AGENTS.md` when a new stable engineering or collaboration rule should govern future work.

## Safety

- Never commit credentials, tokens, or private data.
- Do not weaken security silently. Document intentional exceptions.
- Do not remove existing configuration or workarounds without first reproducing why they were added.
- Do not commit, push, or publish unless explicitly requested.
