// Usage accounting: which skills actually fire, how often the session went
// wrong right after they did, and which have gone idle long enough (in both
// days *and* sessions) to be worth questioning.
import { createdAt } from './skills.mjs';

const DAY = 86_400_000;
const STOP = new Set(
  ('a an and are as at be by for from how in into is it of on or the this that to use used using when '
    + 'with without your you skill skills claude code fix fixes run runs').split(' '),
);

const blank = () => ({ hits: [], struggles: [], lastKeep: null, firstRegister: null, lastRegister: null });

export function usage(events) {
  const bySkill = new Map();
  const sessions = [];
  const seen = new Set();
  const touch = (key) => {
    if (!bySkill.has(key)) bySkill.set(key, blank());
    return bySkill.get(key);
  };
  for (const e of events) {
    if (e.ev === 'session') {
      if (seen.has(e.session)) continue;
      seen.add(e.session);
      sessions.push(e);
      continue;
    }
    if (!e.key) continue;
    if (e.ev === 'hit') touch(e.key).hits.push(e.t);
    else if (e.ev === 'struggle') touch(e.key).struggles.push(e.t);
    else if (e.ev === 'keep') {
      const u = touch(e.key);
      u.lastKeep = Math.max(u.lastKeep ?? 0, e.t);
    } else if (e.ev === 'register') {
      const u = touch(e.key);
      u.firstRegister ??= e.t;
      u.lastRegister = Math.max(u.lastRegister ?? 0, e.t);
    }
  }
  return { bySkill, sessions };
}

// v0.1 keyed events by absolute directory; v0.2 by scope + project identity
// + name. Read both so upgrading loses no history.
function record(skill, ledger) {
  const parts = [skill.key, skill.dir].filter(Boolean).map((k) => ledger.bySkill.get(k)).filter(Boolean);
  if (parts.length < 2) return parts[0] ?? blank();
  const max = (f) => parts.reduce((m, u) => (u[f] == null ? m : Math.max(m ?? 0, u[f])), null);
  const min = (f) => parts.reduce((m, u) => (u[f] == null ? m : Math.min(m ?? Infinity, u[f])), null);
  return {
    hits: parts.flatMap((u) => u.hits),
    struggles: parts.flatMap((u) => u.struggles),
    lastKeep: max('lastKeep'),
    firstRegister: min('firstRegister'),
    lastRegister: max('lastRegister'),
  };
}

const sameProject = (s, skill) => s.pid === skill.projectId || s.project === skill.project;

export function stats(skill, ledger, now = Date.now()) {
  const u = record(skill, ledger);
  const lastHit = u.hits.length ? Math.max(...u.hits) : null;
  const born = Math.min(u.firstRegister ?? Infinity, createdAt(skill));
  const idleFrom = Math.max(lastHit ?? 0, u.lastKeep ?? 0, born);
  // Outcomes are judged per version: a refinement wipes the slate.
  const since = u.lastRegister ?? 0;
  return {
    hits: u.hits.length,
    lastHit,
    born,
    struggles: u.struggles.length,
    hitsSince: u.hits.filter((t) => t >= since).length,
    strugglesSince: u.struggles.filter((t) => t >= since).length,
    idleDays: Math.floor((now - idleFrom) / DAY),
    idleSessions: ledger.sessions.filter((s) => s.t > idleFrom && (skill.scope !== 'project' || sameProject(s, skill))).length,
    descTokens: Math.ceil(skill.description.length / 4),
  };
}

const words = (s) => new Set(
  s.toLowerCase().match(/[a-z0-9][a-z0-9_.-]+/g)?.filter((w) => !STOP.has(w) && w.length > 2) ?? [],
);

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter += 1;
  return inter / (a.size + b.size - inter);
}

export function candidates(skills, ledger, {
  staleDays = 30, staleSessions = 20, maxDescription = 300, maxBodyLines = 500, overlap = 0.45,
  troubleUses = 3, troubleRate = 0.5, now = Date.now(),
} = {}) {
  const out = [];
  // Locked skills (`metadata: evolution: "off"`) are never nudged about or
  // edited, so they are never candidates, not even for overlap.
  skills = skills.filter((s) => !s.locked);
  for (const skill of skills) {
    const s = stats(skill, ledger, now);
    if (s.hitsSince >= troubleUses && s.strugglesSince / s.hitsSince >= troubleRate) {
      out.push({
        action: 'refine?', skill: skill.name, scope: skill.scope, dir: skill.dir,
        reason: `the session struggled right after ${s.strugglesSince} of its last ${s.hitsSince} uses; its content is wrong or incomplete`,
      });
    }
    if (s.idleDays >= staleDays && s.idleSessions >= staleSessions) {
      out.push({
        action: 'retire?', skill: skill.name, scope: skill.scope, dir: skill.dir,
        reason: s.hits
          ? `idle ${s.idleDays}d / ${s.idleSessions} sessions since last use (${s.hits} hits total)`
          : `never used in ${s.idleDays}d / ${s.idleSessions} sessions -- dead trigger or dead lesson`,
      });
    }
    if (skill.description.length > maxDescription) {
      out.push({
        action: 'trim?', skill: skill.name, scope: skill.scope, dir: skill.dir,
        reason: `description is ${skill.description.length} chars (~${s.descTokens} tokens in every session)`,
      });
    }
    if (skill.bodyLines > maxBodyLines) {
      out.push({
        action: 'trim?', skill: skill.name, scope: skill.scope, dir: skill.dir,
        reason: `body is ${skill.bodyLines} lines; split reference material into supporting files`,
      });
    }
  }
  const bags = skills.map((s) => words(`${s.name.replace(/-/g, ' ')} ${s.description}`));
  for (let i = 0; i < skills.length; i++) {
    for (let j = i + 1; j < skills.length; j++) {
      const sim = jaccard(bags[i], bags[j]);
      if (sim >= overlap) {
        out.push({
          action: 'merge?', skill: `${skills[i].name} + ${skills[j].name}`, scope: `${skills[i].scope}/${skills[j].scope}`,
          dir: skills[i].dir, other: skills[j].dir,
          reason: `descriptions overlap ${(sim * 100).toFixed(0)}%; overlapping triggers compete`,
        });
      }
    }
  }
  return out;
}

export function ago(t, now = Date.now()) {
  if (!t) return 'never';
  const d = now - t;
  if (d < 3_600_000) return '<1h ago';
  if (d < DAY) return `${Math.floor(d / 3_600_000)}h ago`;
  if (d < 60 * DAY) return `${Math.floor(d / DAY)}d ago`;
  return `${Math.floor(d / (30 * DAY))}mo ago`;
}
