import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contentHash, joinFrontmatter, parseFrontmatter, setOwnMetadata, splitFrontmatter } from '../scripts/lib/frontmatter.mjs';

const SAMPLE = `---
name: demo
description: >
  Fold this
  into one line.
allowed-tools: Bash
metadata:
    author: someone
---

# Demo

Body text.
`;

test('split and join round-trip byte for byte', () => {
  const parts = splitFrontmatter(SAMPLE);
  assert.equal(joinFrontmatter(parts), SAMPLE);
  const crlf = SAMPLE.replace(/\n/g, '\r\n');
  assert.equal(joinFrontmatter(splitFrontmatter(crlf)), crlf);
});

test('no frontmatter -> null', () => {
  assert.equal(splitFrontmatter('# just markdown\n'), null);
  assert.equal(splitFrontmatter('---\nname: x\nno closing fence\n'), null);
});

test('parses folded, literal and quoted scalars plus metadata', () => {
  const data = parseFrontmatter(splitFrontmatter(SAMPLE).fm);
  assert.equal(data.description, 'Fold this into one line.');
  assert.equal(data['allowed-tools'], 'Bash');
  assert.deepEqual(data.metadata, { author: 'someone' });

  const q = parseFrontmatter(['name: "a: b"', "description: 'it''s fine'", 'x: |', '  line1', '  line2']);
  assert.equal(q.name, 'a: b');
  assert.equal(q.description, "it's fine");
  assert.equal(q.x, 'line1\nline2');
  assert.deepEqual(q.metadata, {});
});

test('setOwnMetadata keeps foreign keys and their indentation', () => {
  const { fm } = splitFrontmatter(SAMPLE);
  const out = setOwnMetadata(fm, { 'evolution-version': 2 });
  assert.deepEqual(out.slice(-3), ['metadata:', '    evolution-version: "2"', '    author: someone']);
  const again = setOwnMetadata(out, { 'evolution-version': 3 });
  assert.equal(again.filter((l) => l.includes('evolution-version')).length, 1);
  assert.ok(again.includes('    evolution-version: "3"'));
});

test('setOwnMetadata creates a metadata block when missing', () => {
  const out = setOwnMetadata(['name: x', 'description: y'], { 'evolution-version': 1 });
  assert.deepEqual(out, ['name: x', 'description: y', 'metadata:', '  evolution-version: "1"']);
});

test('setOwnMetadata refuses flow-style metadata rather than mangling it', () => {
  assert.throws(() => setOwnMetadata(['metadata: {a: b}'], { 'evolution-version': 1 }), /flow-style/);
});

test('contentHash ignores our own bookkeeping but sees real edits', () => {
  const { fm, body } = splitFrontmatter(SAMPLE);
  const stamped = setOwnMetadata(fm, { 'evolution-version': 9, 'evolution-hash': 'abc' });
  assert.equal(contentHash(stamped, body), contentHash(fm, body));
  const bare = fm.filter((l) => !/^metadata:|author/.test(l));
  assert.equal(contentHash(setOwnMetadata(bare, { 'evolution-version': 1 }), body), contentHash(bare, body));
  assert.notEqual(contentHash(fm, `${body}more`), contentHash(fm, body));
  assert.equal(contentHash(fm, `${body}\n\n`), contentHash(fm, body), 'trailing whitespace is not a change');
});
