/** `---` YAML-like header with single-line `key: value` pairs, as SKILL.md files use. */
export function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!pair) continue;
    const raw = pair[2]!.trim();
    // A JSON-quoted value (as the export writes for names with symbols) is decoded; single quotes are stripped.
    let value = raw.replace(/^'(.*)'$/, "$1");
    if (/^".*"$/.test(raw)) { try { value = JSON.parse(raw) as string; } catch { value = raw.slice(1, -1); } }
    fields[pair[1]!] = value;
  }
  return { fields, body: text.slice(match[0].length) };
}
