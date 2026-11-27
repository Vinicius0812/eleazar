import { lstat, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { SkillCandidate } from "../core/skill-catalog.js";
import { parseFrontmatter } from "../core/frontmatter.js";

export interface SkillRoot { source: SkillCandidate["source"]; directory: string; }

/** The operator's own skills: Claude Code's and Codex's user folders. Built-in (dot) folders are left out. */
export function defaultSkillRoots(home = homedir()): SkillRoot[] {
  return [
    { source: "claude", directory: join(home, ".claude", "skills") },
    { source: "codex", directory: join(home, ".codex", "skills") },
  ];
}

const maxSkillBytes = 256 * 1024;

/**
 * Reads `<root>/<skill>/SKILL.md` from each root. It only reads: originals are never written, moved or
 * copied, and files next to SKILL.md are listed by name only. Symbolic links are not followed.
 */
export async function discoverSkills(roots: readonly SkillRoot[]): Promise<SkillCandidate[]> {
  const found: SkillCandidate[] = [];
  for (const root of roots) {
    const entries = await readdir(root.directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.filter((item) => item.isDirectory() && !item.name.startsWith(".")).sort((a, b) => a.name.localeCompare(b.name))) {
      const folder = join(root.directory, entry.name);
      const file = join(folder, "SKILL.md");
      const info = await lstat(file).catch(() => null);
      if (!info?.isFile() || info.size > maxSkillBytes) continue;
      const text = await readFile(file, "utf8").catch(() => null);
      if (!text?.trim()) continue;
      const { fields, body } = parseFrontmatter(text);
      const supportFiles = (await readdir(folder).catch(() => [] as string[])).filter((name) => name !== "SKILL.md").sort();
      found.push({ source: root.source, slug: entry.name, name: fields.name || entry.name, description: fields.description ?? "", content: body.trim(), sourcePath: file, supportFiles });
    }
  }
  return found;
}

export { parseFrontmatter } from "../core/frontmatter.js";
