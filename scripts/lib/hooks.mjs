// Hook handlers. Each takes the hook's stdin payload and returns the JSON to
// print (or null for silence). They never throw past the CLI wrapper, so a
// broken ledger can never block a session.
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { candidates, usage } from './ledger.mjs';
import { projectDir, projectIdentity, sessionsDir } from './paths.mjs';
import {
  assessSession, commandHead, decidingPart, describeArc, exitCodeOf, isCorrection, isMcpRead, isOwnCommand, isProbe,
  isProbeFailure, mcpHead, slashSkill,
} from './signals.mjs';
import { findSkill, scanSkills } from './skills.mjs';
import { logEvent, logSession, readEvents, readSession, readState, updateState } from './store.mjs';
import { MIN_STEPS, findWorkflow, procedureOf } from './workflows.mjs';

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
  if (name.includes(':')) return; // other plugins' skills live in their cache: not ours to track or edit
  const skill = findSkill(name, project(input));
  if (!skill) return;
  logEvent({ ev: 'hit', key: skill.key, dir: skill.dir, name, scope: skill.scope, owner: skill.owner, via, session: sid ?? null });
  if (sid) logSession(sid, { ev: 'hit', name, owner: skill.owner });
}

export function sessionStart(input, { now = Date.now() } = {}) {
  const cfg = configFromEnv();
  const proj = project(input);
  if (input.source !== 'compact') {
    logEvent({ ev: 'session', session: input.session_id ?? null, project: proj, pid: projectIdentity(proj) });
  }
  sweepSessions(now);
  const state = readState();
  updateState({ config: cfg });

  // At most one stale-skill reminder a week, on fresh starts only.
  if (input.source && input.source !== 'startup') return null;
  if (now - (state.lastNotice ?? 0) < 7 * DAY) return null;
  const skills = scanSkills(proj);
  if (!skills.length) return null;
  const flagged = candidates(skills, usage(readEvents()), { ...cfg, now }).filter((c) => c.action === 'retire?' || c.action === 'refine?');
  if (!flagged.length) return null;
  updateState({ lastNotice: now });
  const names = [...new Set(flagged.map((c) => c.skill))];
  const list = names.slice(0, 4).join(', ') + (names.length > 4 ? ', ...' : '');
  const n = names.length;
  const kinds = new Set(flagged.map((c) => c.action));
  const how = kinds.size > 1 ? 'stale or troubled' : kinds.has('retire?') ? 'stale' : 'troubled';
  return {
    systemMessage: `evolution: ${n} evolved skill${n === 1 ? ' looks' : 's look'} ${how} (${list}). Run /evolution:prune to review.`,
  };
}

export function prompt(input) {
  const sid = input.session_id;
  if (sid && isCorrection(input.prompt)) logSession(sid, { ev: 'correction' });
  recordHit(slashSkill(input.prompt), input, 'slash');
  return null;
}

