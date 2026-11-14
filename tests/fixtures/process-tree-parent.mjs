// Fixture for process-lifecycle tests: no provider, no network. A parent that owns one descendant.
// Every process here has a bounded lifetime of its own, so nothing can outlive a failed test for long.
// Usage: node process-tree-parent.mjs <mode> <pid-file>
//   run    - stays alive (max 15 s) with one descendant (max 10 s)
//   exit   - exits with code 3 immediately, before creating any descendant
//   orphan - creates a descendant that lives 1.5 s, records the PIDs, then exits on its own after 100 ms
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [, , mode, pidFile] = process.argv;
if (mode === "exit") process.exit(3);

const descendantTtlMs = mode === "orphan" ? 1_500 : 10_000;
const descendant = spawn(process.execPath, ["-e", `setTimeout(() => process.exit(0), ${descendantTtlMs})`], { stdio: "ignore" });
writeFileSync(pidFile, JSON.stringify({ parent: process.pid, descendant: descendant.pid }));
if (mode === "orphan") {
  descendant.unref();
  setTimeout(() => process.exit(0), 100);
} else {
  setTimeout(() => process.exit(0), 15_000);
}
