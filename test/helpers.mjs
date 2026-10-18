import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point every path the plugin uses at a fresh sandbox.
export function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'evolution-test-'));
  const env = {
    CLAUDE_CONFIG_DIR: join(root, 'cfg'),
    CLAUDE_PROJECT_DIR: join(root, 'proj'),
  };
  const saved = {};
  for (const k of ['CLAUDE_CONFIG_DIR', 'CLAUDE_PROJECT_DIR', 'EVOLUTION_HOME']) saved[k] = process.env[k];
  Object.assign(process.env, env);
  delete process.env.EVOLUTION_HOME;
  mkdirSync(env.CLAUDE_PROJECT_DIR, { recursive: true });
  return {
    root,
    env,
    userSkills: join(env.CLAUDE_CONFIG_DIR, 'skills'),
    projectSkills: join(env.CLAUDE_PROJECT_DIR, '.claude', 'skills'),
    home: join(env.CLAUDE_CONFIG_DIR, 'evolution'),
    cleanup() {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function writeSkill(rootDir, name, { description = `Do ${name}. Use when ${name} breaks.`, body = `# ${name}\n\nSteps.\n`, extra = '' } = {}) {
  const dir = join(rootDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n${body}`);
  return dir;
}
