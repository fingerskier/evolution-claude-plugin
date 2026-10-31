import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { gitRoot, normalizeRemote, projectDir, projectIdentity, skillKey } from '../scripts/lib/paths.mjs';
import { sandbox } from './helpers.mjs';

let box;
beforeEach(() => { box = sandbox(); });
afterEach(() => box.cleanup());

function repo(dir, origin) {
  mkdirSync(join(dir, '.git'), { recursive: true });
  const remote = origin ? `[remote "origin"]\n\turl = ${origin}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n` : '';
  writeFileSync(join(dir, '.git', 'config'), `[core]\n\tbare = false\n${remote}`);
  return dir;
}

test('normalizeRemote: every spelling of a remote is one identity, minus credentials', () => {
  for (const url of [
    'git@github.com:Owner/repo.git', 'https://github.com/Owner/repo', 'https://user:tok3n@GitHub.com/Owner/repo.git/',
    'ssh://git@github.com:22/Owner/repo.git', 'git://github.com/Owner/repo.git',
  ]) {
    assert.equal(normalizeRemote(url), 'github.com/Owner/repo', url);
  }
  for (const url of ['/srv/git/repo.git', 'file:///srv/git/repo', '../repo', 'C:\\repos\\x', '']) assert.equal(normalizeRemote(url), null, url);
});

test('projectIdentity: origin remote survives moving the checkout; no remote falls back to the path', () => {
  const a = repo(join(box.root, 'a'), 'git@github.com:o/r.git');
  const b = repo(join(box.root, 'moved', 'b'), 'https://github.com/o/r');
  assert.equal(projectIdentity(a), 'github.com/o/r');
  assert.equal(projectIdentity(b), 'github.com/o/r');
  mkdirSync(join(a, 'packages', 'api'), { recursive: true });
  assert.equal(projectIdentity(join(a, 'packages', 'api')), 'github.com/o/r#packages/api', 'started below the root');
  const local = repo(join(box.root, 'local'));
  assert.equal(projectIdentity(local), local);
  assert.equal(skillKey({ scope: 'project', name: 'x', project: b }), 'project:github.com/o/r:x');
  assert.equal(skillKey({ scope: 'user', name: 'x' }), 'user:x');
});

test('projectIdentity follows worktree .git files to the shared config', () => {
  const main = repo(join(box.root, 'main'), 'git@gitlab.com:g/sub/r.git');
  mkdirSync(join(main, '.git', 'worktrees', 'wt'), { recursive: true });
  writeFileSync(join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
  const wt = join(box.root, 'wt');
  mkdirSync(wt);
  writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt')}\n`);
  assert.equal(projectIdentity(wt), 'gitlab.com/g/sub/r');
});

test('projectDir: explicit, then CLAUDE_PROJECT_DIR, then the git root above cwd', () => {
  const root = repo(join(box.root, 'mono'));
  const sub = join(root, 'packages', 'api');
  mkdirSync(sub, { recursive: true });
  assert.equal(gitRoot(sub), root);
  assert.equal(projectDir(sub), sub, 'explicit wins');
  assert.equal(projectDir(), box.env.CLAUDE_PROJECT_DIR);
  delete process.env.CLAUDE_PROJECT_DIR;
  const cwd = process.cwd();
  try {
    process.chdir(sub);
    // process.cwd() is canonical: on macOS /var/folders/... reads back as /private/var/...
    assert.equal(projectDir(), realpathSync(root), 'a wandering cwd climbs back to the repo');
  } finally {
    process.chdir(cwd);
  }
});
