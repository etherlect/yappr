import type { SkillDef } from "./types.js";

let _skills: SkillDef[] = [];

export function initSkills(skills: SkillDef[]): void {
  _skills = skills;
}

export function getSkill(name: string): SkillDef | undefined {
  return _skills.find((s) => s.name === name);
}
