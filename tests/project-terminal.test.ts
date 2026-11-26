import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ControlRoomService } from "../src/core/control-room-service.js";
import { createControlRoomServer } from "../src/control-room/local-api.js";
import { TaskFileExplorer } from "../src/control-room/file-explorer.js";
import { ProjectTerminals, resolveBash, type TerminalEvent } from "../src/control-room/project-terminal.js";
import { SqliteControlRoomStore } from "../src/persistence/sqlite-control-room-store.js";

const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 3 }))); });

let bash: string | null = null;
try { bash = resolveBash(); } catch { bash = null; }

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "eleazar-terminal-")); temporaryDirectories.push(home);
  const folder = join(home, "projeto");
  await mkdir(join(folder, "sub"), { recursive: true });
  await writeFile(join(folder, "leia.txt"), "ola terminal\n");
  const store = new SqliteControlRoomStore(join(home, ".eleazar", "control-room.sqlite"));
  const service = new ControlRoomService(store);
  const project = service.registerProject({ name: "Terminal", path: folder });
  return { store, service, project };
}

describe.skipIf(!bash)("terminal do projeto", () => {
  it("roda comandos na pasta do projeto, guarda o diretorio entre comandos e informa o codigo de saida", async () => {
    const { store, service, project } = await fixture();
    const terminals = new ProjectTerminals(service);
    try {
      const session = terminals.open(project.id, project.directories[0]!.id);
      const events: TerminalEvent[] = [];
      terminals.subscribe(session.id, 0, (event) => events.push(event));
      const done = () => events.filter((event) => event.kind === "done");

      terminals.write(session.id, "cat leia.txt");
      await vi.waitFor(() => expect(done()).toHaveLength(1), { timeout: 10_000 });
      expect(events.filter((event) => event.kind === "stdout").map((event) => event.text).join("")).toContain("ola terminal");
      expect(done()[0]).toMatchObject({ exitCode: 0 });

      terminals.write(session.id, "cd sub && false");
      await vi.waitFor(() => expect(done()).toHaveLength(2), { timeout: 10_000 });
      expect(done()[1]).toMatchObject({ exitCode: 1 });
      expect(terminals.get(session.id).cwd.replaceAll("\\", "/")).toMatch(/projeto\/sub$/);
      expect(events.some((event) => event.kind === "stdout" && event.text?.includes("ELEAZAR"))).toBe(false);

      expect(() => terminals.write(session.id, "echo a\necho b")).toThrow("um comando por vez");
      expect(terminals.list(project.id)).toHaveLength(1);
      await terminals.close(session.id);
      await vi.waitFor(() => expect(events.at(-1)?.kind).toBe("exit"));
      expect(terminals.list(project.id)).toHaveLength(0);
      expect(() => terminals.write(session.id, "pwd")).toThrow("encerrado");
    } finally {
      await terminals.closeAll();
      store.close();
    }
  });

  it("abre, executa e transmite pela API local", async () => {
    const { store, service, project } = await fixture();
    const terminals = new ProjectTerminals(service);
    const server = createControlRoomServer(service, undefined, undefined, undefined, undefined, new TaskFileExplorer(service), terminals);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("Endereco ausente");
      const api = `http://127.0.0.1:${address.port}/api/control-room`;
      const post = (path: string, body: object) => fetch(`${api}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      expect((await post(`/projects/${project.id}/terminals`, { directoryId: "outro" })).status).toBe(404);
      const opened = await post(`/projects/${project.id}/terminals`, { directoryId: project.directories[0]!.id });
      expect(opened.status).toBe(201);
      const session = await opened.json() as { id: string };
      expect((await post(`/terminals/${session.id}/input`, { command: "echo via-api" })).status).toBe(202);
      await vi.waitFor(() => expect(terminals.get(session.id).busy).toBe(false), { timeout: 10_000 });
      expect((await post(`/terminals/${session.id}/close`, {})).status).toBe(200);
      const stream = await fetch(`${api}/terminals/${session.id}/events`);
      const text = await stream.text();
      expect(text).toContain("event: input");
      expect(text).toContain("via-api");
      expect(text).toContain("event: exit");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await terminals.closeAll();
      store.close();
    }
  });
});
