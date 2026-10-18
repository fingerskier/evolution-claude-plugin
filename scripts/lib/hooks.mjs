// Hook handlers. Each takes the hook's stdin payload and returns the JSON to
// print (or null for silence). They never throw past the CLI wrapper, so a
// broken ledger can never block a session.
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { candidates, usage } from './ledger.mjs';
import { projectDir, sessionsDir } from './paths.mjs';
import {
  assessSession, commandHead, decidingPart, describeArc, exitCodeOf, isCorrection, isOwnCommand, isProbe, isProbeFailure,
  slashSkill,
} from './signals.mjs';
import { findSkillDir, scanSkills } from './skills.mjs';
import { logEvent, logSession, readEvents, readSession, readState, updateState } from './store.mjs';

const DAY = 86_400_000;
const NUDGES = ['auto', 'suggest', 'off'];

const posInt = (v) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

// Plugin userConfig arrives as CLAUDE_PLUGIN_OPTION_<KEY>, but only in hooks.
// SessionStart saves the effective values so the CLI (run from skills) agrees.
export function configFromEnv(env = process.env) {
  const nudge = String(env.CLAUDE_PLUGIN_OPTION_NUDGE ?? '').trim().toLowerCase();
  return {
    nudge: NUDGES.includes(nudge) ? nudge : 'auto',
    threshold: posInt(env.CLAUDE_PLUGIN_OPTION_STRUGGLE_THRESHOLD) ?? 4,
    staleDays: posInt(env.CLAUDE_PLUGIN_OPTION_STALE_DAYS) ?? 30,
    staleSessions: 20,
  };
}

const project = (input) => projectDir(process.env.CLAUDE_PROJECT_DIR || input.cwd);

function sweepSessions(now) {
  const dir = sessionsDir();
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    const file = join(dir, f);
    try { if (now - statSync(file).mtimeMs > 3 * DAY) rmSync(file, { force: true }); } catch { /* raced */ }
  }
}

function recordHit(name, input, via) {
  if (!name) return;
  const sid = input.session_id;
  if (/^evolution:capture$/.test(name)) {
    if (sid) logSession(sid, { ev: 'captured' });
    return;
  }
  if (name.includes(':')) return; // other plugins' skills aren't ours to track
  const found = findSkillDir(name, project(input));
  if (!found) return;
  logEvent({ ev: 'hit', key: found.dir, name, scope: found.scope, via, session: sid ?? null });
  if (sid) logSession(sid, { ev: 'hit', name });
}

export function sessionStart(input, { now = Date.now() } = {}) {
  const cfg = configFromEnv();
  const proj = project(input);
  if (input.source !== 'compact') logEvent({ ev: 'session', session: input.session_id ?? null, project: proj });
  sweepSessions(now);
  const state = readState();
  updateState({ config: cfg });

  // At most one stale-skill reminder a week, on fresh starts only.
  if (input.source && input.source !== 'startup') return null;
  if (now - (state.lastNotice ?? 0) < 7 * DAY) return null;
  const skills = scanSkills(proj);
  if (!skills.length) return null;
  const stale = candidates(skills, usage(readEvents()), { ...cfg, now }).filter((c) => c.action === 'retire?');
  if (!stale.length) return null;
  updateState({ lastNotice: now });
  const names = stale.slice(0, 4).map((c) => c.skill).join(', ') + (stale.length > 4 ? ', ...' : '');
  const n = stale.length;
  return {
    systemMessage: `evolution: ${n} evolved skill${n === 1 ? ' looks' : 's look'} stale (${names}). Run /evolution:prune to review.`,
  };
}

export function prompt(input) {
  const sid = input.session_id;
  if (sid && isCorrection(input.prompt)) logSession(sid, { ev: 'correction' });
  recordHit(slashSkill(input.prompt), input, 'slash');
  return null;
}

export function toolOk(input) {
  if (input.tool_name === 'Skill') {
    recordHit(String(input.tool_input?.skill ?? '').replace(/^\//, ''), input, 'model');
  } else if (input.tool_name === 'Bash' && input.session_id) {
    const cmd = input.tool_input?.command;
    if (!isOwnCommand(cmd) && !isProbe(decidingPart(cmd))) logSession(input.session_id, { ev: 'ok', cmd: commandHead(cmd) });
  }
  return null;
}

export function toolFail(input) {
  if (input.tool_name !== 'Bash' || input.is_interrupt || !input.session_id) return null;
  const error = String(input.error ?? '');
  if (/user (?:denied|rejected|declined)|doesn'?t want to proceed|permission to use/i.test(error)) return null;
  const cmd = input.tool_input?.command;
  const code = exitCodeOf(error);
  if (isOwnCommand(cmd) || isProbeFailure(cmd, code)) return null;
  logSession(input.session_id, { ev: 'fail', cmd: commandHead(cmd), code });
  return null;
}

export function stop(input) {
  const cfg = configFromEnv();
  if (cfg.nudge === 'off' || input.stop_hook_active || !input.session_id) return null;
  const arc = assessSession(readSession(input.session_id), cfg.threshold);
  if (!arc.hard) return null;
  logSession(input.session_id, { ev: 'nudged', mode: cfg.nudge, score: arc.score });
  const what = describeArc(arc);
  if (cfg.nudge === 'suggest') {
    return { systemMessage: `evolution: that looked like a hard-won fix (${what}). Run /evolution:capture to keep the lesson as a skill.` };
  }
  return {
    decision: 'block',
    reason: `[evolution] This looked like a hard-won fix: ${what} before a command succeeded. `
      + 'Before stopping, use the evolution:capture skill to judge whether the lesson deserves a new or updated skill. '
      + 'If the work is not actually finished, or the lesson does not clear the bar, say so in one line and stop.',
  };
}

export const handlers = {
  'session-start': sessionStart,
  prompt,
  'tool-ok': toolOk,
  'tool-fail': toolFail,
  stop,
};
