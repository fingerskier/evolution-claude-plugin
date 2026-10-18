// Just enough YAML frontmatter handling for SKILL.md files. We only ever
// *read* simple scalars and the `metadata:` mapping, and only ever *write*
// our own `evolution-*` keys inside `metadata:` -- every other line is kept
// verbatim, so hand-written frontmatter survives a round trip untouched.
import { createHash } from 'node:crypto';

const OWN_KEY = /^\s+evolution-[A-Za-z0-9_.-]*:/;

export function splitFrontmatter(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trimEnd() !== '---') return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === '---');
  if (end < 0) return null;
  return { eol, fm: lines.slice(1, end), body: lines.slice(end + 1).join(eol) };
}

export function joinFrontmatter({ eol = '\n', fm, body }) {
  return ['---', ...fm, '---'].join(eol) + eol + body;
}

function unquote(v) {
  const s = v.trim();
  if (s.length >= 2 && s[0] === '"' && s.at(-1) === '"') {
    try { return JSON.parse(s); } catch { return s.slice(1, -1); }
  }
  if (s.length >= 2 && s[0] === "'" && s.at(-1) === "'") return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

export function parseFrontmatter(fm) {
  const data = {};
  for (let i = 0; i < fm.length; i++) {
    const m = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(fm[i]);
    if (!m) continue;
    const key = m[1];
    const raw = (m[2] ?? '').trim();
    const block = [];
    while (i + 1 < fm.length && (/^\s/.test(fm[i + 1]) || fm[i + 1].trim() === '')) block.push(fm[++i]);

    if (key === 'metadata' && raw === '') {
      const meta = {};
      for (const b of block) {
        const mm = /^\s+([A-Za-z0-9_.-]+):\s*(.*)$/.exec(b);
        if (mm) meta[mm[1]] = unquote(mm[2]);
      }
      data.metadata = meta;
    } else if (/^[|>][+-]?$/.test(raw)) {
      const parts = block.map((b) => b.trim());
      data[key] = raw[0] === '|' ? parts.join('\n').trim() : parts.filter(Boolean).join(' ');
    } else {
      data[key] = unquote([raw, ...block.map((b) => b.trim())].filter(Boolean).join(' '));
    }
  }
  data.metadata ??= {};
  return data;
}

// Replace our `evolution-*` keys under `metadata:` (creating the mapping if
// needed) and leave everything else alone.
export function setOwnMetadata(fm, values) {
  if (fm.some((l) => /^metadata:\s*\S/.test(l))) {
    throw new Error('SKILL.md uses inline (flow-style) metadata; rewrite it as a block mapping first');
  }
  const out = [...fm];
  let at = out.findIndex((l) => /^metadata:\s*$/.test(l));
  if (at < 0) {
    out.push('metadata:');
    at = out.length - 1;
  }
  let end = at + 1;
  while (end < out.length && (/^\s/.test(out[end]) || out[end].trim() === '')) end++;
  const block = out.slice(at + 1, end);
  const indent = block.find((l) => /^\s+\S/.test(l))?.match(/^\s+/)[0] ?? '  ';
  const kept = block.filter((l) => !OWN_KEY.test(l));
  const ours = Object.entries(values).map(([k, v]) => `${indent}${k}: ${JSON.stringify(String(v))}`);
  out.splice(at + 1, end - at - 1, ...ours, ...kept);
  return out;
}

// Fingerprint of everything a human would call "the skill": all frontmatter
// except our own bookkeeping, plus the body. Stamping metadata never changes it.
export function contentHash(fm, body) {
  const significant = fm
    .filter((l) => !/^metadata:\s*$/.test(l) && !OWN_KEY.test(l))
    .map((l) => l.trimEnd());
  return createHash('sha256')
    .update(significant.join('\n') + '\n---\n' + body.replace(/\s+$/, ''))
    .digest('hex')
    .slice(0, 16);
}
