import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { resolveDevCommands } from "../src/control-room/dev-commands.js";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");

describe("control-room launcher commands", () => {
  const commands = resolveDevCommands(root);

  it("uses Node with fixed arguments, loopback Vite on a strict port, and the right working directories", () => {
    const [api, vite] = commands;
    expect(commands.map((item) => item.name)).toEqual(["API", "Vite"]);
    expect(commands.every((item) => item.command === process.execPath)).toBe(true);
    expect(api?.args.slice(1)).toEqual(["src/control-room/serve.ts"]);
    expect(vite?.args.slice(1)).toEqual(["--host", "127.0.0.1", "--port", "5173", "--strictPort"]);
    expect(api?.cwd).toBe(root);
    expect(vite?.cwd).toBe(resolve(root, "apps", "control-room"));
  });

  it("resolves entrypoints that really run with --version (no shell, real path with spaces, no API or database started)", async () => {
    for (const item of commands) {
      const { stdout } = await run(item.command, [item.args[0]!, "--version"], { shell: false, cwd: item.cwd, windowsHide: true, timeout: 30_000 });
      expect(stdout.trim().length).toBeGreaterThan(0);
    }
  });
});
