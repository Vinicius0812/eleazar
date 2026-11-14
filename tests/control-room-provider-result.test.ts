import { mkdtemp, rm } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentRunResult } from "../src/core/contracts.js";
import { ControlRoomService } from "../src/core/control-room-service.js";
import type { TaskExecution } from "../src/core/control-room.js";
import { maxOutputLength, maxSummaryLength, outputTruncationMarker } from "../src/core/provider-result.js";
import { createControlRoomServer } from "../src/control-room/local-api.js";
import { SqliteControlRoomStore } from "../src/persistence/sqlite-control-room-store.js";

// Real domain service + SQLite in a temporary directory; the provider result is a plain object, no model is called.
const directories: string[] = [];
const stores: SqliteControlRoomStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function finishWith(result: Partial<AgentRunResult> & Pick<AgentRunResult, "status">) {
  const directory = await mkdtemp(join(tmpdir(), "eleazar-provider-result-"));
  directories.push(directory);
  const store = new SqliteControlRoomStore(join(directory, ".eleazar", "control-room.sqlite"));
  stores.push(store);
  const service = new ControlRoomService(store, undefined, { useWorktrees: false });
  const project = service.registerProject({ name: "Core", path: process.cwd() });
  const task = service.createTask({ projectId: project.id, title: "Resultado", prompt: "Qualquer pedido" });
  const running = await service.dispatch(task.id, { selectedProvider: "codex", reason: "teste", candidates: [], requestedActions: [] });
  const execution = store.listExecutions(task.id)[0]!;
  service.finishProviderRun(task.id, running.dispatchLease!, { provider: "codex", response: "", durationMs: 5, ...result });
  const detail = service.executionDetail(execution.id)!;
  return { service, store, execution: detail.execution as TaskExecution, logs: detail.logs, detail };
}

describe("provider result persistence", () => {
  it("keeps the partial Markdown output of a failed run and shows the nested JSON error as a readable summary and log", async () => {
    const partial = "## Análise parcial\n\n- achei **dois** problemas\n";
    const error = JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error", message: "Modelo indisponível", code: "model_not_found" } });
    const { execution, logs } = await finishWith({ status: "error", response: partial, error });
    expect(execution.status).toBe("failed");
    expect(execution.output).toBe(partial);
    expect(execution.summary).toBe("Modelo indisponível");
    expect(logs.at(-1)?.level).toBe("error");
    expect(logs.at(-1)?.message).toContain("Motivo: Modelo indisponível");
  });

  it("preserves a successful JSON response byte for byte, with other fields and formatting", async () => {
    const response = '  {\n  "message": "x",\n  "other": "y"\n}\n\n';
    const { execution } = await finishWith({ status: "success", response });
    expect(execution.output).toBe(response);
    expect(execution.summary).toBe(response.trim());
  });

  it("preserves meaningful whitespace and line breaks in the output", async () => {
    const response = "\n    código indentado\n\n\ttab\r\nfim   \n";
    const { execution } = await finishWith({ status: "success", response });
    expect(execution.output).toBe(response);
  });

  it("keeps output within the limit, with the explicit marker, at and above the threshold", async () => {
    const exact = await finishWith({ status: "success", response: "a".repeat(maxOutputLength) });
    expect(exact.execution.output).toBe("a".repeat(maxOutputLength));

    const over = await finishWith({ status: "success", response: "a".repeat(maxOutputLength + 1) });
    expect(over.execution.output).toHaveLength(maxOutputLength);
    expect(over.execution.output!.endsWith(outputTruncationMarker)).toBe(true);

    const surrogate = await finishWith({ status: "error", response: `a${"😀".repeat(maxOutputLength)}`, error: "falhou" });
    const output = surrogate.execution.output!;
    expect(output.length).toBeLessThanOrEqual(maxOutputLength);
    expect(output.endsWith(outputTruncationMarker)).toBe(true);
    const body = output.slice(0, -outputTruncationMarker.length);
    expect(/[\ud800-\udbff]$/.test(body)).toBe(false); // no half surrogate pair left at the cut
  });

  it("caps the summary at 4000 characters while keeping the full output", async () => {
    const response = "x".repeat(10_000);
    const { execution } = await finishWith({ status: "success", response });
    expect(execution.summary).toHaveLength(maxSummaryLength);
    expect(execution.summary!.endsWith("...")).toBe(true);
    expect(execution.output).toBe(response);
    const failed = await finishWith({ status: "error", response: "", error: "e".repeat(10_000) });
    expect(failed.execution.summary).toHaveLength(maxSummaryLength);
  });

  it("falls back without inventing a cause when there is no response or no error detail", async () => {
    const empty = await finishWith({ status: "success", response: "   " });
    expect(empty.execution.output).toBe("Execucao concluida sem resposta textual.");
    expect(empty.execution.summary).toBe("Execucao concluida sem resposta textual.");

    const bare = await finishWith({ status: "error", response: "", error: "  " });
    expect(bare.execution.summary).toBe("O provedor nao retornou detalhes do erro.");
    expect(bare.execution.output).toBe("O provedor nao retornou detalhes do erro.");

    const partialWithoutCause = await finishWith({ status: "error", response: "Texto parcial" });
    expect(partialWithoutCause.execution.output).toBe("Texto parcial");
    expect(partialWithoutCause.execution.summary).toBe("O provedor nao retornou detalhes do erro.");
  });

  it("returns the preserved output through the execution detail endpoint", async () => {
    const response = '{"message":"x","other":"y"}\n';
    const { service, execution } = await finishWith({ status: "success", response });
    const server = createControlRoomServer(service);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Endereco ausente");
      const body = await new Promise<{ execution: { output: string } }>((resolve, reject) => {
        get({ hostname: "127.0.0.1", port: address.port, path: `/api/control-room/executions/${execution.id}`, headers: { host: `127.0.0.1:${address.port}`, origin: "http://127.0.0.1:5173" } }, (reply) => {
          let text = "";
          reply.setEncoding("utf8");
          reply.on("data", (chunk: string) => { text += chunk; });
          reply.on("end", () => resolve(JSON.parse(text)));
        }).on("error", reject);
      });
      expect(body.execution.output).toBe(response);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
