---
name: prune
description: Review evolved skills and retire, merge, trim or keep the ones that stopped earning their keep (stale, overlapping or too costly in context).
disable-model-invocation: true
---

# Prune evolved skills

Every skill's description is loaded into every session, and skills with overlapping triggers compete with each other. Pruning protects the context budget; it is not just tidying.

Below, `evolution <cmd>` means `node "${CLAUDE_PLUGIN_ROOT}/scripts/evolution.mjs" --session "${CLAUDE_SESSION_ID}" <cmd>`.

## 1. Gather

Run `evolution candidates`, then `evolution list`. Candidates come from simple rules:

- `retire?`: idle for N days *and* M sessions, so infrequent users aren't punished.
- `refine?`: the session struggled right after most recent uses of this version, so the skill fires but misleads.
- `trim?`: a long description or a bloated body.
- `merge?`: descriptions that overlap.

If there are no candidates and the user didn't ask for a full review, say so and stop. If they did ask for a full review, judge every evolved skill.

## 2. Judge each candidate

Read the candidate's `SKILL.md` and `CHANGELOG.md`, then pick a verdict:

| Verdict | When | Action |
|---|---|---|
| retire | The lesson is obsolete (the dependency is gone, the bug was fixed upstream, the code moved on), or the skill never fires and its trigger can't be fixed | `evolution retire <skill> --reason "..."` |
| fix trigger | The lesson is still valid but the skill rarely fires, because the description doesn't match how the problem shows up | Rewrite the description, then `evolution register <dir> --note "..."` |
| refine | The skill fires, but the session keeps struggling afterwards (high TROUBLE in `evolution list`) | Find what it gets wrong (its `CHANGELOG.md` and the user can help), correct the body, then register |
| merge | Two skills cover the same ground | Fold the weaker skill into the stronger one, register the survivor, retire the other |
| trim | The description is long or the body is bloated | Shorten it, move reference material into a supporting file in the skill directory, then register |
| keep | The skill is quiet but valuable: rare and high-stakes, like disaster recovery or release steps | `evolution keep <skill> --reason "..."` resets its idle clock |

Few hits doesn't mean little value. Ask: if this came up tomorrow, would the skill save real time?

## 3. Propose, then act

Show a compact table with each skill, its verdict and a one-line reason. **Wait for the user's go-ahead** before you retire or merge anything, then carry out only what they approved.

## 4. Report

Summarize what changed and how many description tokens per session it saved; `evolution list` shows the total before and after. Retiring is reversible with `evolution restore <slug>`. For changes to project skills, remind the user to commit `.claude/skills/`.
