import { join } from "node:path";

import { SqliteControlRoomStore } from "../persistence/sqlite-control-room-store.js";
import { createEleazar } from "../create-eleazar.js";
import { createControlRoomServer } from "./local-api.js";
import { createLocalControlRoomService } from "./local-service.js";
import { ControlRoomTaskExecutor } from "./task-executor.js";
import { ProviderStatusService } from "./provider-status.js";

const port = Number(process.env.ELEAZAR_CONTROL_ROOM_PORT ?? "4317");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("ELEAZAR_CONTROL_ROOM_PORT deve ser uma porta valida.");

const store = new SqliteControlRoomStore(join(process.cwd(), ".eleazar", "control-room.sqlite"));
const service = createLocalControlRoomService(store);
const orchestrator = createEleazar();
const executor = new ControlRoomTaskExecutor(service, orchestrator);
const providers = new ProviderStatusService(orchestrator, service);
const server = createControlRoomServer(service, executor, providers);
server.listen(port, "127.0.0.1", () => {
  console.log(`Eleazar Control Room API: http://127.0.0.1:${port}`);
});
