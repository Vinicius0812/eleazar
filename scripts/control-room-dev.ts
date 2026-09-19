import { spawn } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const processes = [
  spawn(npm, ["exec", "tsx", "src/control-room/serve.ts"], { stdio: "inherit", shell: process.platform === "win32" }),
  spawn(npm, ["run", "dev", "--prefix", "apps/control-room"], { stdio: "inherit", shell: process.platform === "win32" })
];

let stopping = false;
function stop(code = 0): void {
  if (stopping) return;
  stopping = true;
  for (const child of processes) child.kill();
  process.exitCode = code;
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
for (const child of processes) child.once("exit", (code) => stop(code ?? 1));
