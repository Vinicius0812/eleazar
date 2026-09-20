import type { ControlRoomStore } from "../core/control-room.js";
import { ControlRoomService } from "../core/control-room-service.js";

/** Production Control Room runs directly in selected directories; it never provisions Git worktrees. */
export function createLocalControlRoomService(store: ControlRoomStore): ControlRoomService {
  return new ControlRoomService(store, undefined, { useWorktrees: false });
}
