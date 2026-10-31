// Repetition, not struggle. A workflow is a procedure that keeps succeeding by
// hand: the same distinctive steps, turn after turn, session after session.
// Each turn's steps are the command heads (and MCP tool writes) that
// succeeded; when this turn's steps match turns from enough *other* sessions,
// it is worth asking whether they should become a skill.

const DAY = 86_400_000;

// Plumbing that shows up in every kind of work, so it never makes a procedure
// distinctive. Anything else that turns out to be everywhere is caught by
// document frequency below.
const HOUSEKEEPING = new Set([
  'git add', 'git commit', 'git push', 'git pull', 'git fetch', 'git checkout', 'git switch', 'git merge', 'git rebase',
  'git stash', 'git reset', 'git restore', 'git rm', 'git mv', 'git clone', 'git init', 'git cherry-pick',
  'mkdir', 'cp', 'mv', 'rm', 'rmdir', 'touch', 'chmod', 'chown', 'ln', 'tar', 'unzip', 'curl', 'wget', 'sed', 'awk',
  'npm install', 'npm ci', 'npm i', 'pnpm install', 'pnpm i', 'yarn install', 'yarn', 'bun install', 'pip install',
  'pip3 install', 'uv sync', 'uv pip', 'poetry install', 'bundle install', 'go mod', 'cargo fetch',
  'node', 'node -e', 'python', 'python3', 'python -c', 'python3 -c', 'bash', 'sh', 'zsh',
]);

export const MIN_STEPS = 3;

// Distinct steps of one turn, in first-seen order.
export function procedureOf(turnEvents) {
  const steps = [];
  for (const e of turnEvents) {
    if (e.ev === 'ok' && e.cmd && !HOUSEKEEPING.has(e.cmd) && !steps.includes(e.cmd)) steps.push(e.cmd);
  }
  return steps;
}

// Steps present in more than `share` of all sessions are habits, not a
// procedure (the test runner, a memory tool some plugin calls every turn).
export function ubiquitous(procedures, sessionCount, { share = 0.4, minSessions = 5 } = {}) {
  if (sessionCount < minSessions) return new Set();
  const seen = new Map();
  for (const p of procedures) {
    for (const h of p.heads ?? []) {
      if (!seen.has(h)) seen.set(h, new Set());
      seen.get(h).add(p.session);
    }
  }
  return new Set([...seen].filter(([, s]) => s.size / sessionCount > share).map(([h]) => h));
}

const overlap = (a, b) => {
  const shared = [...a].filter((x) => b.has(x));
  return { shared, jaccard: shared.length / (a.size + b.size - shared.length || 1) };
};

// Does this turn repeat earlier sessions? Returns the shared steps and how many
// sessions (including this one) did them, or null.
export function findWorkflow(steps, ledgerEvents, {
  session, now = Date.now(), repeats = 2, similarity = 0.5, quietDays = 30,
} = {}) {
  const procedures = ledgerEvents.filter((e) => e.ev === 'procedure').slice(-2000);
  const sessionCount = new Set(ledgerEvents.filter((e) => e.ev === 'session').map((e) => e.session)).size;
  const common = ubiquitous(procedures, sessionCount);
  const mine = new Set(steps.filter((h) => !common.has(h)));
  if (mine.size < MIN_STEPS) return null;

  // Already asked about (and either captured or declined): stay quiet a while.
  const asked = ledgerEvents.some((e) => e.ev === 'workflow' && now - e.t < quietDays * DAY
    && overlap(mine, new Set(e.steps ?? [])).jaccard >= similarity);
  if (asked) return null;

  const matches = new Map();
  for (const p of procedures) {
    if (p.session === session || matches.has(p.session)) continue;
    const { shared, jaccard } = overlap(mine, new Set((p.heads ?? []).filter((h) => !common.has(h))));
    if (shared.length >= MIN_STEPS && jaccard >= similarity) matches.set(p.session, new Set(shared));
  }
  if (matches.size < repeats) return null;
  const everywhere = steps.filter((h) => mine.has(h) && [...matches.values()].every((s) => s.has(h)));
  return { sessions: matches.size + 1, steps: everywhere.length >= MIN_STEPS ? everywhere : [...mine] };
}
