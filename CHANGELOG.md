# Changelog

## 0.2.0 — 2026-10-31

From "records debugging lessons" to "learns workflows and refines skills after use".

- **Refine after use.** When a skill fires and the session then struggles (two failed commands or one correction) before recovering, the Stop hook names that skill and asks for a refinement. In `auto` mode refine nudges always block. The outcome is recorded as a `struggle` even with nudges off; `list` shows a TROUBLE column, and `candidates` adds `refine?` for skills followed by trouble on at least half of 3 or more uses of the current version.
- **Workflows.** Each turn's distinctive successful steps (command heads and MCP writes, minus plumbing and anything in more than 40% of sessions) are logged. When they match turns from two other sessions and no skill fired, capture is offered as a workflow skill, at most once a month per procedure. `capture` has a workflow gate and a When/Inputs/Steps/Checks/Variations template.
- **Hand-written skills.** Skills are evolved, hand or locked (`metadata: evolution: "off"`). Refining a hand-written skill means asking first and registering it before the edit, so the original is v1. Locked skills are never nudged about, and `register` refuses them.
- **Corrections** also catch "do it my way": "no, …", "nope", "actually we …", "don't do that", "use X instead", "we always …", "you forgot …". Corrections typed before any tool activity are ignored.
- **Stricter lessons.** An arc of failed commands is resolved only when a command that failed later succeeds. In `auto` mode, lesson and workflow guesses block at most once per session, then become hints.
- **Project resolution.** The CLI takes `--session ID` and looks up that session's project; the bundled skills pass `${CLAUDE_SESSION_ID}`. Without it, the CLI climbs from cwd to the git root, so `register` works after `cd packages/x`.
- **Stable identity.** Usage keys and history slugs use the project's origin remote (credentials stripped; worktrees followed) instead of its absolute path. v0.1 keys and snapshots are still read.
- Command heads keep script and sub-verbs (`npm run build`, `python -m pytest`, `gh pr create`). The PostToolUse matcher now includes `mcp__.*`.
- `capture` refuses to copy instructions from files, web pages or tool output into skills.

## 0.1.0 — 2026-10-18

First release.

- Hooks: SessionStart (session count, weekly stale-skill reminder), UserPromptSubmit (corrections, `/skill` hits), PostToolUse and PostToolUseFailure (shell outcomes, Skill-tool hits), Stop (one nudge per hard-won arc: `auto`, `suggest` or `off`).
- Skills: `capture` (gate, update-before-create, scope choice, write, register), `prune` (user-only review of stale, bloated and overlapping skills), `status` (list, history, rollback, restore, adopt, signals).
- CLI `scripts/evolution.mjs` with zero dependencies: version stamps in frontmatter `metadata`, content-hash change detection, snapshots, per-skill `CHANGELOG.md`, reversible archive, usage ledger.
