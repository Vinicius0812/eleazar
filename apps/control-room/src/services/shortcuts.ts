export type ShortcutAction =
  | "help" | "palette" | "new-task"
  | "go-overview" | "go-inbox" | "go-tasks" | "go-executions" | "go-projects" | "go-providers"
  | "tab-conversation" | "tab-files" | "tab-publish";

/** Documented in the help dialog, in the order shown there. */
export const shortcutList: ReadonlyArray<{ keys: string[]; label: string }> = [
  { keys: ["Ctrl", "K"], label: "Buscar tarefas, projetos e telas" },
  { keys: ["/"], label: "Buscar (o mesmo que Ctrl K)" },
  { keys: ["N"], label: "Nova tarefa" },
  { keys: ["G", "I"], label: "Ir para Precisa de você" },
  { keys: ["G", "O"], label: "Ir para a visão geral" },
  { keys: ["G", "T"], label: "Ir para a fila de tarefas" },
  { keys: ["G", "E"], label: "Ir para execuções" },
  { keys: ["G", "P"], label: "Ir para projetos" },
  { keys: ["G", "V"], label: "Ir para provedores" },
  { keys: ["1"], label: "Na tarefa: aba Conversa" },
  { keys: ["2"], label: "Na tarefa: aba Arquivos" },
  { keys: ["3"], label: "Na tarefa: aba Publicação" },
  { keys: ["Ctrl", "Enter"], label: "No editor: enviar ou criar" },
  { keys: ["?"], label: "Mostrar estes atalhos" },
];

const afterG: Readonly<Record<string, ShortcutAction>> = {
  i: "go-inbox", o: "go-overview", t: "go-tasks", e: "go-executions", p: "go-projects", v: "go-providers",
};
const single: Readonly<Record<string, ShortcutAction>> = {
  "?": "help", "/": "palette", n: "new-task", "1": "tab-conversation", "2": "tab-files", "3": "tab-publish",
};

export interface ShortcutKey { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; target: EventTarget | null; }

/**
 * Single keys only act outside text fields and without Ctrl, Alt or Meta, so they never steal
 * what the operator types. `G` starts a two-key sequence; `pending` carries it to the next key.
 */
export function resolveShortcut(event: ShortcutKey, pending: boolean): { action: ShortcutAction | null; pending: boolean } {
  if (event.ctrlKey || event.metaKey || event.altKey || isEditable(event.target)) return { action: null, pending: false };
  const key = event.key.length === 1 ? event.key.toLocaleLowerCase() : event.key;
  if (pending) return { action: afterG[key] ?? null, pending: false };
  if (key === "g") return { action: null, pending: true };
  return { action: single[key] ?? null, pending: false };
}

function isEditable(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== "function") return false;
  const element = target as HTMLElement;
  if (element.isContentEditable) return true;
  return Boolean(element.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='combobox']"));
}
