import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, FilePen, FileSearch, FileText, Globe, ListChecks, SquareTerminal, Trash2, Wrench, type LucideIcon } from "lucide-react";

import { AgentGlyph } from "./AgentGlyph.js";
import { AgentMarkdown } from "./AgentMarkdown.js";
import type { ConversationItem, PlanEntry, ToolActivity } from "./useExecutionSession.js";

const toolStatusCopy: Record<string, string> = { pending: "Pendente", in_progress: "Em andamento", completed: "Concluída", failed: "Falhou" };
const planStatusCopy: Record<string, string> = { pending: "A fazer", in_progress: "Em andamento", completed: "Feito" };
/** Distance from the end, in pixels, that still counts as following the conversation. */
const followMargin = 48;

/**
 * What the agent said and did, in order. While the turn is live it scrolls inside a bounded area that
 * follows new content unless the operator scrolled up; history opened later is shown at full height.
 */
export function AgentConversation({ provider, items, plan, active, waiting, children }: {
  provider: string | null;
  items: ConversationItem[];
  plan: PlanEntry[];
  active: boolean;
  /** Status line shown at the end while the agent has not finished. */
  waiting: string | null;
  /** Persisted text for runs that streamed none. */
  children?: ReactNode;
}) {
  const area = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [behind, setBehind] = useState(false);
  // Keeps the bounded area after the turn ends, so the page does not jump under the reader.
  const [bounded, setBounded] = useState(active);
  useEffect(() => { if (active) setBounded(true); }, [active]);
  const scrollToEnd = () => { if (area.current) area.current.scrollTop = area.current.scrollHeight; };
  useEffect(() => { if (bounded && following.current) scrollToEnd(); }, [items, plan, waiting, bounded]);
  const onScroll = () => {
    const element = area.current;
    if (!element) return;
    following.current = element.scrollHeight - element.scrollTop - element.clientHeight <= followMargin;
    setBehind(!following.current);
  };

  if (!items.length && !plan.length && !waiting && !children) return null;
  return (
    <div className={`conversation ${bounded ? "bounded" : ""}`}>
      {plan.length > 0 && <PlanCard plan={plan} />}
      <div ref={area} className="conversation-log" role="log" aria-live="off" aria-label="Conversa com o agente" {...(bounded ? { tabIndex: 0, onScroll } : {})}>
        {items.map((item) => item.kind === "message"
          ? <div className="conversation-message" key={item.id}><AgentGlyph provider={provider} size={18} /><AgentMarkdown>{item.text}</AgentMarkdown></div>
          : <ToolGroup key={item.id} tools={item.tools} />)}
        {children && <div className="conversation-message"><AgentGlyph provider={provider} size={18} />{children}</div>}
        {waiting && <p className="session-waiting">{waiting}</p>}
      </div>
      {bounded && behind && (
        <button type="button" className="secondary conversation-follow" onClick={() => { following.current = true; setBehind(false); scrollToEnd(); }}>
          <ArrowDown size={14} aria-hidden="true" /> Ir para o fim
        </button>
      )}
    </div>
  );
}

/** Some agents already put the full path in the title. */
function extraLocations(tool: ToolActivity): string[] {
  return tool.locations.filter((path) => !tool.title.includes(path));
}

/** ACP tool kinds, each with its own icon, so reading, editing and running commands are told apart at a glance. */
const toolIcons: Record<string, LucideIcon> = { read: FileText, edit: FilePen, delete: Trash2, move: FilePen, search: FileSearch, execute: SquareTerminal, fetch: Globe };

/** Long absolute paths (worktrees live deep in `.eleazar`) keep their last segments; the full path stays in the tooltip. */
export function shortPath(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (path.length <= 60 || parts.length <= 3) return path;
  return `…/${parts.slice(-3).join("/")}`;
}

function ToolGroup({ tools }: { tools: ToolActivity[] }) {
  return (
    <ul className="conversation-tools" aria-label="Atividade de ferramentas">
      {tools.map((tool) => {
        const Icon = (tool.toolKind && toolIcons[tool.toolKind]) || Wrench;
        const locations = extraLocations(tool);
        return <li key={tool.toolCallId} className={tool.status ? `tool-${tool.status}` : undefined}>
          <Icon size={13} aria-hidden="true" />
          <strong>{tool.title}</strong>
          {tool.status && <span className={`tool-status ${tool.status}`}>{toolStatusCopy[tool.status] ?? tool.status}</span>}
          {locations.length > 0 && <small title={locations.join("\n")}>{locations.map(shortPath).join(", ")}</small>}
        </li>;
      })}
    </ul>
  );
}

function PlanCard({ plan }: { plan: PlanEntry[] }) {
  const done = plan.filter((entry) => entry.status === "completed").length;
  return (
    <details className="conversation-plan" open>
      <summary><ListChecks size={15} aria-hidden="true" /> Plano do agente <small>{done} de {plan.length}</small></summary>
      <ol>
        {plan.map((entry, index) => <li key={index}>
          <span>{entry.content}</span> <small className={`tool-status ${entry.status}`}>{planStatusCopy[entry.status] ?? entry.status}</small>
        </li>)}
      </ol>
    </details>
  );
}
