---
name: status
description: List evolved skills with versions and usage, show a skill's history, or roll back, restore or adopt one. Use when asked what Claude has learned or to undo a skill change.
argument-hint: "[skill or question]"
---

# Evolution status

Below, `evolution <cmd>` means `node "${CLAUDE_PLUGIN_ROOT}/scripts/evolution.mjs" --session "${CLAUDE_SESSION_ID}" <cmd>`.

Request (may be empty): $ARGUMENTS

Run the command that answers the request. With no request, run `evolution list`.

| Need | Command |
|---|---|
| What has been learned, and what actually fires | `evolution list` (`--all` includes hand-written skills) |
| Which skills mislead | `evolution list`: the TROUBLE column counts uses of the current version that were followed by failures or corrections |
| How one skill evolved | `evolution history <skill>` |
| Undo a bad update | `evolution history <skill>`, then `evolution rollback <skill> --to N --note "why"` |
| Bring back a retired skill | `evolution archived`, then `evolution restore <slug>` |
| Put a hand-written skill under evolution | `evolution register <skill-dir> --note "adopted"` |
| Keep evolution away from a skill | Add `evolution: "off"` under its frontmatter `metadata:` |
| Why the hook did or didn't nudge | `evolution signals` |

Present the result compactly, as a short table or a few lines rather than the raw output. Point out anything notable: skills that have never been used, skills with high TROUBLE, a skill with many versions (churn can mean the lesson is unclear), or a high total of description tokens.
