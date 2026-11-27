import { lstat, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { SkillCandidate } from "../core/skill-catalog.js";

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

/** `---` YAML-like header with single-line `key: value` pairs, as SKILL.md files use. */
export function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (pair) fields[pair[1]!] = pair[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return { fields, body: text.slice(match[0].length) };
}
