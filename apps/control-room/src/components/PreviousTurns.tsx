import { useState } from "react";
import { History } from "lucide-react";

import { ExecutionSession } from "./ExecutionSession.js";
import type { ControlRoomClient, Run } from "../services/contracts.js";

const runStatus: Record<Run["status"], string> = { planned: "Planejado", running: "Em execução", completed: "Concluído", failed: "Falhou", cancelled: "Cancelado" };

/** Earlier turns of a task, oldest first. Each one is fetched only when the operator opens it. */
export function PreviousTurns({ client, runs }: { client: ControlRoomClient; runs: Run[] }) {
  return (
    <article className="task-turn previous-turns" aria-labelledby="previous-turns-title">
      <div className="task-turn-heading">
        <History size={16} aria-hidden="true" />
        <h2 id="previous-turns-title">Turnos anteriores</h2>
      </div>
      {runs.map((run, index) => <PreviousTurn key={run.id} client={client} run={run} position={index + 1} />)}
    </article>
  );
}

function PreviousTurn({ client, run, position }: { client: ControlRoomClient; run: Run; position: number }) {
  const [opened, setOpened] = useState(false);
  return (
    <details className="previous-turn" onToggle={(event) => { if (event.currentTarget.open) setOpened(true); }}>
      <summary>
        <strong>Turno {position}</strong>
        <span className="previous-turn-message">{run.prompt ?? "Pedido original"}</span>
        <small>{[run.provider, runStatus[run.status]].filter(Boolean).join(" · ")}</small>
      </summary>
      {opened && <ExecutionSession client={client} executionId={run.id} showRequest={Boolean(run.prompt)} />}
    </details>
  );
}
