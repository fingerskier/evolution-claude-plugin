import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assessSession, commandHead, decidingPart, describeArc, exitCodeOf, isCorrection, isMcpRead, isOwnCommand, isProbe,
  isProbeFailure, mcpHead, slashSkill,
} from '../scripts/lib/signals.mjs';

test('probes: looking around is not struggling', () => {
  for (const c of ['grep -r foo .', 'ls -la && cat x', 'cd src && rg TODO', 'git status', 'test -f a || echo no', 'FOO=1 which node']) {
    assert.ok(isProbe(c), c);
  }
  for (const c of ['npm test', 'cd app && npm test', 'cargo build | tee log', 'python -m pytest', 'git push']) {
    assert.ok(!isProbe(c), c);
  }
});

test('probe failures: no-match exits are good news, real failures count', () => {
  assert.ok(isProbeFailure('npm test | grep FAIL', 1), 'grep found nothing');
  assert.ok(!isProbeFailure('npm test | grep FAIL', 2), 'grep error or pipefail');
  assert.ok(!isProbeFailure('npm test 2>&1 | tail -20', 1), 'tail never exits 1 on its own');
  assert.ok(!isProbeFailure('make', 2));
  assert.ok(isProbeFailure('', 1));
});

test('after ; only the last command decides the exit status', () => {
  assert.ok(isProbeFailure('npm run build; grep -n x package.json', 2), 'trailing probe failed');
  assert.ok(!isProbeFailure('ls; npm test', 1), 'trailing real command failed');
  assert.ok(isProbe(decidingPart('npm test; echo done')), 'a trailing echo proves nothing');
  assert.ok(!isProbe(decidingPart('npm test && echo done')), '&& means npm passed');
});

test('our own CLI is machinery, not struggle', () => {
  assert.ok(isOwnCommand('node "/x/plugins/evolution/scripts/evolution.mjs" list --json; ls'));
  assert.ok(!isOwnCommand('node scripts/build.mjs'));
});

test('commandHead keeps subcommands for multiplexers', () => {
  assert.equal(commandHead('cd app && NODE_ENV=test npm test -- --watch=false'), 'npm test');
  assert.equal(commandHead('sudo timeout 30 cargo build --release'), 'cargo build');
  assert.equal(commandHead('pytest -x tests/'), 'pytest');
  assert.equal(commandHead('node "/very/long/path/scripts/build.mjs" --prod'), 'node build.mjs');
  assert.equal(commandHead('npm run build -- --prod'), 'npm run build', 'the script name is the verb');
  assert.equal(commandHead('python -m pytest -x'), 'python -m pytest');
  assert.equal(commandHead('gh pr create --fill'), 'gh pr create');
  assert.equal(commandHead('kubectl apply -f k8s/'), 'kubectl apply', 'flags never become verbs');
});

test('MCP tools: writes are steps, reads are looking around', () => {
  assert.equal(mcpHead('mcp__slack__send_message'), 'mcp:slack/send_message');
  assert.equal(mcpHead('Bash'), null);
  assert.ok(isMcpRead('mcp__slack__slack_read_channel'));
  assert.ok(isMcpRead('mcp__github__get_me'));
  assert.ok(!isMcpRead('mcp__gmail__send_message'));
  assert.ok(!isMcpRead('mcp__x__update_checklist'));
});

test('exitCodeOf reads the code from Claude Code tool errors', () => {
  assert.equal(exitCodeOf('Exit code 2\nboom'), 2);
  assert.equal(exitCodeOf('Command timed out'), null);
});

test('corrections: frustration phrases yes, ordinary replies no', () => {
  for (const p of ['it still fails', 'Same error as before', "that didn't work", 'nope, still broken', 'tests are failing again', "that's not it"]) {
    assert.ok(isCorrection(p), p);
  }
  for (const p of ['no thanks', 'looks good, ship it', 'add a test for the parser', 'why does it fail?']) {
    assert.ok(!isCorrection(p), p);
  }
  assert.ok(!isCorrection(`${'log line\n'.repeat(60)}still failing`), 'pasted logs past the typed part are ignored');
});

