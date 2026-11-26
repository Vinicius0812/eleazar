import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ControlRoomService } from "../src/core/control-room-service.js";
import { createControlRoomServer } from "../src/control-room/local-api.js";
import { SqliteControlRoomStore } from "../src/persistence/sqlite-control-room-store.js";

const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("Modelos de tarefa", () => {
  it("salva, lista e exclui modelos pela API local, e sobrevive a reabrir o banco", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eleazar-templates-")); temporaryDirectories.push(directory);
    const database = join(directory, ".eleazar", "control-room.sqlite");
    const store = new SqliteControlRoomStore(database);
    const service = new ControlRoomService(store);
    const project = service.registerProject({ name: "Core", path: process.cwd() });
    const server = createControlRoomServer(service);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("Endereco ausente");
      const api = `http://127.0.0.1:${address.port}/api/control-room`;
      const post = (path: string, body: object) => fetch(`${api}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

      const created = await post("/templates", { name: "Revisar PR", prompt: "Revise o pull request aberto e liste os riscos.", kind: "review", priority: "high", projectId: project.id });
      expect(created.status).toBe(201);
      const template = await created.json() as { id: string };
      expect(template).toMatchObject({ name: "Revisar PR", kind: "review", priority: "high", projectId: project.id, title: "" });
      expect((await post("/templates", { name: "revisar pr", prompt: "Outro" })).status).toBe(409);
      expect((await post("/templates", { name: "Sem prompt", prompt: " " })).status).toBe(400);
      await post("/templates", { name: "Atualizar dependencias", prompt: "Atualize as dependencias e rode os testes." });
      expect((await (await fetch(`${api}/templates`)).json() as Array<{ name: string }>).map((item) => item.name)).toEqual(["Atualizar dependencias", "Revisar PR"]);

      const removed = await post(`/templates/${template.id}/delete`, {});
      expect(removed.status).toBe(200);
      expect((await removed.json() as unknown[]).length).toBe(1);
      expect((await post(`/templates/${template.id}/delete`, {})).status).toBe(404);

      store.close();
      const reopened = new ControlRoomService(new SqliteControlRoomStore(database));
      expect(reopened.listTemplates().map((item) => item.name)).toEqual(["Atualizar dependencias"]);
      (reopened.store as SqliteControlRoomStore).close();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    }
  });
});
