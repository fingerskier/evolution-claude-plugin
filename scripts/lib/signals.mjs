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

export function commandHead(cmd) {
  const first = stages(cmd)[0]?.[0] ?? String(cmd ?? '').trim();
  const words = first.split(/\s+/);
  // Keep the subcommand for multiplexers: "npm test", "cargo build", "git push".
  const n = /^(npm|pnpm|yarn|bun|npx|cargo|go|git|docker|kubectl|make|uv|poetry|pip|python3?|node|deno|dotnet|mvn|gradle|bundle|rails|mix)$/.test(words[0]) ? 2 : 1;
  // `node "/long/path/build.mjs"` reads better as `node build.mjs`.
  return words.slice(0, n).map((w) => w.replace(/^["']|["']$/g, '').split(/[\\/]/).at(-1)).join(' ').slice(0, 60);
}

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

// Phrases people type when the previous attempt didn't work.
const CORRECTION = new RegExp(
  [
    "\\bstill (?:fail\\w*|broken|wrong|erroring|not (?:working|fixed|passing)|doesn'?t work|getting|seeing|the same)",
    '\\bsame (?:error|problem|issue|failure|exception|result)\\b',
    "\\b(?:that|it|this) (?:didn'?t|doesn'?t|did not|does not|won'?t) (?:work|fix|help|compile|build|pass)",
    '\\bnot (?:fixed|working)\\b',
    '\\b(?:wrong|broken|failing) again\\b',
    "\\bthat'?s (?:wrong|not it|not right|incorrect)\\b",
    '\\byou broke\\b',
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

// Look at the session since the last nudge/capture and decide whether it was
// a struggle that ended in a working state.
export function assessSession(events, threshold) {
  let from = 0;
  events.forEach((e, i) => { if (e.ev === 'nudged' || e.ev === 'captured') from = i + 1; });
  const arc = events.slice(from);
  const fails = arc.filter((e) => e.ev === 'fail');
  const corrections = arc.filter((e) => e.ev === 'correction');
  const lastIndex = (pred) => arc.reduce((acc, e, i) => (pred(e) ? i : acc), -1);
  const lastOk = lastIndex((e) => e.ev === 'ok');
  const lastBad = lastIndex((e) => e.ev === 'fail' || e.ev === 'correction');
  const score = fails.length + 2 * corrections.length;
  const resolved = lastOk >= 0 && lastOk > lastBad;
  return {
    score,
    fails: fails.length,
    corrections: corrections.length,
    resolved,
    hard: score >= threshold && resolved,
    commands: [...new Set(fails.map((e) => e.cmd).filter(Boolean))].slice(0, 3),
  };
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
