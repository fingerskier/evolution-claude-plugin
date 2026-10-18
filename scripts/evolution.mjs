#!/usr/bin/env node
// evolution -- versioning, usage ledger and pruning for self-evolving skills.
// Zero dependencies; Node 20+. Run with no arguments for usage.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { handlers } from './lib/hooks.mjs';
import { ago, candidates, stats, usage } from './lib/ledger.mjs';
import { evolutionHome, projectDir, sessionsDir } from './lib/paths.mjs';
import { assessSession } from './lib/signals.mjs';
import {
  archived, history, keep, register, resolveSkill, restore, retire, roots, rollback, scanSkills,
} from './lib/skills.mjs';
import { readEvents, readJsonl, readState } from './lib/store.mjs';

const USAGE = `evolution -- self-evolving skills

  list [--all] [--json]                  evolved skills with usage (--all: every skill)
  candidates [--json] [--stale-days N] [--stale-sessions N]
                                         skills that look stale, bloated or redundant
  register <skill> [--note TEXT] [--force]
                                         stamp version + snapshot + changelog after an edit
                                         (on a hand-written skill: adopt it as v1)
  history <skill>                        versions and changelog
  rollback <skill> --to N [--note TEXT]  restore the content of vN as a new version
  retire <skill> [--reason TEXT]         move a skill to the archive (reversible)
  restore <name|slug>                    bring the latest archived copy back
  archived [--json]                      list retired skills
  keep <skill> [--reason TEXT]           mark a quiet skill as deliberately kept
  signals [--session ID]                 debug: struggle signals for a session
  hook <event>                           (internal) hook entry point; reads stdin

<skill> is a name or a path. Common flags: --project DIR, --scope user|project.
State lives in ${evolutionHome()}`;

const BOOLEAN = new Set(['json', 'all', 'force', 'help']);

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const [k, v] = a.slice(2).split(/=(.*)/s);
    if (v !== undefined) flags[k] = v;
    else if (BOOLEAN.has(k) || i + 1 >= argv.length) flags[k] = true;
    else flags[k] = argv[++i];
  }
  return { pos, flags };
}

const print = (s = '') => process.stdout.write(`${s}\n`);
const json = (v) => print(JSON.stringify(v, null, 2));

function table(rows, headers) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const fmt = (r) => r.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd();
  return [fmt(headers), ...rows.map(fmt)].join('\n');
}

function settings(flags) {
  const saved = readState().config ?? {};
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    staleDays: num(flags['stale-days'], saved.staleDays ?? 30),
    staleSessions: num(flags['stale-sessions'], saved.staleSessions ?? 20),
  };
}

