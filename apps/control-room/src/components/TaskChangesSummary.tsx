import { useEffect, useState } from "react";
import { FileDiff, FolderTree } from "lucide-react";

import { fileExplorerHash } from "./FileExplorerPage.js";
import type { ControlRoomClient, ExplorerChange, ExplorerRoot, Task } from "../services/contracts.js";

const letter: Record<ExplorerChange["kind"], string> = { added: "A", modified: "M", deleted: "D", renamed: "R", untracked: "U" };
const shown = 8;

/** What the task changed so far, as a compact diff summary under the conversation; each file opens in the explorer. */
export function TaskChangesSummary({ client, task }: { client: ControlRoomClient; task: Task }) {
  const [groups, setGroups] = useState<Array<{ root: ExplorerRoot; changes: ExplorerChange[] }> | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const roots = await client.getTaskFileRoots(task.id);
        const loaded = await Promise.all(roots.filter((root) => root.isGitRepository).map(async (root) => ({ root, changes: (await client.getTaskChanges(task.id, root.directoryId)).changes })));
        if (alive) setGroups(loaded);
      } catch { if (alive) setGroups([]); }
    })();
    return () => { alive = false; };
    // Re-read when the task moves (a turn ended, a commit was made).
  }, [client, task.id, task.status, task.updatedAt]);

  const all = (groups ?? []).flatMap((group) => group.changes.map((change) => ({ ...change, root: group.root })));
  if (!all.length) return null;
  const additions = all.reduce((sum, change) => sum + (change.additions ?? 0), 0);
  const deletions = all.reduce((sum, change) => sum + (change.deletions ?? 0), 0);
  const multiple = (groups ?? []).filter((group) => group.changes.length).length > 1;
  return (
    <section className="task-changes" aria-labelledby="task-changes-title">
      <div className="task-turn-heading">
        <FileDiff size={16} aria-hidden="true" />
        <h3 id="task-changes-title">{all.length} arquivo{all.length === 1 ? "" : "s"} alterado{all.length === 1 ? "" : "s"}</h3>
        <span className="task-changes-total"><span className="add">+{additions}</span> <span className="remove">−{deletions}</span></span>
      </div>
      <ul className="task-changes-list">
        {all.slice(0, shown).map((change) => (
          <li key={`${change.root.directoryId}:${change.path}`}>
            <a href={fileExplorerHash(task.id, { directoryId: change.root.directoryId, path: change.path })} title="Ver o diff">
              <span className={`change-badge ${change.kind}`}>{letter[change.kind]}</span>
              <code>{multiple ? `${change.root.name}/` : ""}{change.path}</code>
              {change.additions !== null && <span className="task-changes-count"><span className="add">+{change.additions}</span> <span className="remove">−{change.deletions}</span></span>}
            </a>
          </li>
        ))}
      </ul>
      <div className="task-changes-footer">
        {all.length > shown && <small>e mais {all.length - shown}</small>}
        <a className="secondary" href={fileExplorerHash(task.id)}><FolderTree size={15} aria-hidden="true" /> Revisar no explorador</a>
      </div>
    </section>
  );
}
