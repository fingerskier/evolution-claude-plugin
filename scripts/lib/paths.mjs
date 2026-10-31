// Where things live. Everything is computed lazily so tests (and users) can
// redirect it with CLAUDE_CONFIG_DIR / EVOLUTION_HOME / CLAUDE_PROJECT_DIR.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

export const configDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

// Ledger, history and archive live outside the plugin cache so they survive
// plugin updates and uninstalls -- just like the skills they describe.
export const evolutionHome = () => process.env.EVOLUTION_HOME || join(configDir(), 'evolution');

// Nearest ancestor (inclusive) that is the top of a git work tree.
export function gitRoot(from) {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// Hooks get CLAUDE_PROJECT_DIR; commands Claude runs through the Bash tool do
// not, and their cwd drifts (`cd packages/api`). The CLI therefore also takes
// --session (resolved from the ledger in evolution.mjs) and otherwise climbs
// to the git root instead of trusting cwd.
export function projectDir(explicit) {
  if (explicit) return resolve(explicit);
  if (process.env.CLAUDE_PROJECT_DIR) return resolve(process.env.CLAUDE_PROJECT_DIR);
  const cwd = process.cwd();
  return gitRoot(cwd) ?? cwd;
}

export const userSkillsRoot = () => join(configDir(), 'skills');
export const projectSkillsRoot = (project) => join(projectDir(project), '.claude', 'skills');

export const eventsFile = () => join(evolutionHome(), 'events.jsonl');
export const stateFile = () => join(evolutionHome(), 'state.json');
export const sessionsDir = () => join(evolutionHome(), 'sessions');
export const sessionFile = (id) => join(sessionsDir(), `${safe(id) || 'unknown'}.jsonl`);
export const historyDir = (slug) => join(evolutionHome(), 'history', slug);
export const archiveDir = (slug) => join(evolutionHome(), 'archive', slug);

export const safe = (s) => String(s ?? '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);

export const shortHash = (s, n = 8) => createHash('sha256').update(String(s)).digest('hex').slice(0, n);

// `git@github.com:o/r.git`, `https://user:tok@github.com/o/r`, `ssh://git@host:22/o/r`
// all become `github.com/o/r` / `host/o/r`. Credentials never survive. Local
// paths and file: URLs are not identities.
export function normalizeRemote(url) {
  let s = String(url ?? '').trim();
  if (!s || /^(?:file:|[./~]|[A-Za-z]:[\\/])/.test(s)) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') // scheme
    .replace(/^[^@/]+@/, '') // user[:password]@
    .replace(/^([^/:]+):(?!\d+\/)/, '$1/') // scp-like host:path
    .replace(/^([^/]+):\d+(?=\/)/, '$1') // :port
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
  const [host, ...rest] = s.split('/').filter(Boolean);
  return host && rest.length ? [host.toLowerCase(), ...rest].join('/') : null;
}

// The repository's git config, following `.git` files (worktrees, submodules).
function gitConfig(root) {
  let gitdir = join(root, '.git');
  if (statSync(gitdir).isFile()) {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(gitdir, 'utf8'));
    if (!m) return null;
    gitdir = resolve(root, m[1]);
    const common = join(gitdir, 'commondir');
    if (existsSync(common)) gitdir = resolve(gitdir, readFileSync(common, 'utf8').trim());
  }
  return readFileSync(join(gitdir, 'config'), 'utf8');
}

function originUrl(configText) {
  let section = '';
  for (const line of configText.split(/\r?\n/)) {
    const sec = /^\s*\[\s*([^\]\s"]+)(?:\s+"([^"]*)")?\s*\]/.exec(line);
    if (sec) { section = `${sec[1].toLowerCase()}.${sec[2] ?? ''}`; continue; }
    const m = section === 'remote.origin' && /^\s*url\s*=\s*(.+?)\s*$/i.exec(line);
    if (m) return m[1].replace(/^"(.*)"$/, '$1');
  }
  return null;
}

// What a project *is*, independent of where it is checked out: the origin
// remote (plus the subdirectory, when Claude Code was started below the git
// root), else the absolute path. Moving or re-cloning a repo keeps its usage
// history; two checkouts of one repo share it.
const identities = new Map();
export function projectIdentity(dir) {
  const abs = resolve(dir);
  if (!identities.has(abs)) {
    let id = abs;
    try {
      const root = gitRoot(abs);
      const origin = root && normalizeRemote(originUrl(gitConfig(root)) ?? '');
      if (origin) {
        const rel = relative(root, abs).split(sep).join('/');
        id = rel ? `${origin}#${rel}` : origin;
      }
    } catch { /* unreadable git metadata: fall back to the path */ }
    identities.set(abs, id);
  }
  return identities.get(abs);
}

// Stable, filesystem-safe id for a skill's history and archive: user skills
// by name, project skills by project identity and name. Every part comes from
// the identity (the readable prefix is the repo name), so renaming the
// checkout directory doesn't orphan snapshots.
export function skillSlug({ scope, name, project }) {
  if (scope === 'user') return `user--${safe(name)}`;
  const id = projectIdentity(project);
  return `${safe(id.split('#')[0].split(/[\\/]/).filter(Boolean).at(-1))}-${shortHash(id)}--${safe(name)}`;
}

// v0.1 hashed the absolute path; still read so old snapshots stay reachable.
export function legacySlug({ scope, name, project }) {
  if (scope === 'user') return `user--${safe(name)}`;
  return `${safe(basename(project))}-${shortHash(project)}--${safe(name)}`;
}

// Ledger key for a skill. v0.1 used the absolute directory; see ledger.mjs.
export function skillKey({ scope, name, project }) {
  return scope === 'user' ? `user:${name}` : `project:${projectIdentity(project)}:${name}`;
}
