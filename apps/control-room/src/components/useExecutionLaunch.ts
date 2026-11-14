import { useCallback, useEffect, useState } from "react";

import type { AcpProvider, ControlRoomClient, ExecuteOptions, ExecutionProvider, ProviderConfig, Run, Task } from "../services/contracts.js";

export const providerLabels: Record<AcpProvider, string> = { codex: "Codex", claude: "Claude Code" };
type LoadedCatalog = { key: string; config: ProviderConfig | null; error: string };
type Choice = { key: string; model: string; resume: boolean };

const failureText = (reason: unknown) => reason instanceof Error ? reason.message : "Falha inesperada.";
const sameScope = (a: Task, b: Task) => a.projectId === b.projectId && a.targetDirectoryId === b.targetDirectoryId && a.directoryIds.join("\0") === b.directoryIds.join("\0");

/**
 * State of the "Executar" dialog for ACP providers (Codex and Claude): the provider choice,
 * its model catalog, the selected model and the optional session resume.
 *
 * Catalog and choices are stored together with a key (provider + task + target directory)
 * and ignored when the key no longer matches, so a late response or a model picked for a
 * previous provider/task can never leak into the current one. `auto` and `antigravity` have
 * no catalog and never send a model or session.
 */
export function useExecutionLaunch(client: ControlRoomClient, runs: Run[], tasks: Task[], task: Task | null) {
  const [provider, setProvider] = useState<ExecutionProvider>("auto");
  const [loaded, setLoaded] = useState<LoadedCatalog | null>(null);
  const [choice, setChoice] = useState<Choice>({ key: "", model: "", resume: false });
  const acp: AcpProvider | null = provider === "codex" || provider === "claude" ? provider : null;
  const directoryId = task?.targetDirectoryId ?? null;
  const key = acp && task && directoryId ? `${acp}:${task.id}:${directoryId}` : null;

  useEffect(() => {
    if (!key || !acp || !directoryId) return;
    let alive = true;
    client.getProviderConfig(acp, directoryId)
      .then((config) => { if (alive) setLoaded({ key, config, error: "" }); })
      .catch((reason) => { if (alive) setLoaded({ key, config: null, error: failureText(reason) }); });
    return () => { alive = false; };
  }, [client, key]);

  const catalog = key && loaded?.key === key ? loaded : null;
  const status = !key ? "idle" : !catalog ? "loading" : catalog.config ? "ready" : "error";
  const config = catalog?.config ?? null;
  const selected = key && choice.key === key ? choice : { key: "", model: "", resume: false };
  const model = config?.models.some((item) => item.id === selected.model) ? selected.model : "";

  // Latest finished ACP session of the SAME provider, project and exact directory scope.
  // Offered only when the agent's catalog declares `capabilities.loadSession === true`; a missing
  // field, `false` or a catalog failure never offers it. The API still revalidates the session.
  const resumableRun = acp && task ? runs.find((run) => {
    const previous = tasks.find((item) => item.id === run.taskId);
    return previous && run.sessionId && run.provider === acp && run.transport === "acp"
      && (run.status === "completed" || run.status === "failed") && sameScope(previous, task);
  }) : undefined;
  const canOfferResume = Boolean(resumableRun) && status === "ready" && config?.capabilities?.loadSession === true;
  const resume = canOfferResume && selected.resume;

  const reset = useCallback(() => { setProvider("auto"); setChoice({ key: "", model: "", resume: false }); }, []);
  /** Changing the provider always discards the model and resume choice made for the previous one. */
  const changeProvider = (next: ExecutionProvider) => { setProvider(next); setChoice({ key: "", model: "", resume: false }); };
  return {
    provider, setProvider: changeProvider, acp, status, config, error: catalog?.error ?? "", reset,
    model, setModel: (value: string) => key && setChoice({ ...selected, key, model: value }),
    resumableRun: canOfferResume ? resumableRun : undefined, resume,
    setResume: (value: boolean) => key && setChoice({ ...selected, key, resume: value }),
    /** Options for POST execute: only a catalogued model and an explicitly requested session. */
    options(): ExecuteOptions {
      return { ...(model ? { model } : {}), ...(resume && resumableRun?.sessionId ? { sessionId: resumableRun.sessionId } : {}) };
    }
  };
}
export type ExecutionLaunch = ReturnType<typeof useExecutionLaunch>;