export function toolOk(input) {
  const sid = input.session_id;
  const tool = String(input.tool_name ?? '');
  if (tool === 'Skill') {
    recordHit(String(input.tool_input?.skill ?? '').replace(/^\//, ''), input, 'model');
  } else if (tool === 'Bash' && sid) {
    const cmd = input.tool_input?.command;
    if (!isOwnCommand(cmd) && !isProbe(decidingPart(cmd))) logSession(sid, { ev: 'ok', cmd: commandHead(cmd) });
  } else if (sid && mcpHead(tool) && !isMcpRead(tool)) {
    logSession(sid, { ev: 'ok', cmd: mcpHead(tool) });
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

const sinceLast = (events, ev) => events.slice(events.map((e) => e.ev).lastIndexOf(ev) + 1);

// `block` makes Claude act on `reason` before it stops; otherwise the user
// gets a one-line hint.
const nudge = (block, reason, hint) => (block ? { decision: 'block', reason } : { systemMessage: hint });

function refineNudge(skill, arc, block) {
  const what = `${describeArc(arc.refine)} came after it`;
  const owned = skill.owner === 'evolved'
    ? `refine ${skill.name} with what was different this time`
    : `propose a fix to ${skill.name}. It is hand-written, so show the user the change and ask before editing; `
      + 'if they agree, adopt it with register first so the original is kept as v1';
  return nudge(
    block,
    `[evolution] The skill "${skill.name}" was used this session, and ${what} before things worked. `
      + `Before stopping, use the evolution:capture skill to ${owned}. `
      + 'If the trouble had nothing to do with the skill, say so in one line and stop.',
    `evolution: "${skill.name}" was used, then ${what}. Run /evolution:capture refine ${skill.name} to improve it.`,
  );
}

export function stop(input, { now = Date.now() } = {}) {
  const cfg = configFromEnv();
  const sid = input.session_id;
  if (!sid) return null;
  const events = readSession(sid);
  const turn = sinceLast(events, 'turn-end');
  logSession(sid, { ev: 'turn-end' });

  // Remember what this turn did, whatever the nudge mode: repetition across
  // sessions is how workflows are found.
  const proj = project(input);
  const steps = procedureOf(turn);
  if (steps.length >= MIN_STEPS) logEvent({ ev: 'procedure', session: sid, project: projectIdentity(proj), heads: steps });
  if (input.stop_hook_active) return null;

  const arc = assessSession(events, cfg.threshold);

  // 1. A skill fired and the session struggled: refine *that* skill. The
  //    outcome is recorded even when nudges are off, so prune can see it.
  //    This is the most precise signal there is, so in auto mode it always blocks.
  const skill = arc.refine && findSkill(arc.refine.name, proj);
  if (skill && skill.owner !== 'locked') {
    logEvent({ ev: 'struggle', key: skill.key, dir: skill.dir, name: skill.name, scope: skill.scope, session: sid, score: arc.refine.score });
    logSession(sid, { ev: 'nudged', kind: 'refine', mode: cfg.nudge, skill: skill.name });
    return cfg.nudge === 'off' ? null : refineNudge(skill, arc, cfg.nudge === 'auto');
  }
  if (cfg.nudge === 'off') return null;

  // 2 and 3 are guesses; in auto mode only the first one per session blocks.
  const block = cfg.nudge === 'auto' && !events.some((e) => e.ev === 'blocked');
  const sent = () => { if (block) logSession(sid, { ev: 'blocked' }); };

  // 2. A struggle that ended in a fix: maybe a new lesson.
  if (arc.hard) {
    logSession(sid, { ev: 'nudged', kind: 'capture', mode: cfg.nudge, score: arc.score });
    sent();
    const what = describeArc(arc);
    return nudge(
      block,
      `[evolution] This looked like a hard-won fix: ${what} before things worked. `
        + 'Before stopping, use the evolution:capture skill to judge whether the lesson deserves a new or updated skill. '
        + 'If the work is not actually finished, or the lesson does not clear the bar, say so in one line and stop.',
      `evolution: that looked like a hard-won fix (${what}). Run /evolution:capture to keep the lesson as a skill.`,
    );
  }

  // 3. A procedure repeated across sessions that no skill covered: maybe a workflow.
  if (steps.length < MIN_STEPS || turn.some((e) => e.ev === 'hit')) return null;
  const wf = findWorkflow(steps, readEvents(), { session: sid, now });
  if (!wf) return null;
  logEvent({ ev: 'workflow', session: sid, project: projectIdentity(proj), steps: wf.steps });
  sent();
  const list = wf.steps.map((s) => `\`${s}\``).join(', ');
  return nudge(
    block,
    `[evolution] This turn repeated a procedure now done in ${wf.sessions} sessions: ${list}. `
      + 'Before stopping, use the evolution:capture skill to judge whether it should become a workflow skill. '
      + 'If it is not a stable, repeatable procedure, say so in one line and stop.',
    `evolution: you have now done ${list} in ${wf.sessions} sessions. Run /evolution:capture workflow to make it a skill.`,
  );
}

export const handlers = {
  'session-start': sessionStart,
  prompt,
  'tool-ok': toolOk,
  'tool-fail': toolFail,
  stop,
};
