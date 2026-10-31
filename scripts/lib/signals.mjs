// Heuristics for "this fix was hard-won". Deliberately crude: they only decide
// whether to *ask*; the capture skill's quality gate decides what gets kept.

// Commands whose failure usually means "looked and found nothing", not struggle.
const PROBES = new Set([
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'find', 'fd', 'ls', 'tree', 'test', '[', '[[', 'which', 'command',
  'type', 'whereis', 'diff', 'cmp', 'stat', 'file', 'head', 'tail', 'cat', 'less', 'wc', 'pgrep', 'pidof', 'readlink',
  'realpath', 'echo', 'printf', 'true', 'false', 'sleep', 'jq', 'du', 'df', 'ps', 'env', 'printenv', 'id', 'whoami',
]);
const GIT_PROBE = /^git\s+(status|diff|log|show|rev-parse|ls-files|ls-remote|branch|remote|config|describe|cat-file|grep|blame|stash\s+list)\b/;
const SETUP = /^(cd|pushd|popd|export|source|\.|set|unset|alias|nvm\s+use)\b/;
const WRAPPERS = /^(?:(?:\w+=\S*\s+)+|sudo\s+|time\s+|nice\s+|timeout\s+\S+\s+|env\s+(?:\w+=\S*\s+)*)+/;

const strip = (s) => s.trim().replace(WRAPPERS, '').trim();

// Naive on purpose: splits on && || ; | without honoring quotes. Good enough
// for classification; a misparse only ever errs toward "not a probe".
function stages(cmd) {
  return String(cmd ?? '')
    .split(/&&|\|\||;|\n/)
    .map((seg) => seg.split(/\|(?!\|)/).map(strip).filter(Boolean))
    .filter((pipe) => pipe.length && !SETUP.test(pipe[0]));
}

const isProbeStage = (s) => PROBES.has(s.split(/\s+/)[0]) || GIT_PROBE.test(s);

// CLIs whose first argument is the real verb, and verbs that take one more:
// `npm run build`, `python -m pytest`, `docker compose up`, `gh pr create`.
const MULTI = /^(npm|pnpm|yarn|bun|npx|bunx|cargo|go|git|docker|podman|kubectl|helm|make|uv|poetry|pip3?|python3?|node|deno|dotnet|mvn|gradle|bundle|rails|mix|gh|glab|aws|gcloud|az|terraform|tofu|fly|flyctl|vercel|netlify|wrangler|supabase|firebase|heroku|systemctl|brew|nx|turbo)$/;
const DEEP_VERB = new Set(['run', 'exec', '-m', 'compose', 'dlx', 'x']);
const DEEP_CLI = /^(gh|glab|aws|gcloud|az)$/;

