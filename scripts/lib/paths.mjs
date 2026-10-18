// Where things live. Everything is computed lazily so tests (and users) can
// redirect it with CLAUDE_CONFIG_DIR / EVOLUTION_HOME / CLAUDE_PROJECT_DIR.
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export const configDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

// Ledger, history and archive live outside the plugin cache so they survive
// plugin updates and uninstalls -- just like the skills they describe.
export const evolutionHome = () => process.env.EVOLUTION_HOME || join(configDir(), 'evolution');

export const projectDir = (explicit) => resolve(explicit || process.env.CLAUDE_PROJECT_DIR || process.cwd());

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

// Stable, filesystem-safe id for a skill: user skills by name, project skills
// by project (basename + path hash, so two checkouts never collide) and name.
export function skillSlug({ scope, name, project }) {
  if (scope === 'user') return `user--${safe(name)}`;
  return `${safe(basename(project))}-${shortHash(project)}--${safe(name)}`;
}
