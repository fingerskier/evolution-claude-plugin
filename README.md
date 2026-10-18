# evolution-claude-plugin
> Self-evolving skills for Claude

**A Claude Code plugin that watches you work, turns each hard-won fix into a new or updated versioned skill, and prunes the ones that stop earning their keep.**

```bash
claude plugin marketplace add fingerskier/claude-plugins
claude plugin install evolution@fingerskier-plugins
```

Requires Node 20+ on your `PATH`. The hooks and CLI are plain Node with zero dependencies.

## The loop

1. **Watch.** Hooks count failed shell commands, ignoring probes like `grep`, `ls` and `git status`. They also count corrections you type, like "still failing" or "same error". When a struggle ends with a passing command, the Stop hook nudges once.
2. **Capture.** The `evolution:capture` skill states the lesson as symptom, cause, fix and proof, then runs it through a four-point gate. It prefers updating an existing skill to creating a sibling. It writes the skill at project or user scope, then *registers* it: a version stamp, a snapshot and a changelog entry.
3. **Track.** Every time a skill fires, through the Skill tool or a typed `/skill-name`, it counts as a hit in a local ledger.
4. **Prune.** `/evolution:prune` flags skills that have been idle for N days *and* M sessions, that are bloated, or that overlap. It proposes retire, merge, trim or keep, and acts only on your OK. Retired skills are archived, so you can restore them.

## Skills

| Skill | Invoked by | What it does |
|---|---|---|
| `/evolution:capture [lesson]` | you, Claude, or the Stop-hook nudge | Gate the lesson, then create or update a skill and register it. Often it concludes "Not capturing: …", and that's a feature. |
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

The ledger lives in `~/.claude/evolution/`, or under `$CLAUDE_CONFIG_DIR` / `$EVOLUTION_HOME` if you set them:

| Path | Contents |
|---|---|
| `events.jsonl` | append-only usage log: sessions, hits, registers, retires, keeps |
| `sessions/<id>.jsonl` | per-session struggle signals, swept after 3 days |
| `history/<slug>/vN.md` | a snapshot of every registered version, for rollback |
| `archive/<slug>/<timestamp>/` | retired skills, restorable |
| `state.json` | effective settings, reminder throttle |
| `errors.log` | hook failures (hooks fail open and never block a session) |

All of it is local; nothing leaves your machine.

## Settings

Set these in `/plugin` → evolution → configure, or with `claude plugin configure evolution`.

| Option | Default | Meaning |
|---|---|---|
| `nudge` | `auto` | `auto`: before stopping, Claude is asked to judge the fix with `evolution:capture` (costs one extra turn when it fires). `suggest`: you get a one-line hint and decide. `off`: capture only when asked. |
| `struggle_threshold` | `4` | Each non-probe failed command scores 1 and each correction scores 2. A session is hard-won when it reaches the threshold *and* its latest signal is a success. |
| `stale_days` | `30` | Idle days before a skill is a prune candidate. It must also be idle for 20 sessions, so a quiet month doesn't condemn a skill you simply had no occasion to use. |

## How "hard-won" is detected (and why it's crude)

The hooks look for a simple arc: failures and corrections, then a non-probe command that succeeds. At that point the Stop hook nudges once per arc, never re-entering while `stop_hook_active` is set. Filters cut the obvious noise:

- `grep`/`rg`/`diff` exiting 1 means "no match", so it doesn't count. `npm test | tail` exiting 1 does count, because that's npm failing under pipefail.
- Failures from `Edit`/`Read` are mechanical, so only shell commands count.
- Interrupts and permission denials are ignored.

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

`<skill>` is a name or a path; pass `--scope user|project` when a name exists in both.

## Opinions baked in

- **Every skill is a standing instruction to every future session.** Treat writing one like editing CLAUDE.md. User-scope captures write outside your repo, so Claude Code asks permission, which is right.
- **The description is both the trigger and the cost.** It's all Claude sees until the skill fires, and it's paid in every session. Captured descriptions lead with literal symptoms such as error strings and command names.
- **Update beats create.** Two skills with overlapping triggers compete and both get worse; prune flags overlaps for merging.
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
