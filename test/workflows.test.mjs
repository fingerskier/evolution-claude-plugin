import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findWorkflow, procedureOf, ubiquitous } from '../scripts/lib/workflows.mjs';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-31T12:00:00Z');
const ok = (cmd) => ({ ev: 'ok', cmd });
const RELEASE = ['npm version', 'npm publish', 'gh release create'];
const session = (id, t = NOW - DAY) => ({ ev: 'session', session: id, t });
const proc = (id, heads, t = NOW - DAY) => ({ ev: 'procedure', session: id, heads, t });

test('procedureOf keeps distinctive steps once, in order', () => {
  const turn = [ok('npm version'), ok('git add'), ok('git commit'), ok('npm version'), ok('npm publish'), { ev: 'fail', cmd: 'x' }, ok('gh release create')];
  assert.deepEqual(procedureOf(turn), RELEASE);
});

test('a procedure seen in two other sessions is a workflow', () => {
  const ledger = [session('a'), session('b'), proc('a', RELEASE), proc('b', [...RELEASE, 'npm test'])];
  const wf = findWorkflow(RELEASE, ledger, { session: 'c', now: NOW });
  assert.equal(wf.sessions, 3);
  assert.deepEqual(wf.steps, RELEASE);
  assert.equal(findWorkflow(RELEASE, ledger.slice(0, 3), { session: 'c', now: NOW }), null, 'once before is not a pattern');
  assert.equal(findWorkflow(RELEASE, [...ledger, proc('c', RELEASE)], { session: 'a', now: NOW }).sessions, 3, 'own session excluded');
});

test('dissimilar or tiny procedures are not workflows', () => {
  const ledger = [proc('a', ['docker build', 'docker push', 'kubectl apply']), proc('b', ['docker build', 'docker push', 'kubectl apply'])];
  assert.equal(findWorkflow(RELEASE, ledger, { session: 'c', now: NOW }), null);
  assert.equal(findWorkflow(['docker build', 'docker push'], ledger, { session: 'c', now: NOW }), null);
});

test('habits that show up in most sessions do not make a procedure distinctive', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const habit = ['mcp:memory/upsert_record', 'npm test'];
  const ledger = [...ids.map((id) => session(id)), ...ids.map((id) => proc(id, [...habit, `unique-${id}`]))];
  assert.deepEqual([...ubiquitous(ledger.filter((e) => e.ev === 'procedure'), 6)].sort(), habit.sort());
  assert.equal(findWorkflow([...habit, 'unique-z'], ledger, { session: 'z', now: NOW }), null);
});

test('once asked about, a workflow stays quiet for a month', () => {
  const ledger = [proc('a', RELEASE), proc('b', RELEASE), { ev: 'workflow', steps: RELEASE, t: NOW - 3 * DAY }];
  assert.equal(findWorkflow(RELEASE, ledger, { session: 'c', now: NOW }), null);
  assert.ok(findWorkflow(RELEASE, ledger, { session: 'c', now: NOW + 40 * DAY }));
});
