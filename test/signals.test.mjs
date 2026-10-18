import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assessSession, commandHead, decidingPart, describeArc, exitCodeOf, isCorrection, isOwnCommand, isProbe, isProbeFailure,
  slashSkill,
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

test('slashSkill finds typed and expanded invocations', () => {
  assert.equal(slashSkill('/my-skill do it'), 'my-skill');
  assert.equal(slashSkill('<command-name>/evolution:capture</command-name>'), 'evolution:capture');
  assert.equal(slashSkill('use the /tmp dir'), null);
});

const ev = (...names) => names.map((n) => (typeof n === 'string' ? { ev: n } : n));

test('assessSession: struggle that ends in success is hard-won', () => {
  const a = assessSession(ev({ ev: 'fail', cmd: 'npm test' }, { ev: 'fail', cmd: 'npm test' }, 'correction', 'ok'), 4);
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

test('assessSession: a nudge or capture starts a new arc', () => {
  const events = ev('fail', 'fail', 'fail', 'fail', 'ok', 'nudged', 'ok');
  assert.ok(!assessSession(events, 4).hard);
  assert.ok(!assessSession(ev('correction', 'correction', 'ok', 'captured'), 4).hard);
});
