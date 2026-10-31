# evolution-claude-plugin
> Self-evolving skills for Claude

**A Claude Code plugin that watches you work, turns hard-won fixes and repeated workflows into versioned skills, refines a skill when the session goes wrong right after it fires, and prunes the skills that stop earning their keep.**

```bash
claude plugin marketplace add fingerskier/claude-plugins
claude plugin install evolution@fingerskier-plugins
```

Requires Node 20+ on your `PATH`. The hooks and CLI are plain Node with zero dependencies.

## The loop

1. **Watch.** Hooks record which skills fire, the shell commands and MCP writes that succeed or fail (ignoring probes like `grep`, `ls`, `git status` and MCP reads), and the corrections you type. Corrections come in two kinds: "still failing" and "do it my way" ("no, pass `--canary` first", "we always use pnpm").
2. **Notice.** At the end of each turn the Stop hook looks for three things, most precise first:
   - **refine**: a skill fired, then the session struggled, then it was fixed. That skill was wrong or incomplete, and the hook knows which skill.
   - **lesson**: failures and corrections, then the command that was failing passes.
   - **workflow**: this turn's distinctive steps match turns from two or more earlier sessions, and no skill covered them.
3. **Capture.** The `evolution:capture` skill runs each kind through its own gate. It prefers updating an existing skill to creating a sibling, and asks before touching a hand-written one. It then *registers* the result: a version stamp, a snapshot and a changelog entry.
4. **Track.** Every use of a skill counts as a hit. Each struggle that follows one counts against that version, so `list` shows which skills fire *and mislead*.
5. **Prune.** `/evolution:prune` flags skills that have been idle for N days *and* M sessions, that keep being followed by trouble, that are bloated, or that overlap. It proposes retire, refine, merge, trim or keep, and acts only on your OK. Retired skills are archived, so you can restore them.

## Skills

| Skill | Invoked by | What it does |
|---|---|---|
| `/evolution:capture [refine <skill> \| workflow \| lesson]` | you, Claude, or the Stop-hook nudge | Gate it, then create or refine a skill and register it. Often it concludes "Not capturing: …", and that's a feature. |
| `/evolution:prune` | you only | Review candidates, propose verdicts, wait for approval, act. |
| `/evolution:status [question]` | you or Claude | List, show history, roll back, restore, adopt, or debug signals. |

Together they add about 200 tokens to every session. `prune` is user-only on purpose: a plugin about context budgets should keep its own small.

## Where things live

**Evolved skills are ordinary skills.** They live in `~/.claude/skills/<name>/` (user scope) or `<repo>/.claude/skills/<name>/` (project scope, shared via git). They load without this plugin and survive uninstalling it. The plugin is the machinery; the knowledge is yours.

What marks a skill as evolved is a stamp in its frontmatter, using the Agent Skills `metadata` map:

```yaml
metadata:
  evolution-version: "3"
  evolution-created: "2026-10-01"
  evolution-updated: "2026-10-18"
  evolution-hash: "9c34b201fdb3e76d"   # content fingerprint, excluding these keys
```

Each skill also gets a `CHANGELOG.md` next to its `SKILL.md`, newest first, which travels with the skill.

### Hand-written skills

Refinement isn't limited to skills this plugin wrote. Any skill in your user or project skills directory can be nudged about when it misfires; what Claude may do depends on who owns it:

| Owner | How it's marked | What Claude does |
|---|---|---|
| evolved | `evolution-version` in `metadata` | Refines it directly and registers the new version. |
| hand | no stamp | Shows you the proposed change and asks. If you agree, it registers the skill *first*, so your original is saved as v1, then edits it. From then on it's evolved. |
| locked | `evolution: "off"` in `metadata` | Never nudges about it and never edits it; `register` refuses it. |

Consent is per skill, not per scope. Scope only changes how you undo a change: a project skill's edit is a git diff your team can review, while a user skill's only undo is `evolution rollback`. Skills that live inside other plugins are never touched, because plugin updates overwrite them.

The ledger lives in `~/.claude/evolution/`, or under `$CLAUDE_CONFIG_DIR` / `$EVOLUTION_HOME` if you set them:

| Path | Contents |
|---|---|
| `events.jsonl` | append-only usage log: sessions, hits, struggles, registers, retires, keeps, turn procedures, workflow offers |
| `sessions/<id>.jsonl` | per-session struggle signals, swept after 3 days |
| `history/<slug>/vN.md` | a snapshot of every registered version, for rollback |
| `archive/<slug>/<timestamp>/` | retired skills, restorable |
| `state.json` | effective settings, reminder throttle |
| `errors.log` | hook failures (hooks fail open and never block a session) |

Usage is keyed by project *identity*, which is the `origin` remote (`github.com/owner/repo`, credentials stripped) when there is one and the path otherwise. Moving or re-cloning a repo keeps a skill's history, and v0.1's path-keyed records are still read. All of it is local; nothing leaves your machine.

