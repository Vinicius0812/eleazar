import { join } from "node:path";

import { SqliteControlRoomStore } from "../persistence/sqlite-control-room-store.js";
import { createEleazar, loadCustomProviders } from "../create-eleazar.js";
import { createControlRoomServer } from "./local-api.js";
import { createLocalControlRoomService } from "./local-service.js";
import { ControlRoomTaskExecutor } from "./task-executor.js";
import { ProviderStatusService } from "./provider-status.js";
import { OutboundActionService } from "../core/outbound-actions.js";
import { GitRepositoryPublisher } from "../adapters/git-publisher.js";
import { PullRequestService } from "../core/pull-requests.js";
import { GhPullRequestInspector } from "../adapters/gh-pull-requests.js";

const port = Number(process.env.ELEAZAR_CONTROL_ROOM_PORT ?? "4317");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("ELEAZAR_CONTROL_ROOM_PORT deve ser uma porta valida.");

const store = new SqliteControlRoomStore(join(process.cwd(), ".eleazar", "control-room.sqlite"));
store.recoverInterruptedExecutions("Host local reiniciado; execucao interrompida. Reenfileire manualmente para tentar novamente.");
// ELEAZAR_CONTROL_ROOM_WORKTREES=off keeps every task running directly in its folder.
const isolate = process.env.ELEAZAR_CONTROL_ROOM_WORKTREES?.toLowerCase() !== "off";
const service = createLocalControlRoomService(store, isolate ? { worktreeRoot: join(process.cwd(), ".eleazar", "worktrees") } : {});
const actions = new OutboundActionService(store, new GitRepositoryPublisher());
actions.recoverInterrupted();
const pullRequests = new PullRequestService(store, new GhPullRequestInspector());
// Open pull requests are re-read periodically so the board follows CI and reviews. 0 disables it.
const pollSeconds = Number(process.env.ELEAZAR_CONTROL_ROOM_PR_POLL_SECONDS ?? "60");
if (Number.isFinite(pollSeconds) && pollSeconds > 0) {
  setInterval(() => { void pullRequests.refreshAll().catch(() => undefined); }, Math.max(pollSeconds, 15) * 1_000).unref();
}
const custom = await loadCustomProviders(process.cwd());
for (const warning of custom.warnings) console.warn(warning);
const orchestrator = createEleazar({ customProviders: custom.specs, preferences: (id) => store.getProviderPreferences(id) });
const executor = new ControlRoomTaskExecutor(service, orchestrator, orchestrator.registry);
const providers = new ProviderStatusService(orchestrator, service);
const server = createControlRoomServer(service, executor, providers, actions, pullRequests);
server.listen(port, "127.0.0.1", () => {
  console.log(`Eleazar Control Room API: http://127.0.0.1:${port}`);
});
