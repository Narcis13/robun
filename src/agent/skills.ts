import { join } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import matter from "gray-matter";

const BUILTIN_SKILLS_DIR = join(import.meta.dir, "../skills");

export class SkillsLoader {
  private workspaceSkills: string;
  private builtinSkills: string;

  constructor(workspace: string, builtinSkillsDir?: string) {
    this.workspaceSkills = join(workspace, "skills");
    this.builtinSkills = builtinSkillsDir ?? BUILTIN_SKILLS_DIR;
  }

  listSkills(filterUnavailable = true): Array<{ name: string; path: string; source: string }> {
    const skills: Array<{ name: string; path: string; source: string }> = [];
    const seen = new Set<string>();

    for (const dir of [this.workspaceSkills, this.builtinSkills]) {
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (seen.has(name)) continue;
        const skillFile = join(dir, name, "SKILL.md");
        if (!existsSync(skillFile)) continue;
        seen.add(name);

        if (filterUnavailable) {
          const meta = this.getSkillMetadata(name);
          if (meta && !this.checkRequirements(meta)) continue;
        }

        skills.push({
          name,
          path: skillFile,
          source: dir === this.workspaceSkills ? "workspace" : "builtin",
        });
      }
    }
    return skills;
  }

  loadSkill(name: string): string | null {
    for (const dir of [this.workspaceSkills, this.builtinSkills]) {
      const skillFile = join(dir, name, "SKILL.md");
      if (existsSync(skillFile)) return readFileSync(skillFile, "utf-8");
    }
    return null;
  }

  loadSkillsForContext(skillNames: string[]): string {
    return skillNames
      .map((name) => {
        const content = this.loadSkill(name);
        if (!content) return "";
        const { content: body } = matter(content);
        return `### Skill: ${name}\n\n${body}`;
      })
      .filter(Boolean)
      .join("\n\n");
  }

  buildSkillsSummary(): string {
    const skills = this.listSkills(false);
    const items = skills.map((s) => {
      const meta = this.getSkillMetadata(s.name);
      const available = meta ? this.checkRequirements(meta) : true;
      return `  <skill available="${available}">
    <name>${s.name}</name>
    <description>${meta?.description ?? ""}</description>
    <location>${s.path}</location>
  </skill>`;
    });
    return `<skills>\n${items.join("\n")}\n</skills>`;
  }

  getAlwaysSkills(): string[] {
    return this.listSkills()
      .filter((s) => {
        const meta = this.getSkillMetadata(s.name);
        return meta?.always === true;
      })
      .map((s) => s.name);
  }

  getSkillMetadata(name: string): Record<string, unknown> | null {
    const content = this.loadSkill(name);
    if (!content) return null;
    const { data } = matter(content);
    return data as Record<string, unknown>;
  }

  private checkRequirements(meta: Record<string, unknown>): boolean {
    const nbMeta = meta?.metadata as Record<string, unknown> | undefined;
    const nbReqs = (nbMeta?.robun as Record<string, unknown> | undefined)?.requires as
      | Record<string, unknown>
      | undefined;
    const requires = nbReqs ?? (meta?.requires as Record<string, unknown> | undefined);
    if (!requires) return true;

    const bins = requires.bins as string[] | undefined;
    if (bins) {
      for (const bin of bins) {
        try {
          const result = Bun.spawnSync(["which", bin]);
          if (result.exitCode !== 0) return false;
        } catch {
          return false;
        }
      }
    }

    const envVars = requires.env as string[] | undefined;
    if (envVars) {
      for (const envVar of envVars) {
        if (!process.env[envVar]) return false;
      }
    }

    return true;
  }
}