## Settings

Set these in `/plugin` → evolution → configure, or with `claude plugin configure evolution`.

| Option | Default | Meaning |
|---|---|---|
| `nudge` | `auto` | `auto`: before stopping, Claude is asked to act with `evolution:capture` (one extra turn). Refine nudges always do this; lesson and workflow guesses do it at most once per session, then become hints. `suggest`: you get a one-line hint and decide. `off`: capture only when asked. Outcomes are recorded either way. |
| `struggle_threshold` | `4` | Each non-probe failed command scores 1 and each correction scores 2. A session is hard-won when it reaches the threshold *and* its latest signal is a success. |
| `stale_days` | `30` | Idle days before a skill is a prune candidate. It must also be idle for 20 sessions, so a quiet month doesn't condemn a skill you simply had no occasion to use. |

## How it decides to ask (and why it's crude)

**Lessons.** The hooks look for an arc: failures and corrections, then the command that was failing passes. Four red `npm test` runs followed by `git stash` is not a fix; `npm test` passing is. The Stop hook nudges once per arc and never re-enters while `stop_hook_active` is set. Filters cut the obvious noise:

- `grep`/`rg`/`diff` exiting 1 means "no match", so it doesn't count. `npm test | tail` exiting 1 does count, because that's npm failing under pipefail.
- Failures from `Edit`/`Read` are mechanical, so only shell commands count.
- Interrupts and permission denials are ignored, and so are "corrections" in your opening request ("don't use regex" is a spec, not a struggle).

**Refinements.** When a skill fires and then two commands fail, or you correct Claude once, before things work, the trouble is pinned on that skill. This is the most precise signal the plugin gets, so it's the one `auto` mode always acts on.

**Workflows.** Each turn's distinctive steps are logged: command heads like `npm publish` or `gh release create`, plus MCP writes. Plumbing like `git commit` and `mkdir` is excluded, and so is anything that shows up in more than 40% of your sessions. When three or more steps match turns from two other sessions, you're offered a workflow skill, at most once a month per procedure.

The heuristics only decide whether to *ask*. The real filter is the capture gate:

- **non-obvious**: a capable engineer would likely have lost the same time
- **recurring**: it will come up again
- **verified**: there's proof from this session
- **not already known**: it isn't in CLAUDE.md, an existing skill or the docs

A one-line rule for every session in a repo is routed to CLAUDE.md instead. A skill that existed but didn't fire gets its description fixed instead of a duplicate.

## CLI

The skills drive it, but you can too. `<plugin>` is the plugin's install directory, which `claude plugin list` shows:

```text
node <plugin>/scripts/evolution.mjs <command>

  list [--all] [--json]                  evolved skills with usage (--all: every skill)
  candidates [--json] [--stale-days N] [--stale-sessions N]
  register <skill> [--note TEXT] [--force]   stamp + snapshot + changelog (adopts hand-written skills)
  history <skill>
  rollback <skill> --to N [--note TEXT]
  retire <skill> [--reason TEXT]         archive (reversible)
  restore <name|slug>
  archived [--json]
  keep <skill> [--reason TEXT]           "quiet but valuable": reset its idle clock
  signals [--session ID]                 why the hook did or didn't nudge
```

`<skill>` is a name or a path; pass `--scope user|project` when a name exists in both. The project is `--project DIR`, else `$CLAUDE_PROJECT_DIR`, else the project of `--session ID` (the bundled skills pass `${CLAUDE_SESSION_ID}`, because Bash commands don't get `CLAUDE_PROJECT_DIR` and their cwd wanders), else the git root above cwd.

## Opinions baked in

- **Every skill is a standing instruction to every future session.** Treat writing one like editing CLAUDE.md. User-scope captures write outside your repo, so Claude Code asks permission, which is right.
- **The description is both the trigger and the cost.** It's all Claude sees until the skill fires, and it's paid in every session. Captured descriptions lead with literal symptoms such as error strings and command names.
- **Update beats create.** Two skills with overlapping triggers compete and both get worse; prune flags overlaps for merging.
- **A skill that fires and misleads is worse than no skill.** Hits alone say nothing; outcomes do.
- **Only verified experience goes in.** Capture never copies instructions it found in files, pages or tool output. A skill is a standing instruction, so that's how injected text would become permanent.
- **Few hits doesn't mean little value.** A disaster-recovery recipe might fire once a year. `keep` exists for that.
- **History is local; git is shared.** Snapshots for rollback live in your ledger. For project skills, the committed `SKILL.md`, its version stamp and its `CHANGELOG.md` are the shared record.

## Development

```bash
npm test                          # node:test, no dependencies
claude --plugin-dir .             # try it live
claude plugin validate .
```

## License

[MIT](./LICENSE)