test('corrections: "do it my way" counts too', () => {
  for (const p of [
    'no, you have to pass --canary first', 'Nope, try again', 'actually we always use pnpm here',
    "don't do that, use the staging profile", 'use pnpm instead', 'you forgot the migration', 'we always deploy from main',
  ]) {
    assert.ok(isCorrection(p), p);
  }
  for (const p of ['No problem, thanks', 'Actually, can you also add a README?', 'No tests exist yet for the parser', 'no need to rush']) {
    assert.ok(!isCorrection(p), p);
  }
});

test('slashSkill finds typed and expanded invocations', () => {
  assert.equal(slashSkill('/my-skill do it'), 'my-skill');
  assert.equal(slashSkill('<command-name>/evolution:capture</command-name>'), 'evolution:capture');
  assert.equal(slashSkill('use the /tmp dir'), null);
});

const ev = (...names) => names.map((n) => (typeof n === 'string' ? { ev: n } : n));

const fail = (cmd = 'npm test') => ({ ev: 'fail', cmd });
const ok = (cmd = 'npm test') => ({ ev: 'ok', cmd });
const hit = (name, owner = 'evolved') => ({ ev: 'hit', name, owner });

test('assessSession: struggle that ends in success is hard-won', () => {
  const a = assessSession([fail(), fail(), { ev: 'correction' }, ok()], 4);
  assert.equal(a.score, 4);
  assert.ok(a.resolved && a.hard);
  assert.deepEqual(a.commands, ['npm test']);
  assert.match(describeArc(a), /2 failed commands \(`npm test`\) and 1 correction/);
});

test('assessSession: unresolved or low-score sessions are not', () => {
  assert.ok(!assessSession(ev('fail', 'fail', 'fail', 'fail'), 4).hard, 'still failing');
  assert.ok(!assessSession(ev('fail', 'ok', 'fail', 'fail', 'fail'), 4).hard, 'last signal is a failure');
  assert.ok(!assessSession(ev('fail', 'fail', 'ok'), 4).hard, 'below threshold');
});

test('assessSession: only the command that was failing passing again is a fix', () => {
  assert.ok(!assessSession([fail(), fail(), fail(), fail(), ok('git stash')], 4).hard, 'stashing is not fixing');
  assert.ok(assessSession([fail(), fail(), fail(), fail(), ok('git stash'), ok()], 4).hard);
  assert.ok(assessSession([ok('make'), ev('correction'), ev('correction'), ok('make')].flat(), 4).hard, 'corrections only: any success');
});

test('assessSession: corrections before any work are the request, not a struggle', () => {
  const opening = [{ ev: 'correction' }, { ev: 'correction' }, ok()];
  assert.equal(assessSession(opening, 4).corrections, 0);
  assert.ok(!assessSession(opening, 4).hard);
});

test('assessSession: trouble right after a skill fired names that skill', () => {
  const a = assessSession([hit('deploy-staging'), fail('deploy.sh'), { ev: 'correction' }, ok('deploy.sh')], 4);
  assert.equal(a.kind, 'refine');
  assert.equal(a.refine.name, 'deploy-staging');
  assert.equal(a.refine.score, 3);
  assert.match(describeArc(a.refine), /1 failed command \(`deploy.sh`\) and 1 correction/);
});

test('assessSession: refine needs real trouble, a fix, and an unlocked skill', () => {
  assert.equal(assessSession([hit('a'), fail(), ok()], 4).refine, null, 'one failure is noise');
  assert.equal(assessSession([hit('a'), fail(), fail()], 4).refine, null, 'still broken: nothing to learn yet');
  assert.equal(assessSession([hit('a', 'locked'), fail(), fail(), ok()], 4).refine, null, 'locked skills are left alone');
  const blamed = assessSession([hit('a'), fail(), fail(), hit('b'), ok()], 4).refine;
  assert.equal(blamed.name, 'a', 'trouble is pinned on the skill it followed');
  assert.equal(assessSession([hit('a'), fail(), fail(), ok(), { ev: 'nudged' }], 4).refine, null, 'nudged once');
});

test('assessSession: a nudge or capture starts a new arc', () => {
  const events = ev('fail', 'fail', 'fail', 'fail', 'ok', 'nudged', 'ok');
  assert.ok(!assessSession(events, 4).hard);
  assert.ok(!assessSession(ev('correction', 'correction', 'ok', 'captured'), 4).hard);
});
