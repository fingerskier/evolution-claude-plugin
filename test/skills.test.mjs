import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import {
  archived, history, register, resolveSkill, restore, retire, rollback, scanSkills,
} from '../scripts/lib/skills.mjs';
import { mkdirSync } from 'node:fs';
import { historyDir, legacySlug } from '../scripts/lib/paths.mjs';
import { readEvents } from '../scripts/lib/store.mjs';
import { sandbox, writeSkill } from './helpers.mjs';

let box;
beforeEach(() => { box = sandbox(); });
afterEach(() => box.cleanup());

const NOW = Date.parse('2026-10-18T12:00:00Z');

test('register adopts a hand-written skill as v1, then no-ops until it changes', () => {
  const dir = writeSkill(box.userSkills, 'port-in-use');
  assert.equal(scanSkills().length, 0, 'not evolved yet');
  assert.equal(scanSkills(undefined, { all: true }).length, 1);

  const first = register(resolveSkill('port-in-use'), { note: 'born', now: NOW });
  assert.equal(first.version, 1);
  const text = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  assert.match(text, /evolution-version: "1"/);
  assert.match(text, /evolution-created: "2026-10-18"/);
  assert.match(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8'), /## v1 — 2026-10-18\n\nborn/);

  const again = register(resolveSkill('port-in-use'));
  assert.equal(again.changed, false);

  appendFileSync(join(dir, 'SKILL.md'), '\nAlso check IPv6.\n');
  const second = register(resolveSkill(dir), { note: 'ipv6' });
  assert.equal(second.version, 2);
  assert.equal(scanSkills()[0].version, 2);
  const log = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8');
  assert.ok(log.indexOf('## v2') < log.indexOf('## v1'), 'newest first');
  assert.deepEqual(history(resolveSkill('port-in-use')).snapshots.map((s) => s.version), [1, 2]);
  assert.deepEqual(readEvents().filter((e) => e.ev === 'register').map((e) => e.version), [1, 2]);
});

test('register refuses skills Claude could never trigger', () => {
  writeSkill(box.userSkills, 'mute', { description: '""' });
  assert.throws(() => register(resolveSkill('mute')), /no description/);
});

test('register warns when frontmatter name and directory disagree', () => {
  const file = join(writeSkill(box.userSkills, 'dir-name'), 'SKILL.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace('name: dir-name', 'name: other'));
  const res = register(resolveSkill('dir-name'));
  assert.match(res.warnings.join(), /differs from directory/);
});

test('register warns about descriptions strict YAML would reject', () => {
  writeSkill(box.userSkills, 'colon', { description: 'Fix "Error: Cannot find module". Use when tests fail.' });
  assert.match(register(resolveSkill('colon')).warnings.join(), /strict YAML/);
  writeSkill(box.userSkills, 'folded', { description: '>-\n  Fix "Error: Cannot find module". Use when tests fail.' });
  assert.deepEqual(register(resolveSkill('folded')).warnings, []);
});

test('rollback restores old content as a new version', () => {
  const dir = writeSkill(box.userSkills, 'flaky', { body: 'v1 body\n' });
  const file = join(dir, 'SKILL.md');
  register(resolveSkill('flaky'));
  writeFileSync(file, readFileSync(file, 'utf8').replace('v1 body', 'v2 body'));
  assert.equal(register(resolveSkill('flaky')).version, 2);

  const res = rollback(resolveSkill('flaky'), 1);
  assert.equal(res.version, 3);
  const text = readFileSync(file, 'utf8');
  assert.match(text, /v1 body/);
  assert.match(text, /evolution-version: "3"/);
  assert.match(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8'), /Rolled back to the content of v1/);
  assert.throws(() => rollback(resolveSkill('flaky'), 9), /no snapshot v9/);
});

test('retire archives a skill and restore brings it back', () => {
  const dir = writeSkill(box.projectSkills, 'old-build-hack');
  register(resolveSkill('old-build-hack'));
  const { slug } = retire(resolveSkill('old-build-hack'), { reason: 'build rewritten' });
  assert.ok(!existsSync(dir));
  assert.equal(archived().length, 1);
  assert.equal(archived()[0].reason, 'build rewritten');
  assert.equal(archived()[0].scope, 'project');

  const back = restore(slug);
  assert.equal(back.from, dir);
  assert.ok(existsSync(join(dir, 'SKILL.md')));
  assert.ok(!existsSync(join(dir, '.evolution-archive.json')));
  assert.equal(archived().length, 0);
  assert.throws(() => restore('old-build-hack'), /nothing archived/);
});

test('resolveSkill: names, paths, scopes and ambiguity', () => {
  writeSkill(box.userSkills, 'twin');
  writeSkill(box.projectSkills, 'twin');
  assert.throws(() => resolveSkill('twin'), /both user and project/);
  assert.equal(resolveSkill('twin', { scope: 'project' }).scope, 'project');
  assert.equal(resolveSkill(join(box.userSkills, 'twin', 'SKILL.md')).scope, 'user');
  assert.throws(() => resolveSkill('ghost'), /no skill named "ghost"/);
  const stray = writeSkill(join(box.root, 'elsewhere'), 'stray');
  assert.throws(() => resolveSkill(stray), /not directly inside a skills directory/);
  const other = writeSkill(join(box.root, 'other-repo', '.claude', 'skills'), 'theirs');
  const found = resolveSkill(other);
  assert.equal(found.scope, 'project', 'a .claude/skills path names its own project');
  assert.equal(found.project, join(box.root, 'other-repo'));
});

test('project and user skills with the same name get distinct histories', () => {
  writeSkill(box.userSkills, 'twin');
  writeSkill(box.projectSkills, 'twin');
  const u = resolveSkill('twin', { scope: 'user' });
  const p = resolveSkill('twin', { scope: 'project' });
  assert.notEqual(u.slug, p.slug);
  register(u);
  register(p);
  assert.equal(history(resolveSkill('twin', { scope: 'user' })).snapshots.length, 1);
  assert.equal(history(resolveSkill('twin', { scope: 'project' })).snapshots.length, 1);
});

test('owners: hand-written until registered, evolved after, locked on request', () => {
  writeSkill(box.userSkills, 'mine');
  writeSkill(box.userSkills, 'hands-off', { extra: 'metadata:\n  evolution: "off"\n' });
  assert.equal(resolveSkill('mine').owner, 'hand');
  register(resolveSkill('mine'));
  assert.equal(resolveSkill('mine').owner, 'evolved');
  assert.equal(resolveSkill('hands-off').owner, 'locked');
  assert.throws(() => register(resolveSkill('hands-off')), /locked/);
});

test('snapshots saved under the v0.1 path-based slug are still found', () => {
  mkdirSync(join(box.env.CLAUDE_PROJECT_DIR, '.git'), { recursive: true });
  writeFileSync(join(box.env.CLAUDE_PROJECT_DIR, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:o/r.git\n');
  const dir = writeSkill(box.projectSkills, 'old-one', { body: 'original\n' });
  const skill = resolveSkill('old-one');
  assert.notEqual(skill.slug, legacySlug(skill), 'identity-based slug differs from the path-based one');
  assert.equal(skill.key, 'project:github.com/o/r:old-one');
  const legacy = historyDir(legacySlug(skill));
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, 'v1.md'), readFileSync(join(dir, 'SKILL.md'), 'utf8'));
  assert.deepEqual(history(skill).snapshots.map((s) => s.version), [1]);
  writeFileSync(join(dir, 'SKILL.md'), readFileSync(join(dir, 'SKILL.md'), 'utf8').replace('original', 'changed'));
  assert.equal(register(resolveSkill('old-one')).version, 2, 'numbering continues from the old snapshots');
  rollback(resolveSkill('old-one'), 1);
  assert.match(readFileSync(join(dir, 'SKILL.md'), 'utf8'), /original/);
});

test('renaming the checkout directory keeps a project skill\'s history', () => {
  mkdirSync(join(box.env.CLAUDE_PROJECT_DIR, '.git'), { recursive: true });
  writeFileSync(join(box.env.CLAUDE_PROJECT_DIR, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:o/r.git\n');
  writeSkill(box.projectSkills, 'portable');
  const before = resolveSkill('portable');
  register(before);
  const renamed = join(box.root, 'renamed-checkout');
  renameSync(box.env.CLAUDE_PROJECT_DIR, renamed);
  process.env.CLAUDE_PROJECT_DIR = renamed;
  const after = resolveSkill('portable');
  assert.equal(after.slug, before.slug);
  assert.equal(after.key, before.key);
  assert.deepEqual(history(after).snapshots.map((s) => s.version), [1]);
});
