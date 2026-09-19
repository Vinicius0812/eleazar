import { join } from "node:path";

import { ControlRoomService } from "../core/control-room-service.js";
import { GitWorktreeProvisioner } from "../core/git-worktree-provisioner.js";
import { SqliteControlRoomStore } from "../persistence/sqlite-control-room-store.js";
import { createControlRoomServer } from "./local-api.js";

const port = Number(process.env.ELEAZAR_CONTROL_ROOM_PORT ?? "4317");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("ELEAZAR_CONTROL_ROOM_PORT deve ser uma porta valida.");

const store = new SqliteControlRoomStore(join(process.cwd(), ".eleazar", "control-room.sqlite"));
const service = new ControlRoomService(store, new GitWorktreeProvisioner());
const server = createControlRoomServer(service);
server.listen(port, "127.0.0.1", () => {
  console.log(`Eleazar Control Room API: http://127.0.0.1:${port}`);
});
