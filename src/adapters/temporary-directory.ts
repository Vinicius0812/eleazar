import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Runs an operation in an empty folder, so that no user or project file is within reach of the process. */
export async function inTemporaryDirectory<Result>(operation: (cwd: string) => Promise<Result>): Promise<Result> {
  const root = await realpath(tmpdir());
  const directory = await mkdtemp(join(root, "eleazar-"));
  try {
    return await operation(directory);
  } finally {
    if (dirname(resolve(directory)) === root) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
