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
  env?: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
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
      env: options.env ?? process.env,
      shell: false,
      stdio: "pipe",
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let stdinError: Error | undefined;
    let outputBytes = 0;
    let outputTooLarge = false;

    function acceptOutput(chunk: string): boolean {
      if (!options.maxOutputBytes) return true;
      if (outputTooLarge) return false;
      outputBytes += Buffer.byteLength(chunk, "utf8");
      if (outputBytes <= options.maxOutputBytes) return true;
      outputTooLarge = true;
      child.kill();
      return false;
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (acceptOutput(chunk)) stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (acceptOutput(chunk)) stderr += chunk;
    });

    child.on("error", reject);
    child.stdin.on("error", (error) => { stdinError = error; });

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
      if (outputTooLarge) {
        reject(new Error("O subprocesso excedeu o limite de saida."));
        return;
      }
      if (stdinError && exitCode === 0) {
        reject(stdinError);
        return;
      }

      resolve({ exitCode, stdout, stderr, durationMs: Date.now() - startedAt, timedOut });
    });

    child.stdin.end(options.stdin);
  });
}
