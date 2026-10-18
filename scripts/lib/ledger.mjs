// Usage accounting: which evolved skills actually fire, and which have gone
// idle long enough (in both days *and* sessions) to be worth questioning.
import { createdAt } from './skills.mjs';

const DAY = 86_400_000;
const STOP = new Set(
  ('a an and are as at be by for from how in into is it of on or the this that to use used using when '
    + 'with without your you skill skills claude code fix fixes run runs').split(' '),
);

export function usage(events) {
  const bySkill = new Map();
  const sessions = [];
  const seen = new Set();
  const touch = (key) => {
    if (!bySkill.has(key)) bySkill.set(key, { hits: 0, lastHit: null, lastKeep: null, firstRegister: null });
    return bySkill.get(key);
  };
  for (const e of events) {
    if (e.ev === 'session') {
      if (seen.has(e.session)) continue;
      seen.add(e.session);
      sessions.push(e);
    } else if (e.ev === 'hit' && e.key) {
      const u = touch(e.key);
      u.hits += 1;
      u.lastHit = Math.max(u.lastHit ?? 0, e.t);
    } else if (e.ev === 'keep' && e.key) {
      const u = touch(e.key);
      u.lastKeep = Math.max(u.lastKeep ?? 0, e.t);
    } else if (e.ev === 'register' && e.key) {
      const u = touch(e.key);
      u.firstRegister ??= e.t;
    }
  }
  return { bySkill, sessions };
}

function sessionsSince(sessions, t, project) {
  return sessions.filter((s) => s.t > t && (!project || s.project === project)).length;
}

export function stats(skill, ledger, now = Date.now()) {
  const u = ledger.bySkill.get(skill.dir) ?? { hits: 0, lastHit: null, lastKeep: null, firstRegister: null };
  const born = Math.min(u.firstRegister ?? Infinity, createdAt(skill));
  const idleFrom = Math.max(u.lastHit ?? 0, u.lastKeep ?? 0, born);
  return {
    hits: u.hits,
    lastHit: u.lastHit,
    born,
    idleDays: Math.floor((now - idleFrom) / DAY),
    idleSessions: sessionsSince(ledger.sessions, idleFrom, skill.scope === 'project' ? skill.project : null),
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

export function candidates(skills, ledger, { staleDays = 30, staleSessions = 20, maxDescription = 300, maxBodyLines = 500, overlap = 0.45, now = Date.now() } = {}) {
  const out = [];
  for (const skill of skills) {
    const s = stats(skill, ledger, now);
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
