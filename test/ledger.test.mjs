import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { ago, candidates, stats, usage } from '../scripts/lib/ledger.mjs';
import { register, resolveSkill, scanSkills } from '../scripts/lib/skills.mjs';
import { sandbox, writeSkill } from './helpers.mjs';

const DAY = 86_400_000;
const T0 = Date.parse('2026-01-01T00:00:00Z');

let box;
beforeEach(() => { box = sandbox(); });
afterEach(() => box.cleanup());

const sessions = (n, from, project = box.env.CLAUDE_PROJECT_DIR) => Array.from(
  { length: n }, (_, i) => ({ ev: 'session', session: `s${from}-${i}`, project, t: from + i * 1000 }),
);

function evolved(name, opts) {
  writeSkill(box.userSkills, name, opts);
  register(resolveSkill(name), { now: T0 });
  return scanSkills().find((s) => s.name === name);
}

test('stale needs idle days AND idle sessions', () => {
  const skill = evolved('quiet');
  const policy = { staleDays: 30, staleSessions: 20 };

  const fewSessions = usage(sessions(5, T0 + DAY));
  assert.equal(candidates([skill], fewSessions, { ...policy, now: T0 + 90 * DAY }).length, 0, 'rarely-used machine');

  const busyButRecent = usage(sessions(50, T0 + DAY));
  assert.equal(candidates([skill], busyButRecent, { ...policy, now: T0 + 10 * DAY }).length, 0, 'too recent');

  const [c] = candidates([skill], busyButRecent, { ...policy, now: T0 + 90 * DAY });
  assert.equal(c.action, 'retire?');
  assert.match(c.reason, /never used in 90d \/ 50 sessions/);
});

test('hits and keeps reset the idle clock', () => {
  const skill = evolved('useful');
  const policy = { staleDays: 30, staleSessions: 20, now: T0 + 90 * DAY };
  const base = sessions(50, T0 + DAY);
  const hit = { ev: 'hit', key: skill.key, t: T0 + 80 * DAY };
  assert.equal(candidates([skill], usage([...base, hit]), policy).length, 0);
  const kept = { ev: 'keep', key: skill.key, t: T0 + 85 * DAY };
  assert.equal(candidates([skill], usage([...base, kept]), policy).length, 0);

  const s = stats(skill, usage([...base, hit, { ...hit, t: hit.t + 1 }]), T0 + 90 * DAY);
  assert.equal(s.hits, 2);
  assert.equal(s.idleDays, 9);
});

test('v0.1 events keyed by absolute directory still count', () => {
  const skill = evolved('legacy');
  const events = [{ ev: 'hit', key: skill.dir, t: T0 + DAY }, { ev: 'hit', key: skill.key, t: T0 + 2 * DAY }];
  const s = stats(skill, usage(events), T0 + 3 * DAY);
  assert.equal(s.hits, 2);
  assert.equal(s.idleDays, 1);
});

test('a skill that keeps being followed by trouble is a refine candidate, until it is refined', () => {
  const skill = evolved('shaky');
  const at = (d) => T0 + d * DAY;
  const events = [
    { ev: 'register', key: skill.key, t: T0 },
    ...[1, 2, 3, 4].map((d) => ({ ev: 'hit', key: skill.key, t: at(d) })),
    ...[1, 3, 4].map((d) => ({ ev: 'struggle', key: skill.key, t: at(d) + 1 })),
  ];
  const [c] = candidates([skill], usage(events), { now: at(5) });
  assert.equal(c.action, 'refine?');
  assert.match(c.reason, /3 of its last 4 uses/);
  const refined = [...events, { ev: 'register', key: skill.key, t: at(4) + 10 }, { ev: 'hit', key: skill.key, t: at(5) }];
  assert.equal(candidates([skill], usage(refined), { now: at(6) }).length, 0, 'a new version starts clean');
  assert.equal(stats(skill, usage(refined), at(6)).struggles, 3, 'lifetime totals are kept');
});

test('duplicate session events (resume) count once', () => {
  const skill = evolved('x');
  const dup = [...sessions(1, T0 + DAY), ...sessions(1, T0 + DAY)];
  assert.equal(stats(skill, usage(dup), T0 + 2 * DAY).idleSessions, 1);
});

test('project skills only count sessions in their own project', () => {
  writeSkill(box.projectSkills, 'local');
  register(resolveSkill('local'), { now: T0 });
  const skill = scanSkills()[0];
  const elsewhere = usage(sessions(40, T0 + DAY, '/some/other/repo'));
  assert.equal(stats(skill, elsewhere, T0 + 90 * DAY).idleSessions, 0);
  const sameRepoMoved = usage(sessions(40, T0 + DAY, '/new/path').map((s) => ({ ...s, pid: skill.projectId })));
  assert.equal(stats(skill, sameRepoMoved, T0 + 90 * DAY).idleSessions, 40, 'matched by identity, not path');
});

test('long descriptions and overlapping skills are flagged', () => {
  const long = evolved('wordy', { description: `Use when ${'something very specific happens '.repeat(12)}` });
  const a = evolved('pnpm-lock-drift', { description: 'Fix pnpm lockfile drift after rebase. Use when pnpm install reports ERR_PNPM_OUTDATED_LOCKFILE.' });
  const b = evolved('pnpm-lockfile', { description: 'Repair pnpm lockfile after rebase. Use when pnpm install fails with ERR_PNPM_OUTDATED_LOCKFILE.' });
  const found = candidates([long, a, b], usage([]), { now: T0 + DAY });
  assert.ok(found.some((c) => c.action === 'trim?' && c.skill === 'wordy'));
  const merge = found.find((c) => c.action === 'merge?');
  assert.equal(merge?.skill, 'pnpm-lock-drift + pnpm-lockfile');
});

test('ago is coarse and human', () => {
  assert.equal(ago(null), 'never');
  assert.equal(ago(T0, T0 + 30 * 60_000), '<1h ago');
  assert.equal(ago(T0, T0 + 5 * DAY), '5d ago');
  assert.equal(ago(T0, T0 + 120 * DAY), '4mo ago');
});
