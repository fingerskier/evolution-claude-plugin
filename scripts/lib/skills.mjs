// Finding, versioning, retiring and restoring skills. Evolved skills are plain
// Claude Code skills in the user or project skills directory; what makes them
// "evolved" is the `evolution-version` key in their frontmatter metadata.
//
// Every skill has an owner, which decides what Claude may do to it:
//   evolved  stamped by register: Claude refines it directly.
//   hand     written by a person: Claude proposes a change and asks first.
//   locked   `metadata: evolution: "off"`: never nudged about, never registered.
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { contentHash, joinFrontmatter, parseFrontmatter, setOwnMetadata, splitFrontmatter } from './frontmatter.mjs';
import {
  archiveDir, historyDir, legacySlug, projectDir, projectIdentity, projectSkillsRoot, skillKey, skillSlug, userSkillsRoot,
} from './paths.mjs';
import { logEvent, readJson, writeJson } from './store.mjs';

const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

export function roots(project) {
  const user = { scope: 'user', dir: userSkillsRoot() };
  const proj = { scope: 'project', dir: projectSkillsRoot(project), project: projectDir(project) };
  // Launched from $HOME, the "project" skills dir *is* the user skills dir.
  return resolve(user.dir) === resolve(proj.dir) ? [user] : [user, proj];
}

const within = (child, parent) => {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes(sep);
};

const LOCKED = /^(?:off|false|no|locked|never)$/i;

export function readSkill(dir, root) {
  const file = join(dir, 'SKILL.md');
  const text = readFileSync(file, 'utf8');
  const parts = splitFrontmatter(text) ?? { eol: '\n', fm: [], body: text };
  const data = parseFrontmatter(parts.fm);
  const meta = data.metadata;
  const name = basename(dir);
  const skill = {
    name,
    dir,
    file,
    scope: root.scope,
    project: root.project ?? null,
    parts,
    data,
    description: data.description ?? '',
    evolved: meta['evolution-version'] !== undefined,
    locked: LOCKED.test(String(meta.evolution ?? '')),
    version: Number.parseInt(meta['evolution-version'], 10) || 0,
    created: meta['evolution-created'] ?? null,
    updated: meta['evolution-updated'] ?? null,
    hash: meta['evolution-hash'] ?? null,
    bodyLines: parts.body.split(/\r?\n/).length,
  };
  skill.owner = skill.locked ? 'locked' : skill.evolved ? 'evolved' : 'hand';
  skill.slug = skillSlug(skill);
  skill.legacySlug = legacySlug(skill);
  skill.key = skillKey(skill);
  skill.projectId = skill.project ? projectIdentity(skill.project) : null;
  return skill;
}

