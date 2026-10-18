---
name: capture
description: Turn a hard-won fix into a new or updated versioned skill, or decide it isn't worth one. Use after failures or corrections end in a verified fix, when asked to "remember this", or when evolution flags a hard-won fix.
argument-hint: "[lesson to capture]"
---

# Capture a hard-won fix

You just paid for a lesson. Decide whether it is worth keeping and, if it is, keep it as a skill that a future session will actually trigger.

Focus from the user (may be empty): $ARGUMENTS

Below, `evolution <cmd>` means `node "${CLAUDE_PLUGIN_ROOT}/scripts/evolution.mjs" <cmd>`.

## 1. State the lesson

Write four lines for yourself:

- **Symptom**: what was observed, with the exact error text or behaviour.
- **Cause**: why it happened.
- **Fix**: what made it work.
- **Proof**: the command or check that showed it worked, from this session.

If you cannot fill in **Cause** honestly, stop. A fix you don't understand is a superstition, not a skill. If there is no **Proof**, the work isn't done; finish it first.

## 2. Gate

Keep the lesson only if all four hold:

1. **Non-obvious**: a capable engineer new to this would likely have lost the same time.
2. **Recurring**: it will come up again, in another file, branch, project or machine.
3. **Verified**: the Proof is real.
4. **Not already known**: it isn't in CLAUDE.md, an existing skill or the project docs.

Route it correctly as well:

- A one-line rule that applies to *every* session in this repo ("use pnpm, not npm") belongs in CLAUDE.md. Propose that line instead; skills are for procedures with a recognizable trigger.
- If an existing skill covered this but didn't trigger, the fix is that skill's **description**, not a new skill.

If the lesson fails the gate, say so in one sentence ("Not capturing: <reason>.") and stop.

## 3. Update before you create

Run `evolution list --json` and scan the available-skills list in your context. If an existing skill covers the same symptom, tool or subsystem, **update it**: correct what was wrong, add the new case, and keep it coherent. It is a playbook, not a diary. Two skills with overlapping triggers compete, and both get worse. Create a new skill only for a genuinely new trigger.

## 4. Choose the scope

- **project** (`<project>/.claude/skills/<name>/`): about this codebase, such as its build, layout, services or conventions. It is shared through git.
- **user** (`~/.claude/skills/<name>/`): about a tool, language, platform or service you will meet in other repos.

`evolution list` prints both directories. When in doubt, choose project. Promoting a skill later is easy, but a codebase detail that leaks into every project is hard to take back.

## 5. Write SKILL.md

```markdown
---
name: <kebab-case; same as the directory; 64 chars max>
description: >-
  <What it does, in one clause>. Use when <the literal symptoms that will
  show up next time: error strings, commands, file or tool names>.
---

# <Title>

## Symptom
<what you see; quote the error>

## Cause
<why>

## Fix
1. <imperative steps, exact commands>

## Verify
<the command or check that proves it worked>

## Pitfalls
- <what looked right but wasn't; what not to try>
```

Rules:

- **The description is the trigger.** It is all Claude sees until the skill is invoked, and it costs tokens in every session. Put concrete, searchable symptoms first and keep it under about 250 characters.
- Keep the body under about 60 lines. Write instructions, not the story of this session.
- Generalize paths and names (`<package>`, `$PROJECT`) unless they *are* the lesson.
- Never include secrets, tokens, credentials, internal hostnames, customer data or personal information. Every skill becomes a standing instruction to every future session, so write it with that reach in mind.
- Leave the `evolution-*` keys under `metadata:` alone. The CLI owns them.

## 6. Register

```bash
evolution register <skill-dir> --note "<one line: what changed and why>"
```

This stamps the version, saves a snapshot so the change can be rolled back, and adds an entry to the skill's `CHANGELOG.md`. Running it on an unchanged skill does nothing. If it prints warnings, fix the skill and run it again.

## 7. Report

Report in one line, for example: `Captured pnpm-lockfile-drift v2 (project): after a rebase, rerun pnpm install and commit the lockfile.` For a project skill, remind the user to commit `.claude/skills/`.
