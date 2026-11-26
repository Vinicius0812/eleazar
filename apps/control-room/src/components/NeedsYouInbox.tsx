import { AlertTriangle, ArrowRight, Check, GitPullRequest, Send, ShieldCheck, ShieldQuestion } from "lucide-react";

import { relativeTime } from "../services/board.js";
import type { InboxItem, InboxReason } from "../services/inbox.js";

const reasonCopy: Record<InboxReason, { label: string; icon: typeof Send }> = {
  permission: { label: "Permissão do agente", icon: ShieldQuestion },
  publication: { label: "Publicação", icon: Send },
  scope: { label: "Escopo", icon: ShieldCheck },
  failure: { label: "Falha", icon: AlertTriangle },
  pull_request: { label: "Pull request", icon: GitPullRequest },
};

/** One list of every decision waiting on the operator, each with a link to where it is taken. */
export function NeedsYouInbox({ items, projectName, limit }: {
  items: InboxItem[];
  projectName(projectId: string): string;
  /** Shows only the first items, as on the overview. */
  limit?: number;
}) {
  const visible = limit === undefined ? items : items.slice(0, limit);
  if (!items.length) {
    return (
      <div className="empty success-empty">
        <Check size={24} aria-hidden="true" />
        <strong>Nada depende de você agora</strong>
        <span>Permissões, publicações, escopos e falhas aparecem aqui assim que surgirem.</span>
      </div>
    );
  }
  return (
    <ul className="inbox-list" aria-label="Itens que precisam de você">
      {visible.map((item) => {
        const reason = reasonCopy[item.reason];
        return (
          <li key={`${item.task.id}-${item.reason}`} className={`inbox-item reason-${item.reason}`}>
            <span className="inbox-reason"><reason.icon size={14} aria-hidden="true" /> {reason.label}</span>
            <span className="inbox-copy">
              <strong>{item.task.title}</strong>
              <small>{projectName(item.task.projectId)} · {item.fact}</small>
            </span>
            <time dateTime={item.at} title={new Date(item.at).toLocaleString("pt-BR")}>{relativeTime(item.at)}</time>
            <a className="text-button" href={item.href} aria-label={`${item.action}: ${item.task.title}`}>{item.action} <ArrowRight size={14} aria-hidden="true" /></a>
          </li>
        );
      })}
    </ul>
  );
}