export function scanSkills(project, { all = false } = {}) {
  const out = [];
  for (const root of roots(project)) {
    if (!existsSync(root.dir)) continue;
    for (const entry of readdirSync(root.dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = join(root.dir, entry.name);
      if (!existsSync(join(dir, 'SKILL.md'))) continue;
      try {
        const skill = readSkill(dir, root);
        if (all || skill.evolved) out.push(skill);
      } catch { /* unreadable skill: not ours to judge */ }
    }
  }
  return out;
}

// Accepts a skill name, a skill directory, or a path to its SKILL.md.
export function resolveSkill(ref, { scope, project } = {}) {
  if (!ref) throw new Error('which skill? pass a name or a path');
  const rs = roots(project);
  const looksLikePath = /[\\/]/.test(ref) || ref.startsWith('.') || ref.startsWith('~');
  if (looksLikePath) {
    let dir = resolve(ref.replace(/^~(?=[\\/])/, homedir()));
    if (basename(dir) === 'SKILL.md') dir = dirname(dir);
    if (!existsSync(join(dir, 'SKILL.md'))) throw new Error(`no SKILL.md in ${dir}`);
    // A path of the form <project>/.claude/skills/<name> names its own project,
    // whatever the cwd is.
    const parent = dirname(dir);
    const own = basename(parent) === 'skills' && basename(dirname(parent)) === '.claude'
      ? { scope: 'project', dir: parent, project: dirname(dirname(parent)) }
      : null;
    const root = rs.find((r) => within(dir, r.dir)) ?? own;
    if (!root) {
      throw new Error(`${dir} is not directly inside a skills directory Claude Code loads:\n  ${rs.map((r) => r.dir).join('\n  ')}`);
    }
    return readSkill(dir, root);
  }
  const hits = rs
    .filter((r) => !scope || r.scope === scope)
    .filter((r) => existsSync(join(r.dir, ref, 'SKILL.md')))
    .map((r) => readSkill(join(r.dir, ref), r));
  if (hits.length === 0) throw new Error(`no skill named "${ref}" in ${rs.map((r) => r.dir).join(' or ')}`);
  if (hits.length > 1) throw new Error(`"${ref}" exists in both user and project scope; pass --scope user|project`);
  return hits[0];
}

// Like resolveSkill, but quiet: used by hooks to map an invoked name to a skill.
export function findSkill(name, project) {
  // Claude Code gives personal skills precedence over project skills.
  for (const r of roots(project)) {
    const dir = join(r.dir, name);
    if (!existsSync(join(dir, 'SKILL.md'))) continue;
    try { return readSkill(dir, r); } catch { return null; }
  }
  return null;
}

// Snapshots under the current slug, plus any left under the v0.1 path-based
// slug (same version number: the current slug wins).
function snapshots(skill) {
  const byVersion = new Map();
  for (const slug of new Set([skill.legacySlug, skill.slug].filter(Boolean))) {
    const dir = historyDir(slug);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const m = /^v(\d+)\.md$/.exec(f);
      if (m) byVersion.set(Number(m[1]), { version: Number(m[1]), file: join(dir, f) });
    }
  }
  return [...byVersion.values()].sort((a, b) => a.version - b.version);
}

