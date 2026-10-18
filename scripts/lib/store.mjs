// Append-only JSONL logs plus one small JSON state file. Appends are atomic
// enough for concurrent hooks from parallel sessions; nothing is ever
// read-modify-written except state.json, which only holds throttles/config.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { eventsFile, sessionFile, stateFile } from './paths.mjs';

export function appendJsonl(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify({ t: Date.now(), ...obj }) + '\n');
}

export function readJsonl(file) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn or hand-edited line: skip */ }
  }
  return out;
}

export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJson(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  renameSync(tmp, file);
}

export const logEvent = (obj) => appendJsonl(eventsFile(), obj);
export const readEvents = () => readJsonl(eventsFile());
export const logSession = (id, obj) => appendJsonl(sessionFile(id), obj);
export const readSession = (id) => readJsonl(sessionFile(id));
export const readState = () => readJson(stateFile(), {});
export const updateState = (patch) => writeJson(stateFile(), { ...readState(), ...patch });
