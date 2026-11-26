import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { CornerDownLeft, Search } from "lucide-react";

export type CommandItem = {
  id: string;
  group: string;
  label: string;
  hint?: string | undefined;
  keywords?: string | undefined;
  icon?: ComponentType<{ size?: number; "aria-hidden"?: boolean | "true" }> | undefined;
  run(): void;
};

/** Accent- and case-insensitive text used to match what the operator types. */
export function normalizeSearch(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase("pt-BR").trim();
}

/** Every word of the query must appear in the label, hint or keywords; label matches rank first. */
export function filterCommands(items: CommandItem[], query: string, limit = 40): CommandItem[] {
  const words = normalizeSearch(query).split(/\s+/).filter(Boolean);
  if (!words.length) return items.slice(0, limit);
  return items
    .map((item, index) => {
      const label = normalizeSearch(item.label);
      const haystack = `${label} ${normalizeSearch(item.hint ?? "")} ${normalizeSearch(item.keywords ?? "")} ${normalizeSearch(item.group)}`;
      if (!words.every((word) => haystack.includes(word))) return null;
      const score = (label.startsWith(words[0]!) ? 0 : words.every((word) => label.includes(word)) ? 1 : 2);
      return { item, score, index };
    })
    .filter((entry): entry is { item: CommandItem; score: number; index: number } => entry !== null)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.item);
}

export function CommandPalette({ items, onClose }: { items: CommandItem[]; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const results = useMemo(() => filterCommands(items, query), [items, query]);
  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    input.current?.focus();
    return () => element?.close();
  }, []);
  useEffect(() => { setSelected(0); }, [query]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  function choose(item: CommandItem | undefined) {
    if (!item) return;
    onClose();
    item.run();
  }
  let lastGroup = "";
  return (
    <dialog
      ref={dialog}
      className="command-palette"
      aria-label="Ir para ou executar"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === dialog.current) onClose(); }}
    >
      <div className="command-search">
        <Search size={17} aria-hidden="true" />
        <input
          ref={input}
          role="combobox"
          aria-expanded="true"
          aria-controls="command-results"
          aria-activedescendant={results[selected] ? `command-${results[selected].id}` : undefined}
          aria-autocomplete="list"
          aria-label="Buscar tarefas, projetos e telas"
          placeholder="Buscar tarefas, projetos e telas…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") { event.preventDefault(); setSelected((value) => Math.min(value + 1, results.length - 1)); }
            else if (event.key === "ArrowUp") { event.preventDefault(); setSelected((value) => Math.max(value - 1, 0)); }
            else if (event.key === "Enter") { event.preventDefault(); choose(results[selected]); }
          }}
        />
        <kbd>Esc</kbd>
      </div>
      <div ref={list} id="command-results" role="listbox" aria-label="Resultados" className="command-results">
        {results.length === 0 && <p className="command-empty">Nada encontrado para “{query}”.</p>}
        {results.map((item, index) => {
          const header = item.group !== lastGroup ? item.group : "";
          lastGroup = item.group;
          const Icon = item.icon;
          return (
            <div key={item.id} role="presentation">
              {header && <div className="command-group" role="presentation">{header}</div>}
              <div
                id={`command-${item.id}`}
                data-index={index}
                role="option"
                aria-selected={index === selected}
                className={`command-item ${index === selected ? "selected" : ""}`}
                onMouseMove={() => setSelected(index)}
                onClick={() => choose(item)}
              >
                {Icon && <Icon size={16} aria-hidden="true" />}
                <span className="command-label">{item.label}</span>
                {item.hint && <span className="command-hint">{item.hint}</span>}
                {index === selected && <CornerDownLeft className="command-enter" size={14} aria-hidden="true" />}
              </div>
            </div>
          );
        })}
      </div>
      <footer className="command-footer"><span><kbd>↑</kbd><kbd>↓</kbd> navegar</span><span><kbd>Enter</kbd> abrir</span><span><kbd>Ctrl</kbd><kbd>K</kbd> abre de qualquer tela</span></footer>
    </dialog>
  );
}