function addChangelog(skill, version, note, now) {
  const file = join(skill.dir, 'CHANGELOG.md');
  const entry = `## v${version} — ${today(now)}\n\n${note}\n`;
  const head = `# ${skill.name} changelog\n\nMaintained by the evolution plugin. Newest first.\n`;
  const old = existsSync(file) ? readFileSync(file, 'utf8') : head;
  const at = old.search(/^## /m);
  const next = at < 0 ? `${old.trimEnd()}\n\n${entry}` : `${old.slice(0, at)}${entry}\n${old.slice(at)}`;
  writeFileSync(file, next);
}

// Stamp version metadata, snapshot, and changelog -- but only when the skill
// actually changed since it was last stamped (or when forced, e.g. rollback).
export function register(skill, { note, force = false, now = Date.now() } = {}) {
  if (skill.locked) {
    throw new Error(`${skill.name} is locked (metadata evolution: "${skill.data.metadata.evolution}"); remove that line to let evolution manage it`);
  }
  if (!skill.parts.fm.length) throw new Error(`${skill.file} has no YAML frontmatter`);
  if (!skill.description.trim()) throw new Error(`${skill.file} has no description; Claude cannot trigger it without one`);
  const warnings = [];
  if (skill.data.name && skill.data.name !== skill.name) {
    warnings.push(`frontmatter name "${skill.data.name}" differs from directory "${skill.name}"`);
  }
  if (skill.description.length > 1024) warnings.push(`description is ${skill.description.length} chars (spec max 1024)`);
  const rawDesc = skill.parts.fm.map((l) => /^description:\s*(.*)$/.exec(l)?.[1]).find((v) => v !== undefined) ?? '';
  if (rawDesc && !/^["'|>]/.test(rawDesc) && /: |\s#/.test(rawDesc)) {
    warnings.push('description is a plain YAML scalar containing ": " or " #", which strict YAML parsers reject; use `description: >-` with the text indented on the next line');
  }

  const hash = contentHash(skill.parts.fm, skill.parts.body);
  if (!force && skill.evolved && hash === skill.hash) {
    return { changed: false, version: skill.version, skill, warnings };
  }
  const prior = snapshots(skill).at(-1)?.version ?? 0;
  const version = Math.max(skill.version, prior) + 1;
  const fm = setOwnMetadata(skill.parts.fm, {
    'evolution-version': version,
    'evolution-created': skill.created ?? today(now),
    'evolution-updated': today(now),
    'evolution-hash': hash,
  });
  const text = joinFrontmatter({ ...skill.parts, fm });
  writeFileSync(skill.file, text);
  mkdirSync(historyDir(skill.slug), { recursive: true });
  writeFileSync(join(historyDir(skill.slug), `v${version}.md`), text);
  const why = note?.trim() || (skill.evolved ? 'Updated.' : 'Adopted by evolution.');
  addChangelog(skill, version, why, now);
  logEvent({ ev: 'register', key: skill.key, dir: skill.dir, slug: skill.slug, name: skill.name, scope: skill.scope, version, note: why });
  return { changed: true, version, previous: skill.version, skill, warnings };
}

export function history(skill) {
  const log = join(skill.dir, 'CHANGELOG.md');
  return {
    snapshots: snapshots(skill),
    changelog: existsSync(log) ? readFileSync(log, 'utf8') : '',
  };
}

export function rollback(skill, to, { note, now } = {}) {
  const snap = snapshots(skill).find((s) => s.version === Number(to));
  if (!snap) throw new Error(`no snapshot v${to} for ${skill.name}; see \`history ${skill.name}\``);
  writeFileSync(skill.file, readFileSync(snap.file, 'utf8'));
  const restored = readSkill(skill.dir, { scope: skill.scope, project: skill.project });
  return register(restored, { force: true, now, note: note?.trim() || `Rolled back to the content of v${to}.` });
}

export function retire(skill, { reason, now = Date.now() } = {}) {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const dest = join(archiveDir(skill.slug), stamp);
  mkdirSync(dirname(dest), { recursive: true });
  try {
    renameSync(skill.dir, dest);
  } catch {
    // Different filesystem (e.g. project on another volume): copy, then remove.
    cpSync(skill.dir, dest, { recursive: true });
    rmSync(skill.dir, { recursive: true, force: true });
  }
  writeJson(join(dest, '.evolution-archive.json'), {
    name: skill.name, scope: skill.scope, project: skill.project, from: skill.dir,
    version: skill.version, retiredAt: new Date(now).toISOString(), reason: reason ?? null,
  });
  logEvent({ ev: 'retire', key: skill.key, dir: skill.dir, slug: skill.slug, name: skill.name, version: skill.version, reason: reason ?? null });
  return { archived: dest, slug: skill.slug };
}

export function archived() {
  const base = dirname(archiveDir('x'));
  if (!existsSync(base)) return [];
  const out = [];
  for (const slug of readdirSync(base)) {
    for (const stamp of readdirSync(join(base, slug))) {
      const meta = readJson(join(base, slug, stamp, '.evolution-archive.json'), null);
      if (meta) out.push({ slug, stamp, path: join(base, slug, stamp), ...meta });
    }
  }
  return out.sort((a, b) => a.stamp.localeCompare(b.stamp));
}

// Restore the most recent archive matching a slug or skill name.
export function restore(ref) {
  const match = archived().filter((a) => a.slug === ref || a.name === ref);
  if (!match.length) throw new Error(`nothing archived as "${ref}"; see \`archived\``);
  const slugs = new Set(match.map((a) => a.slug));
  if (slugs.size > 1) throw new Error(`"${ref}" matches several archives; pass one of: ${[...slugs].join(', ')}`);
  const latest = match.at(-1);
  if (existsSync(latest.from)) throw new Error(`${latest.from} already exists; move it aside first`);
  mkdirSync(dirname(latest.from), { recursive: true });
  try {
    renameSync(latest.path, latest.from);
  } catch {
    cpSync(latest.path, latest.from, { recursive: true });
    rmSync(latest.path, { recursive: true, force: true });
  }
  rmSync(join(latest.from, '.evolution-archive.json'), { force: true });
  logEvent({ ev: 'restore', dir: latest.from, slug: latest.slug, name: latest.name });
  return latest;
}

// "Low hits, high value" is real (the once-a-year disaster recipe). Keeping a
// skill on purpose resets its idle clock so prune stops nagging about it.
export function keep(skill, { reason } = {}) {
  logEvent({ ev: 'keep', key: skill.key, dir: skill.dir, slug: skill.slug, name: skill.name, reason: reason ?? null });
}

export function createdAt(skill) {
  if (skill.created) {
    const t = Date.parse(skill.created);
    if (!Number.isNaN(t)) return t;
  }
  try { return statSync(skill.file).mtimeMs; } catch { return Date.now(); }
}
