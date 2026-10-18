# Changelog

## 0.1.0 — 2026-10-18

First release.

- Hooks: SessionStart (session count, weekly stale-skill reminder), UserPromptSubmit (corrections, `/skill` hits), PostToolUse and PostToolUseFailure (shell outcomes, Skill-tool hits), Stop (one nudge per hard-won arc: `auto`, `suggest` or `off`).
- Skills: `capture` (gate, update-before-create, scope choice, write, register), `prune` (user-only review of stale, bloated and overlapping skills), `status` (list, history, rollback, restore, adopt, signals).
- CLI `scripts/evolution.mjs` with zero dependencies: version stamps in frontmatter `metadata`, content-hash change detection, snapshots, per-skill `CHANGELOG.md`, reversible archive, usage ledger.
