import { spawn } from "node:child_process";

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface ProcessOptions {
  cwd?: string;
  timeoutMs?: number;
  stdin?: string;
}

export async function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessOptions = {}
): Promise<ProcessResult> {
  const startedAt = Date.now();

  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      shell: false,
      stdio: "pipe",
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", reject);

    const timeout = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, options.timeoutMs)
      : undefined;

    child.on("close", (exitCode) => {
      if (timeout) {
        clearTimeout(timeout);
      }

      resolve({ exitCode, stdout, stderr, durationMs: Date.now() - startedAt, timedOut });
    });

    if (options.stdin) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}
