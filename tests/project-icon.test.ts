import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ControlRoomService } from "../src/core/control-room-service.js";
import { createControlRoomServer } from "../src/control-room/local-api.js";
import { SqliteControlRoomStore } from "../src/persistence/sqlite-control-room-store.js";

const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("Icone do projeto", () => {
  it("serve o favicon da raiz ou de public/ como imagem, e 404 quando nao ha", async () => {
    const home = await mkdtemp(join(tmpdir(), "eleazar-icon-")); temporaryDirectories.push(home);
    const withIcon = join(home, "site"); const without = join(home, "lib");
    await mkdir(join(withIcon, "public"), { recursive: true }); await mkdir(without);
    await writeFile(join(withIcon, "public", "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    const store = new SqliteControlRoomStore(join(home, "control-room.sqlite"));
    const service = new ControlRoomService(store);
    const site = service.registerProject({ name: "Site", path: withIcon });
    const lib = service.registerProject({ name: "Lib", path: without });
    const server = createControlRoomServer(service);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("Endereco ausente");
      const icon = await fetch(`http://127.0.0.1:${address.port}/api/control-room/projects/${site.id}/icon`);
      expect(icon.status).toBe(200);
      expect(icon.headers.get("content-type")).toBe("image/svg+xml");
      expect(icon.headers.get("content-security-policy")).toContain("sandbox");
      expect(await icon.text()).toContain("<svg");
      expect((await fetch(`http://127.0.0.1:${address.port}/api/control-room/projects/${lib.id}/icon`)).status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    }
  });
});