export function commandHead(cmd) {
  const first = stages(cmd)[0]?.[0] ?? String(cmd ?? '').trim();
  const words = first.split(/\s+/);
  let n = MULTI.test(words[0]) ? 2 : 1;
  if (n === 2 && words[2] && !words[2].startsWith('-') && (DEEP_VERB.has(words[1]) || DEEP_CLI.test(words[0]))) n = 3;
  // `node "/long/path/build.mjs"` reads better as `node build.mjs`.
  return words.slice(0, n).map((w) => w.replace(/^["']|["']$/g, '').split(/[\\/]/).at(-1)).join(' ').slice(0, 60);
}

// MCP tools as procedure steps: `mcp__slack__send_message` -> `mcp:slack/send_message`.
// Reads are looking-around, like shell probes.
export function mcpHead(tool) {
  const m = /^mcp__(.+?)__(.+)$/.exec(String(tool ?? ''));
  return m ? `mcp:${m[1]}/${m[2]}` : null;
}
export const isMcpRead = (tool) => /_(?:get|list|search|read|query|fetch|find|describe|view|lookup|count|check|poll)(?:_|$)/i.test(String(tool ?? ''));

// Pure looking-around: its success proves nothing and its failure costs nothing.
export function isProbe(cmd) {
  const pipes = stages(cmd);
  return pipes.every((pipe) => pipe.every(isProbeStage));
}

// After `;` or a newline only the last command decides the exit status, so
// `npm test; echo done` proves nothing and `build; grep x missing` fails cheaply.
export function decidingPart(cmd) {
  return String(cmd ?? '').split(/;|\n/).filter((s) => s.trim()).at(-1) ?? '';
}

// Our own CLI is machinery, not the user's work.
export const isOwnCommand = (cmd) => /scripts[\\/]evolution\.mjs/.test(String(cmd ?? ''));

// Filters whose exit status 1 means "no match", not "broken".
const NO_MATCH = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'diff', 'cmp', 'test', '[', '[[']);

export function isProbeFailure(cmd, exitCode) {
  if (isProbe(cmd) || isProbe(decidingPart(cmd))) return true;
  // `npm test | grep FAIL` exits 1 when grep finds nothing -- that's good news.
  // (`npm test | tail` exiting 1 is npm failing under pipefail: real.)
  const last = stages(cmd).at(-1).at(-1);
  return exitCode === 1 && NO_MATCH.has(last.split(/\s+/)[0]);
}

export function exitCodeOf(text) {
  const m = /exit code[:\s]+(-?\d+)/i.exec(String(text ?? ''));
  return m ? Number(m[1]) : null;
}

// Phrases people type when the previous attempt didn't work -- or wasn't how
// they wanted it done. Both are lessons; the second kind is how a workflow
// skill learns the user's way of doing things.
const CORRECTION = new RegExp(
  [
    // it's broken
    "\\bstill (?:fail\\w*|broken|wrong|erroring|not (?:working|fixed|passing)|doesn'?t work|getting|seeing|the same)",
    '\\bsame (?:error|problem|issue|failure|exception|result|thing)\\b',
    "\\b(?:that|it|this) (?:didn'?t|doesn'?t|did not|does not|won'?t) (?:work|fix|help|compile|build|pass)",
    '\\bnot (?:fixed|working)\\b',
    '\\b(?:wrong|broken|failing) again\\b',
    "\\bthat'?s (?:wrong|not it|not right|incorrect|not what)\\b",
    '\\byou broke\\b',
    '\\btry again\\b',
    // do it my way
    '^\\s*(?:no|nope|nah)\\s*[,.!;:\u2014\u2013-]\\s*(?!(?:thanks|thank you|problem|worries|rush)\\b)',
    "^\\s*(?:no|nope)\\s+(?:that|this|it|you|we|use|don'?t|not|wait|stop|instead)\\b",
    '^\\s*nope\\b',
    "^\\s*actually\\b[,\\s]+(?:we|you|it'?s?|that'?s?|this|use|don'?t|do not|should|need|the|never|always)\\b",
    "\\b(?:don'?t|do not|never|stop) (?:do|doing|use|using|run|running|call|touch|add|create|edit|change|commit|push|delete|remove) (?:that|this|it|those|these)\\b",
    '\\bwe (?:always|never|usually|normally) (?:use|run|do|deploy|push|go|have|need)\\b',
    '\\b(?:use|try|run|call) \\S+(?: \\S+)? instead\\b',
    '\\binstead of (?:that|this|using|running)\\b',
    '\\byou (?:forgot|missed|skipped|need(?:ed)? to|have to|should(?: have)?|were supposed to)\\b',
  ].join('|'),
  'i',
);

export function isCorrection(prompt) {
  // Only the part the person typed: long pastes (logs, diffs) quote old failures.
  return CORRECTION.test(String(prompt ?? '').slice(0, 400));
}

// Slash invocations of a skill, typed or expanded.
export function slashSkill(prompt) {
  const s = String(prompt ?? '');
  const m = /^\s*\/([A-Za-z0-9_.:-]+)/.exec(s) ?? /<command-name>\/?([A-Za-z0-9_.:-]+)<\/command-name>/.exec(s);
  return m ? m[1] : null;
}

const lastIndex = (events, pred) => events.reduce((acc, e, i) => (pred(e) ? i : acc), -1);

// Score a stretch of session signals. "Resolved" means the thing that was
// failing now passes: a later success of a command that failed (or, when only
// corrections were involved, any later success). `git stash` after four red
// `npm test` runs is not a fix.
export function judge(events) {
  const fails = events.filter((e) => e.ev === 'fail');
  const corrections = events.filter((e) => e.ev === 'correction');
  const failed = new Set(fails.map((e) => e.cmd).filter(Boolean));
  const lastBad = lastIndex(events, (e) => e.ev === 'fail' || e.ev === 'correction');
  const fixedAt = lastIndex(events, (e) => e.ev === 'ok' && (!failed.size || failed.has(e.cmd)));
  return {
    score: fails.length + 2 * corrections.length,
    fails: fails.length,
    corrections: corrections.length,
    resolved: fixedAt >= 0 && fixedAt > lastBad,
    commands: [...failed].slice(0, 3),
  };
}

// The trouble that bought a refinement: two failed commands or one correction.
export const REFINE_SCORE = 2;
const ACTIVITY = new Set(['ok', 'fail', 'hit']);

// Look at the session since the last nudge/capture and decide what, if
// anything, to ask about:
//   refine   a skill fired, then the session struggled, then it was fixed:
//            that skill was wrong or incomplete, and we know which one.
//   capture  a struggle (score >= threshold) that ended in a fix.
export function assessSession(events, threshold) {
  let from = 0;
  events.forEach((e, i) => { if (e.ev === 'nudged' || e.ev === 'captured') from = i + 1; });
  // A correction means something only once there is work to correct; the
  // opening request ("don't use regex") is a spec, not a struggle.
  const firstActivity = events.findIndex((e) => ACTIVITY.has(e.ev));
  const arc = events.slice(from).filter((e, i) => e.ev !== 'correction' || (firstActivity >= 0 && from + i > firstActivity));
  const overall = judge(arc);
  const hard = overall.score >= threshold && overall.resolved;
  const refine = findRefine(arc);
  return { ...overall, hard, refine, kind: refine ? 'refine' : hard ? 'capture' : null };
}

// The latest skill hit followed (before the next hit) by real trouble, if the
// session has since recovered. Still broken: nothing to learn yet.
function findRefine(arc) {
  const hits = arc.flatMap((e, i) => (e.ev === 'hit' && e.owner !== 'locked' ? [i] : []));
  for (let h = hits.length - 1; h >= 0; h--) {
    const at = hits[h];
    const segment = judge(arc.slice(at + 1, hits[h + 1] ?? arc.length));
    if (segment.score < REFINE_SCORE) continue;
    if (!judge(arc.slice(at + 1)).resolved) return null;
    return { name: arc[at].name, ...segment };
  }
  return null;
}

export function describeArc(a) {
  const parts = [];
  if (a.fails) {
    const cmds = a.commands.length ? ` (${a.commands.map((c) => `\`${c}\``).join(', ')})` : '';
    parts.push(`${a.fails} failed command${a.fails === 1 ? '' : 's'}${cmds}`);
  }
  if (a.corrections) parts.push(`${a.corrections} correction${a.corrections === 1 ? '' : 's'} from the user`);
  return parts.join(' and ');
}
