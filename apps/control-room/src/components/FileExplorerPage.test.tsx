import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ControlRoomClient, ExplorerRoot } from "../services/contracts.js";
import { FileExplorerPage, fileExplorerHash, fileExplorerRoute, parseDiff } from "./FileExplorerPage.js";

afterEach(() => { cleanup(); window.location.hash = ""; });

const worktree: ExplorerRoot = { directoryId: "d1", name: "App", path: "C:\\eleazar\\.eleazar\\worktrees\\t1\\app", mode: "worktree", branch: "eleazar/tarefa-1", isGitRepository: true, base: "abc123" };
const plain: ExplorerRoot = { directoryId: "d2", name: "Docs", path: "C:\\docs", mode: "direct", branch: null, isGitRepository: false, base: null };

function fakeClient(): ControlRoomClient {
  return {
    getTaskFileRoots: vi.fn(async () => [worktree, plain]),
    getTaskChanges: vi.fn(async (_task: string, directoryId: string) => directoryId === "d1"
      ? { root: worktree, changes: [{ path: "src/novo.ts", previousPath: null, kind: "untracked" as const, additions: null, deletions: null }], warnings: [] }
      : { root: plain, changes: [], warnings: ["Docs nao e um repositorio Git; o explorador mostra os arquivos, mas nao ha diff para comparar."] }),
    listTaskFiles: vi.fn(async (_task: string, directoryId: string, path = "") => path === ""
      ? { root: directoryId === "d1" ? worktree : plain, path, truncated: false, entries: [
        { name: "src", path: "src", type: "directory" as const, size: null, change: null, changedBelow: 1 },
        { name: "leia.md", path: "leia.md", type: "file" as const, size: 3, change: null, changedBelow: 0 }] }
      : { root: worktree, path, truncated: false, entries: [{ name: "novo.ts", path: "src/novo.ts", type: "file" as const, size: 10, change: "untracked" as const, changedBelow: 0 }] }),
    searchTaskFiles: vi.fn(async (_task: string, _directory: string, query: string) => ({ root: worktree, query, paths: ["src/profundo/alvo.ts"], truncated: false })),
    getTaskFile: vi.fn(async (_task: string, _directory: string, path: string) => ({ root: worktree, path, exists: true, size: 3, binary: false, content: "oi\n", tooLarge: false, change: null, diff: null, diffTruncated: false }))
  } as unknown as ControlRoomClient;
}

describe("FileExplorerPage", () => {
  it("navega pela arvore completa, abre o conteudo e troca de diretorio", async () => {
    const client = fakeClient();
    const user = userEvent.setup();
    render(<FileExplorerPage client={client} task={undefined} project={undefined} initial={{ taskId: "t1" }} onBack={() => undefined} />);
    expect(await screen.findByRole("button", { name: /novo\.ts/ })).toBeInTheDocument();
    expect(screen.getByText(/worktree da branch/)).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Todos os arquivos" }));
    const tree = screen.getByRole("tree");
    await user.click(within(tree).getByRole("button", { name: /src/ }));
    expect(await within(tree).findByRole("button", { name: /novo\.ts/ })).toBeInTheDocument();
    expect(client.listTaskFiles).toHaveBeenCalledWith("t1", "d1", "src");

    await user.click(within(tree).getByRole("button", { name: /leia\.md/ }));
    expect(await screen.findByRole("region", { name: "Conteúdo do arquivo" })).toHaveTextContent("oi");
    expect(screen.getByRole("button", { name: /Diff/ })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Docs" }));
    expect(await screen.findByText(/nao e um repositorio Git/)).toBeInTheDocument();
    expect(client.getTaskChanges).toHaveBeenLastCalledWith("t1", "d2");
  });

  it("busca um arquivo no projeto inteiro e abre o resultado", async () => {
    const client = fakeClient();
    const user = userEvent.setup();
    render(<FileExplorerPage client={client} task={undefined} project={undefined} initial={{ taskId: "t1" }} onBack={() => undefined} />);
    await user.click(await screen.findByRole("tab", { name: "Todos os arquivos" }));
    await user.type(screen.getByRole("searchbox", { name: "Buscar arquivo no projeto" }), "alvo");
    const results = await screen.findByRole("list", { name: "Resultados da busca" });
    await user.click(await within(results).findByRole("button", { name: /alvo\.ts/ }));
    expect(client.searchTaskFiles).toHaveBeenLastCalledWith("t1", "d1", "alvo");
    expect(client.getTaskFile).toHaveBeenLastCalledWith("t1", "d1", "src/profundo/alvo.ts");
  });

  it("le e escreve a rota do explorador", () => {
    expect(fileExplorerRoute("#/tasks/t%201/files?directory=d1&path=src%2Fa.ts")).toEqual({ taskId: "t 1", directoryId: "d1", path: "src/a.ts" });
    expect(fileExplorerRoute("#/tasks/t1")).toBeNull();
    expect(fileExplorerHash("t 1", { directoryId: "d1", path: "src/a.ts" })).toBe("#/tasks/t%201/files?directory=d1&path=src%2Fa.ts");
  });

  it("numera as linhas antigas e novas do diff", () => {
    const rows = parseDiff("diff --git a/a b/a\nindex 1..2\n--- a/a\n+++ b/a\n@@ -2,3 +2,3 @@ titulo\n linha\n-velha\n+nova\n\\ No newline at end of file\n");
    expect(rows.map((row) => [row.kind, row.oldNumber, row.newNumber, row.text])).toEqual([
      ["hunk", null, null, "@@ -2,3 +2,3 @@ titulo"], ["context", 2, 2, "linha"], ["del", 3, null, "velha"], ["add", null, 3, "nova"], ["meta", null, null, "\\ No newline at end of file"]
    ]);
  });
});
