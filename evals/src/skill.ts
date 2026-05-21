import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = join(here, '../../extension/skills/qa-debug/SKILL.md');

export function loadSkill(): { name: string; description: string } {
  const raw = readFileSync(SKILL_PATH, 'utf8');
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error(`SKILL.md missing frontmatter at ${SKILL_PATH}`);
  const fm = match[1];

  const nameLine = fm.split('\n').find((l) => l.startsWith('name:'));
  if (!nameLine) throw new Error('SKILL.md frontmatter missing `name`');
  const name = nameLine.slice('name:'.length).trim();

  const descIdx = fm.indexOf('description:');
  if (descIdx === -1) throw new Error('SKILL.md frontmatter missing `description`');
  const descRaw = fm.slice(descIdx + 'description:'.length).trim();
  const description = descRaw.replace(/\s+/g, ' ');

  return { name, description };
}
