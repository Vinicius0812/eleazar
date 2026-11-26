import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ControlRoomService } from "../src/core/control-room-service.js";
import { createControlRoomServer } from "../src/control-room/local-api.js";
import { SqliteControlRoomStore } from "../src/persistence/sqlite-control-room-store.js";

const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function folder(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix)); temporaryDirectories.push(path); return path;
}

describe("Editar projeto", () => {
  it("renomeia, reordena, adiciona e remove diretorios sem mudar o caminho dos que ficam", async () => {
    const home = await folder("eleazar-update-");
    const [a, b, c] = await Promise.all([folder("eleazar-a-"), folder("eleazar-b-"), folder("eleazar-c-")]);
    const store = new SqliteControlRoomStore(join(home, "control-room.sqlite"));
    const service = new ControlRoomService(store);
    try {
      const project = service.registerProject({ name: "Antigo", directories: [{ name: "A", path: a }, { name: "B", path: b }] });
      const [first, second] = project.directories;
      service.createTask({ projectId: project.id, targetDirectoryId: first!.id, title: "Usa A", prompt: "P" });

      const updated = service.updateProject(project.id, { name: "Novo nome", isolation: "direct",
        directories: [{ name: "Pasta C", path: c }, { id: first!.id, name: "Principal" }] });
      expect(updated).toMatchObject({ name: "Novo nome", isolation: "direct", path: c });
      expect(updated.directories.map((item) => [item.name, item.path])).toEqual([["Pasta C", c], ["Principal", a]]);
      expect(store.getProject(project.id)?.directories.some((item) => item.id === second!.id)).toBe(false);

      expect(() => service.updateProject(project.id, { name: "X", directories: [{ id: updated.directories[0]!.id }] })).toThrow("usado por tarefas");
      expect(() => service.updateProject(project.id, { name: "X", directories: [{ id: first!.id, path: b }] })).toThrow("nao pode mudar");
      expect(() => service.updateProject(project.id, { name: " ", directories: [{ id: first!.id }] })).toThrow("nome do projeto");
      expect(() => service.updateProject(project.id, { name: "X", directories: [{ id: first!.id }, { path: a }] })).toThrow("duplicados");

      const server = createControlRoomServer(service);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address(); if (!address || typeof address === "string") throw new Error("Endereco ausente");
        const response = await fetch(`http://127.0.0.1:${address.port}/api/control-room/projects/${project.id}/update`, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Pela API", directories: [{ id: first!.id }, { id: updated.directories[0]!.id, name: "C" }] }) });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ name: "Pela API", path: a, directories: [{ id: first!.id, name: "Principal" }, { name: "C" }] });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      store.close();
    }
  });
});
