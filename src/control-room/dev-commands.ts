import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import type { ManagedCommand } from "./dev-supervisor.js";

/**
 * Commands of `npm run control-room`: the API (loopback, via tsx) and Vite, both started as plain
 * Node processes from their local entrypoints. No shell, no npm wrapper, fixed arguments, so paths
 * with spaces need no quoting. Vite also gets `--strictPort` on top of the existing `strictPort`
 * in vite.config.ts, so a busy 5173 fails loudly instead of moving to a port the API's CORS rejects.
 */
export function resolveDevCommands(root: string): ManagedCommand[] {
  const uiRoot = join(root, "apps", "control-room");
  const tsxCli = createRequire(join(root, "package.json")).resolve("tsx/cli");
  const vitePackage = createRequire(join(uiRoot, "package.json")).resolve("vite/package.json");
  const viteBin = (JSON.parse(readFileSync(vitePackage, "utf8")) as { bin: { vite: string } }).bin.vite;
  return [
    { name: "API", command: process.execPath, args: [tsxCli, "src/control-room/serve.ts"], cwd: root },
    { name: "Vite", command: process.execPath, args: [join(dirname(vitePackage), viteBin), "--host", "127.0.0.1", "--port", "5173", "--strictPort"], cwd: uiRoot }
  ];
}
