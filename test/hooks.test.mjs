// End to end: drive the real CLI the way Claude Code does -- JSON on stdin,
// JSON (or nothing) on stdout, always exit 0.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { register, resolveSkill } from '../scripts/lib/skills.mjs';
import { sandbox, writeSkill } from './helpers.mjs';

const CLI = fileURLToPath(new URL('../scripts/evolution.mjs', import.meta.url));

let box;
beforeEach(() => { box = sandbox(); });
afterEach(() => box.cleanup());

function hook(event, input, env = {}) {
  const res = spawnSync(process.execPath, [CLI, 'hook', event], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim() ? JSON.parse(res.stdout) : null;
}

const fail = (command) => hook('tool-fail', { session_id: 's', tool_name: 'Bash', tool_input: { command }, error: 'Exit code 1\nboom' });
const ok = (command) => hook('tool-ok', { session_id: 's', tool_name: 'Bash', tool_input: { command } });

function struggle() {
  fail('npm test');
  fail('grep -r nothing .'); // probe: ignored
  fail('npm test');
  hook('prompt', { session_id: 's', prompt: 'still failing, same error' });
  ok('ls'); // probe: doesn't count as resolution
  assert.equal(hook('stop', { session_id: 's' }), null, 'not resolved yet');
  ok('npm test');
}

test('auto mode blocks the stop once and asks Claude to evaluate a capture', () => {
  struggle();
  const out = hook('stop', { session_id: 's', stop_hook_active: false });
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /2 failed commands \(`npm test`\) and 1 correction/);
  assert.match(out.reason, /evolution:capture/);
  assert.equal(hook('stop', { session_id: 's', stop_hook_active: true }), null, 'never loops');
  assert.equal(hook('stop', { session_id: 's' }), null, 'one nudge per arc');
});

test('suggest mode only tells the user; off mode is silent', () => {
  struggle();
  const out = hook('stop', { session_id: 's' }, { CLAUDE_PLUGIN_OPTION_NUDGE: 'suggest' });
  assert.equal(out.decision, undefined);
  assert.match(out.systemMessage, /\/evolution:capture/);

  box.cleanup();
  box = sandbox();
  struggle();
  assert.equal(hook('stop', { session_id: 's' }, { CLAUDE_PLUGIN_OPTION_NUDGE: 'off' }), null);
});

test('threshold is configurable', () => {
  fail('make');
  ok('make');
  assert.equal(hook('stop', { session_id: 's' }), null);
  assert.equal(hook('stop', { session_id: 's' }, { CLAUDE_PLUGIN_OPTION_STRUGGLE_THRESHOLD: '1' }).decision, 'block');
});

test('invoking evolution:capture closes the arc', () => {
  struggle();
  hook('tool-ok', { session_id: 's', tool_name: 'Skill', tool_input: { skill: 'evolution:capture' } });
  assert.equal(hook('stop', { session_id: 's' }), null);
});

test('skill hits are counted from the Skill tool and from slash commands', () => {
  writeSkill(box.userSkills, 'mine');
  hook('tool-ok', { session_id: 's', tool_name: 'Skill', tool_input: { skill: 'mine' } });
  hook('prompt', { session_id: 's', prompt: '/mine please' });
  hook('tool-ok', { session_id: 's', tool_name: 'Skill', tool_input: { skill: 'other-plugin:thing' } });
  hook('prompt', { session_id: 's', prompt: '/clear' });
  const events = readFileSync(join(box.home, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map((e) => [e.ev, e.name, e.via]), [['hit', 'mine', 'model'], ['hit', 'mine', 'slash']]);
});

test('session-start counts sessions, saves config, and reminds about stale skills at most weekly', () => {
  writeSkill(box.userSkills, 'fossil', { extra: 'metadata:\n  evolution-version: "1"\n  evolution-created: "2020-01-01"\n' });
  for (let i = 0; i < 25; i++) hook('session-start', { session_id: `old${i}`, source: 'resume' });
  const env = { CLAUDE_PLUGIN_OPTION_STALE_DAYS: '10', CLAUDE_PLUGIN_OPTION_NUDGE: 'suggest' };
  const out = hook('session-start', { session_id: 'new', source: 'startup' }, env);
  assert.match(out.systemMessage, /1 evolved skill looks stale \(fossil\).*\/evolution:prune/);
  assert.equal(hook('session-start', { session_id: 'new2', source: 'startup' }, env), null, 'throttled');
  const state = JSON.parse(readFileSync(join(box.home, 'state.json'), 'utf8'));
  assert.equal(state.config.staleDays, 10);
  assert.equal(state.config.nudge, 'suggest');
});

test('fails open: garbage input, unknown fields, broken ledger', () => {
  assert.equal(hook('stop', 'not json'), null);
  assert.equal(hook('tool-fail', {}), null);
  assert.equal(hook('prompt', { session_id: 's' }), null);
  const res = spawnSync(process.execPath, [CLI, 'hook', 'no-such-event'], { input: '{}', encoding: 'utf8' });
  assert.notEqual(res.status, 0, 'unknown events are a programming error, reported loudly');
});

test('CLI round trip: list, candidates, retire, restore', () => {
  writeSkill(box.userSkills, 'cli-skill');
  register(resolveSkill('cli-skill'));
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: process.env });
  const list = JSON.parse(run('list', '--json').stdout);
  assert.equal(list[0].name, 'cli-skill');
  assert.equal(list[0].version, 1);
  assert.match(run('candidates').stdout, /No prune candidates/);
  assert.match(run('retire', 'cli-skill', '--reason', 'test').stdout, /undo: restore user--cli-skill/);
  assert.ok(!existsSync(join(box.userSkills, 'cli-skill')));
  assert.match(run('restore', 'user--cli-skill').stdout, /restored cli-skill/);
  const bad = run('register', 'ghost');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /no skill named "ghost"/);
});
