import { useEffect, useState } from "react";
import { ArrowRight, ShieldQuestion } from "lucide-react";

import { isLiveExecution, type ControlRoomClient, type ExecutionDetail, type ExecutionPermission, type Run, type Task } from "../services/contracts.js";

interface Waiting { run: Run; task: Task; permissions: ExecutionPermission[]; }

/**
 * An ACP permission belongs to a live execution; it is not a scope approval and never
 * re-queues a task. A run counts as live only while it is running and its task still
 * holds a dispatch lease (a null lease means the dispatch already ended).
 */
export function liveRuns(runs: Run[], tasks: Task[]): Array<{ run: Run; task: Task }> {
  return runs.flatMap((run) => {
    const task = tasks.find((item) => item.id === run.taskId);
    return task && isLiveExecution(task, run) ? [{ run, task }] : [];
  });
}

export function PendingPermissions({ client, runs, tasks, projectName, onOpen, intervalMs = 3_000 }: {
  client: ControlRoomClient;
  runs: Run[];
  tasks: Task[];
  projectName(projectId: string): string;
  onOpen(executionId: string): void;
  intervalMs?: number;
}) {
  const live = liveRuns(runs, tasks);
  const key = live.map(({ run }) => run.id).join("|");
  const [waiting, setWaiting] = useState<Waiting[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = key ? live : [];
    async function poll() {
      const results = await Promise.allSettled(current.map(({ run }) => client.getExecutionDetail(run.id)));
      if (!alive) return;
      const next: Waiting[] = [];
      let failed = false;
      results.forEach((result, index) => {
        if (result.status === "rejected") { failed = true; return; }
        const detail: ExecutionDetail = result.value;
        const permissions = (detail.permissions ?? []).filter((permission) => permission.status === "pending");
        const entry = current[index];
        if (permissions.length && entry) next.push({ run: entry.run, task: detail.task, permissions });
      });
      setWaiting(next);
      setError(failed ? "Não foi possível consultar todas as execuções ativas." : "");
      if (current.length) timer = setTimeout(() => void poll(), intervalMs);
    }
    if (current.length) void poll(); else { setWaiting([]); setError(""); }
    return () => { alive = false; if (timer) clearTimeout(timer); };
    // `live` is derived from `key`; polling restarts only when the set of live runs changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key, intervalMs]);

  if (!waiting.length && !error) return null;
  return (
    <>
      {error && <div className="error" role="alert">{error}</div>}
      {waiting.map(({ run, task, permissions }) => (
        <article className="approval-card" key={run.id}>
          <span className="approval-label"><ShieldQuestion size={14} aria-hidden="true" /> AGENTE AGUARDANDO PERMISSÃO</span>
          <h3>{task.title}</h3>
          <p>{projectName(task.projectId)} · {run.id}</p>
          <div className="approval-action">{permissions.map((permission) => permission.title).join("; ")}</div>
          <button className="approval-button" onClick={() => onOpen(run.id)}>
            Abrir sessão e decidir
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        </article>
      ))}
    </>
  );
}
