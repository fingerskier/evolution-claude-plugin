// End to end: drive the real CLI the way Claude Code does -- JSON on stdin,
// JSON (or nothing) on stdout, always exit 0.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
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

const fail = (command, session_id = 's') => hook('tool-fail', { session_id, tool_name: 'Bash', tool_input: { command }, error: 'Exit code 1\nboom' });
const ok = (command, session_id = 's') => hook('tool-ok', { session_id, tool_name: 'Bash', tool_input: { command } });
const useSkill = (skill, session_id = 's') => hook('tool-ok', { session_id, tool_name: 'Skill', tool_input: { skill } });
const say = (prompt, session_id = 's') => hook('prompt', { session_id, prompt });
const ledger = () => {
  const file = join(box.home, 'events.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse) : [];
};

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
  assert.deepEqual(ledger().map((e) => [e.ev, e.name, e.via, e.key]), [['hit', 'mine', 'model', 'user:mine'], ['hit', 'mine', 'slash', 'user:mine']]);
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

function deployStruggle(skill = 'deploy-staging') {
  useSkill(skill);
  fail('./deploy.sh staging');
  say('no, you have to pass --canary first');
  ok('./deploy.sh staging --canary');
}

test('refine: a skill that fired before a struggle is named, and the outcome is recorded', () => {
  register(resolveSkill(writeSkill(box.userSkills, 'deploy-staging')));
  deployStruggle();
  const out = hook('stop', { session_id: 's' });
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /"deploy-staging" was used this session, and 1 failed command \(`deploy.sh`\) and 1 correction/);
  assert.match(out.reason, /refine deploy-staging/);
  assert.equal(hook('stop', { session_id: 's' }), null, 'once per arc');
  const struggles = ledger().filter((e) => e.ev === 'struggle');
  assert.deepEqual(struggles.map((e) => [e.name, e.key, e.score]), [['deploy-staging', 'user:deploy-staging', 3]]);
  const list = JSON.parse(spawnSync(process.execPath, [CLI, 'list', '--json'], { encoding: 'utf8', env: process.env }).stdout);
  assert.equal(list[0].strugglesSince, 1);
});

test('refine: hand-written skills need the user to agree, and adoption comes first', () => {
  writeSkill(box.projectSkills, 'deploy-staging');
  deployStruggle();
  const out = hook('stop', { session_id: 's' });
  assert.match(out.reason, /hand-written, so show the user the change and ask before editing/);
  assert.match(out.reason, /adopt it with register first so the original is kept as v1/);
});

test('refine: suggest hints, off stays silent but still records, locked skills are left alone', () => {
  register(resolveSkill(writeSkill(box.userSkills, 'deploy-staging')));
  deployStruggle();
  const hint = hook('stop', { session_id: 's' }, { CLAUDE_PLUGIN_OPTION_NUDGE: 'suggest' });
  assert.match(hint.systemMessage, /\/evolution:capture refine deploy-staging/);

  deployStruggle();
  assert.equal(hook('stop', { session_id: 's' }, { CLAUDE_PLUGIN_OPTION_NUDGE: 'off' }), null);
  assert.equal(ledger().filter((e) => e.ev === 'struggle').length, 2, 'off mode still feeds prune');

  writeSkill(box.userSkills, 'frozen', { extra: 'metadata:\n  evolution: "off"\n' });
  deployStruggle('frozen');
  assert.equal(hook('stop', { session_id: 's' }), null);
});

test('nudges: the failing command must pass, and only one guess per session blocks', () => {
  for (let i = 0; i < 4; i++) fail('npm test');
  ok('git stash');
  assert.equal(hook('stop', { session_id: 's' }), null, 'stashing is not a fix');
  ok('npm test');
  assert.equal(hook('stop', { session_id: 's' }).decision, 'block');
  for (let i = 0; i < 4; i++) fail('cargo build');
  ok('cargo build');
  const second = hook('stop', { session_id: 's' });
  assert.equal(second.decision, undefined, 'second guess in a session is only a hint');
  assert.match(second.systemMessage, /hard-won fix/);
});

test('workflows: the same procedure in a third session is offered as a skill, once', () => {
  const release = (sid) => {
    hook('session-start', { session_id: sid, source: 'startup' });
    for (const c of ['npm version patch', 'git push --follow-tags', 'npm publish', 'gh release create v1 --notes x']) ok(c, sid);
    hook('tool-ok', { session_id: sid, tool_name: 'mcp__slack__slack_read_channel', tool_input: {} });
    hook('tool-ok', { session_id: sid, tool_name: 'mcp__slack__send_message', tool_input: {} });
    return hook('stop', { session_id: sid });
  };
  assert.equal(release('a'), null);
  assert.equal(release('b'), null);
  const out = release('c');
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /procedure now done in 3 sessions: `npm version`, `npm publish`, `gh release create`, `mcp:slack\/send_message`/);
  assert.ok(!/read_channel|git push/.test(out.reason), 'reads and plumbing are not steps');
  assert.equal(release('d'), null, 'asked once; quiet for a while');
  assert.equal(ledger().filter((e) => e.ev === 'procedure').length, 4);
});

test('workflows: a turn where a skill fired is already covered', () => {
  writeSkill(box.userSkills, 'release');
  for (const sid of ['a', 'b', 'c']) {
    if (sid === 'c') useSkill('release', sid);
    for (const c of ['npm version patch', 'npm publish', 'gh release create v1']) ok(c, sid);
    assert.equal(hook('stop', { session_id: sid }), null);
  }
});

test('CLI finds the session\'s project even from a subdirectory without CLAUDE_PROJECT_DIR', () => {
  writeSkill(box.projectSkills, 'local-skill');
  hook('session-start', { session_id: 'sess-1', source: 'startup' });
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  const sub = join(box.env.CLAUDE_PROJECT_DIR, 'packages', 'api');
  mkdirSync(sub, { recursive: true });
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, cwd: sub });
  const res = run('--session', 'sess-1', 'register', join(box.projectSkills, 'local-skill'));
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /registered local-skill v1 \(project\)/);
  const unsubstituted = run('--session', '${CLAUDE_SESSION_ID}', 'list', '--json');
  assert.equal(unsubstituted.status, 0, 'a literal placeholder is ignored, not fatal');

  mkdirSync(join(box.env.CLAUDE_PROJECT_DIR, '.git'));
  const viaGit = JSON.parse(run('list', '--json').stdout);
  assert.equal(viaGit[0]?.name, 'local-skill', 'without --session the git root is found');
});