const commands = {
  list({ flags }) {
    const skills = scanSkills(flags.project, { all: !!flags.all });
    const ledger = usage(readEvents());
    const rows = skills.map((s) => ({ skill: s, ...stats(s, ledger) }));
    if (flags.json) {
      return json(rows.map(({ skill: s, ...st }) => ({
        name: s.name, scope: s.scope, dir: s.dir, evolved: s.evolved, version: s.version,
        updated: s.updated, description: s.description, ...st,
      })));
    }
    for (const r of roots(flags.project)) print(`${r.scope} skills: ${r.dir}`);
    print();
    if (!rows.length) {
      print(flags.all ? 'No skills found.' : 'No evolved skills yet. They appear after /evolution:capture, or `register` a hand-written skill to adopt it.');
      return;
    }
    const tokens = rows.reduce((n, r) => n + r.descTokens, 0);
    print(`${rows.length} skill${rows.length === 1 ? '' : 's'} · ~${tokens} description tokens in every session\n`);
    print(table(
      rows.map((r) => [
        r.skill.name, r.skill.scope, r.skill.evolved ? `v${r.skill.version}` : '-', r.hits,
        ago(r.lastHit), `${r.idleDays}d / ${r.idleSessions} sessions`,
      ]),
      ['NAME', 'SCOPE', 'VER', 'HITS', 'LAST USED', 'IDLE'],
    ));
  },

  candidates({ flags }) {
    const cfg = settings(flags);
    const found = candidates(scanSkills(flags.project), usage(readEvents()), cfg);
    if (flags.json) return json({ policy: cfg, candidates: found });
    if (!found.length) return print('No prune candidates. Every evolved skill is earning its keep.');
    print(`${found.length} candidate${found.length === 1 ? '' : 's'} (stale = idle >= ${cfg.staleDays}d AND >= ${cfg.staleSessions} sessions):\n`);
    for (const c of found) print(`  ${c.action.padEnd(8)} ${c.skill} (${c.scope}) -- ${c.reason}`);
  },

  register({ pos, flags }) {
    const skill = resolveSkill(pos[0], { scope: flags.scope, project: flags.project });
    const res = register(skill, { note: flags.note, force: !!flags.force });
    for (const w of res.warnings) print(`warning: ${w}`);
    if (!res.changed) return print(`${skill.name} unchanged since v${res.version}; nothing to register.`);
    const from = res.previous ? `v${res.previous} -> ` : '';
    print(`registered ${skill.name} ${from}v${res.version} (${skill.scope}) at ${skill.dir}`);
    if (skill.scope === 'project') print('project skill: commit .claude/skills to share it with the team.');
  },

  history({ pos, flags }) {
    const skill = resolveSkill(pos[0], { scope: flags.scope, project: flags.project });
    const h = history(skill);
    print(`${skill.name} (${skill.scope}) is at v${skill.version || '-'}`);
    print(h.snapshots.length
      ? `local snapshots: ${h.snapshots.map((s) => `v${s.version}`).join(', ')}`
      : 'no local snapshots (registered on another machine, or never registered)');
    if (h.changelog) print(`\n${h.changelog.trim()}`);
  },

  rollback({ pos, flags }) {
    if (!flags.to) throw new Error('rollback needs --to N');
    const skill = resolveSkill(pos[0], { scope: flags.scope, project: flags.project });
    const res = rollback(skill, flags.to, { note: flags.note });
    print(`${skill.name}: content of v${flags.to} restored as v${res.version}`);
  },

  retire({ pos, flags }) {
    const skill = resolveSkill(pos[0], { scope: flags.scope, project: flags.project });
    const res = retire(skill, { reason: flags.reason });
    print(`retired ${skill.name} -> ${res.archived}`);
    print(`undo: restore ${res.slug}`);
    if (skill.scope === 'project') print('project skill: commit the removal so teammates stop loading it.');
  },

  restore({ pos }) {
    const a = restore(pos[0]);
    print(`restored ${a.name} -> ${a.from}`);
  },

  archived({ flags }) {
    const list = archived();
    if (flags.json) return json(list);
    if (!list.length) return print('Nothing archived.');
    print(table(
      list.map((a) => [a.slug, a.name, a.scope, a.version ? `v${a.version}` : '-', a.retiredAt.slice(0, 10), a.reason ?? '']),
      ['SLUG', 'NAME', 'SCOPE', 'VER', 'RETIRED', 'REASON'],
    ));
  },

  keep({ pos, flags }) {
    const skill = resolveSkill(pos[0], { scope: flags.scope, project: flags.project });
    keep(skill, { reason: flags.reason });
    print(`keeping ${skill.name}; its idle clock is reset.`);
  },

  signals({ flags }) {
    let id = flags.session;
    if (!id) {
      const dir = sessionsDir();
      const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : [];
      files.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs);
      if (!files.length) return print('No session signals recorded yet.');
      id = files[0].replace(/\.jsonl$/, '');
    }
    const events = readJsonl(join(sessionsDir(), `${id}.jsonl`));
    const threshold = readState().config?.threshold ?? 4;
    json({ session: id, threshold, ...assessSession(events, threshold), events: events.slice(-20) });
  },

  hook({ pos }) {
    const handler = handlers[pos[0]];
    if (!handler) throw new Error(`unknown hook event "${pos[0]}"`);
    let input = {};
    try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { /* no/invalid stdin */ }
    try {
      const out = handler(input);
      if (out) print(JSON.stringify(out));
    } catch (err) {
      // Fail open: record the problem, never block or spam the session.
      try {
        mkdirSync(evolutionHome(), { recursive: true });
        appendFileSync(join(evolutionHome(), 'errors.log'), `${new Date().toISOString()} ${pos[0]}: ${err.stack ?? err}\n`);
      } catch { /* nowhere to write: give up quietly */ }
    }
  },
};

const { pos, flags } = parseArgs(process.argv.slice(2));
const cmd = pos.shift();
if (!cmd || flags.help || !commands[cmd]) {
  print(USAGE);
  process.exit(cmd && !commands[cmd] && !flags.help ? 1 : 0);
}
if (flags.project) flags.project = projectDir(flags.project);
try {
  commands[cmd]({ pos, flags });
} catch (err) {
  process.stderr.write(`evolution ${cmd}: ${err.message}\n`);
  process.exit(1);
}
