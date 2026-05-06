import type { Skill, SkillName } from '@seedhac/contracts';

import { archiveSkill } from './archive.js';
import { docIterateSkill } from './doc-iterate.js';
import { progressUpdateSkill } from './progress-update.js';
import { qaSkill } from './qa.js';
import { recallSkill } from './recall.js';
import { requirementDocSkill } from './requirement-doc.js';
import { slidesSkill } from './slides.js';
import { summarySkill } from './summary.js';
import { taskAssignmentSkill } from './task-assignment.js';
import { weeklySkill } from './weekly.js';

export { archiveSkill } from './archive.js';
export { docIterateSkill } from './doc-iterate.js';
export { progressUpdateSkill } from './progress-update.js';
export { qaSkill } from './qa.js';
export { recallSkill } from './recall.js';
export { requirementDocSkill } from './requirement-doc.js';
export { slidesSkill } from './slides.js';
export { summarySkill } from './summary.js';
export { taskAssignmentSkill } from './task-assignment.js';
export { weeklySkill } from './weekly.js';

const registeredSkills: readonly Skill[] = [
  qaSkill,
  recallSkill,
  summarySkill,
  slidesSkill,
  archiveSkill,
  weeklySkill,
  requirementDocSkill,
  docIterateSkill,
  taskAssignmentSkill,
  progressUpdateSkill,
];

function assertSkillMetadata(skill: Skill): void {
  const metadata = skill.metadata;
  if (
    !metadata.description ||
    !metadata.when_to_use ||
    !Array.isArray(metadata.examples) ||
    metadata.examples.length === 0
  ) {
    throw new Error(`Skill "${skill.name}" is missing required metadata`);
  }
}

for (const skill of registeredSkills) assertSkillMetadata(skill);

/** 8 条业务主线注册表 — bot runtime 直接 import 这一行 */
export const skills: readonly Skill[] = registeredSkills;

export const skillsByName: Readonly<Record<SkillName, Skill>> = Object.fromEntries(
  skills.map((skill) => [skill.name, skill]),
) as Readonly<Record<SkillName, Skill>>;
