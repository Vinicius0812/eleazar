import type { ControlRoomStore } from "../core/control-room.js";
import { ControlRoomService } from "../core/control-room-service.js";
import { GitWorktreeProvisioner } from "../core/git-worktree-provisioner.js";

export interface LocalControlRoomOptions {
  /** Folder that receives one worktree per task. Omit it to always run directly in the selected directories. */
  worktreeRoot?: string;
}

/**
 * With a worktree root, tasks whose whole scope is Git run on their own branch and worktree.
 * Plain folders, and every task when no root is given, run in place under the directory lock.
 */
export function createLocalControlRoomService(store: ControlRoomStore, options: LocalControlRoomOptions = {}): ControlRoomService {
  if (!options.worktreeRoot) return new ControlRoomService(store, undefined, { useWorktrees: false });
  return new ControlRoomService(store, new GitWorktreeProvisioner(options.worktreeRoot), { useWorktrees: true });
}
