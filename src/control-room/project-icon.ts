import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { LocalProject } from "../core/control-room.js";

/** Where web projects usually keep their favicon, most common first. Only these names are ever read. */
const candidates = [
  "favicon.svg", "favicon.ico", "favicon.png",
  "public/favicon.svg", "public/favicon.ico", "public/favicon.png",
  "static/favicon.svg", "static/favicon.ico", "static/favicon.png",
  "app/favicon.ico", "app/icon.svg", "app/icon.png",
  "src/favicon.svg", "src/favicon.ico", "src/favicon.png",
  "assets/favicon.svg", "assets/favicon.ico", "assets/favicon.png",
];
const types: Record<string, string> = { svg: "image/svg+xml", ico: "image/x-icon", png: "image/png" };
const maxIconBytes = 256 * 1024;

export interface ProjectIcon { contentType: string; body: Buffer; }

/**
 * The favicon found at a well-known path of one of the project's folders, in folder order.
 * Symbolic links and files larger than 256 KB are ignored.
 */
export async function findProjectIcon(project: LocalProject): Promise<ProjectIcon | null> {
  for (const directory of project.directories) {
    for (const relative of [...candidates, ...await workspaceCandidates(directory.path)]) {
      const path = join(directory.path, ...relative.split("/"));
      const info = await lstat(path).catch(() => null);
      if (!info?.isFile() || info.size === 0 || info.size > maxIconBytes) continue;
      const handle = await open(path, "r").catch(() => null);
      if (!handle) continue;
      try {
        const body = await handle.readFile();
        const extension = relative.slice(relative.lastIndexOf(".") + 1);
        return { contentType: types[extension]!, body };
      } finally { await handle.close(); }
    }
  }
  return null;
}

/** Monorepos keep the web app one level down: apps/<name>/public/favicon.* (and packages/<name>). */
async function workspaceCandidates(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const folder of ["apps", "packages"]) {
    const entries = await readdir(join(root, folder), { withFileTypes: true }).catch(() => []);
    for (const entry of entries.filter((item) => item.isDirectory()).slice(0, 20)) {
      for (const name of ["favicon.svg", "favicon.ico", "favicon.png"]) found.push(`${folder}/${entry.name}/public/${name}`);
    }
  }
  return found;
}
