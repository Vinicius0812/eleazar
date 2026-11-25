import { statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * Absolute path of a bare command found in PATH. Spawning the bare name would let Windows pick a file with
 * that name from the folder where the agent works, before PATH is searched.
 */
export function findOnPath(name: string, searchPath = process.env.PATH ?? process.env.Path ?? ""): string | null {
  const names = process.platform === "win32" && !/\.exe$/i.test(name) ? [`${name}.exe`] : [name];
  for (const directory of searchPath.split(delimiter).map((item) => item.replace(/^"|"$/g, ""))) {
    if (!isAbsolute(directory)) continue;
    for (const candidate of names) {
      const path = join(directory, candidate);
      try { if (statSync(path).isFile()) return path; } catch { /* Not in this folder. */ }
    }
  }
  return null;
}
