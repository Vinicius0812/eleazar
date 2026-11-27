import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentRunRequest, ProviderName, RouteDecision } from "../src/core/contracts.js";
import { ControlRoomService } from "../src/core/control-room-service.js";
import { SkillCatalog } from "../src/core/skill-catalog.js";
import { discoverSkills, parseFrontmatter } from "../src/adapters/skill-importer.js";
import { createControlRoomServer } from "../src/control-room/local-api.js";
import { ControlRoomTaskExecutor, type ControlRoomTaskRunner } from "../src/control-room/task-executor.js";
import { TaskFileExplorer } from "../src/control-room/file-explorer.js";
import { SqliteControlRoomStore } from "../src/persistence/sqlite-control-room-store.js";
import { acpRegistry } from "./helpers.js";

const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function home() {
  const directory = await mkdtemp(join(tmpdir(), "eleazar-skills-")); temporaryDirectories.push(directory);
  const claude = join(directory, ".claude", "skills"); const codex = join(directory, ".codex", "skills");
  await mkdir(join(claude, "gerar-prompts"), { recursive: true });
  await writeFile(join(claude, "gerar-prompts", "SKILL.md"), "---\nname: gerar-prompts\ndescription: \"Gera prompts por repositorio\"\n---\n\n# Gerar prompts\nUse um prompt por repositorio.\n");
  await mkdir(join(codex, "relatorio", "scripts"), { recursive: true });
  await writeFile(join(codex, "relatorio", "SKILL.md"), "# Relatorio\nSem cabecalho.\n");
  await writeFile(join(codex, "relatorio", "scripts", "gerar.py"), "print(1)\n");
  await mkdir(join(codex, ".system", "interna"), { recursive: true });
  await writeFile(join(codex, ".system", "interna", "SKILL.md"), "interna\n");
  const store = new SqliteControlRoomStore(join(directory, "control-room.sqlite"));
  return { directory, claude, codex, store, roots: [{ source: "claude" as const, directory: claude }, { source: "codex" as const, directory: codex }] };
}

describe("Skills", () => {
  it("le o cabecalho do SKILL.md", () => {
    expect(parseFrontmatter("---\nname: a\ndescription: 'b c'\n---\ncorpo")).toEqual({ fields: { name: "a", description: "b c" }, body: "corpo" });
    expect(parseFrontmatter("sem cabecalho")).toEqual({ fields: {}, body: "sem cabecalho" });
  });

  it("importa as skills do Claude e do Codex sem as de sistema, e preserva a edicao local ao reimportar", async () => {
    const { codex, store, roots } = await home();
    try {
      const catalog = new SkillCatalog(store);
      const first = catalog.importSkills(await discoverSkills(roots));
      expect(first.added.map((skill) => [skill.name, skill.source, skill.description])).toEqual([["gerar-prompts", "claude", "Gera prompts por repositorio"], ["relatorio", "codex", ""]]);
      expect(first.added[1]!.supportFiles).toEqual(["scripts"]);
      expect(first.added[0]!.content).toBe("# Gerar prompts\nUse um prompt por repositorio.");
      // The identical copy kept in Codex is not imported twice.
      await mkdir(join(codex, "gerar-prompts"), { recursive: true });
      await writeFile(join(codex, "gerar-prompts", "SKILL.md"), "---\nname: gerar-prompts\n---\n# Gerar prompts\nUse um prompt por repositorio.\n");
      expect(catalog.importSkills(await discoverSkills(roots)).added).toEqual([]);

      expect(catalog.importSkills(await discoverSkills(roots))).toMatchObject({ added: [], updated: [], unchanged: 3 });
      const relatorio = first.added[1]!;
      catalog.updateSkill(relatorio.id, { name: "relatorio", content: "Minha versao." });
      await writeFile(join(codex, "relatorio", "SKILL.md"), "# Relatorio\nNova versao do Codex.\n");
      const again = catalog.importSkills(await discoverSkills(roots));
      expect(again.keptLocalEdits.map((skill) => skill.name)).toEqual(["relatorio"]);
      expect(store.getSkill(relatorio.id)?.content).toBe("Minha versao.");
    } finally { store.close(); }
  });

  it("entrega o perfil do agente e as skills a qualquer provedor, que vem do perfil quando o operador nao escolhe", async () => {
    const { store, roots } = await home();
    try {
      const service = new ControlRoomService(store, undefined, { useWorktrees: false });
      const catalog = new SkillCatalog(store);
      const [skill] = catalog.importSkills(await discoverSkills(roots)).added;
      const revisor = catalog.createAgent({ name: "Revisor", role: "Revisa codigo com rigor", instructions: "Aponte riscos antes de elogios.", skillIds: [skill!.id], provider: "claude" });
      const project = service.registerProject({ name: "Core", path: process.cwd() });
      const task = service.createTask({ projectId: project.id, title: "Revisar", prompt: "Revise o modulo", agentProfileId: revisor.id });
      expect(() => service.createTask({ projectId: project.id, title: "X", prompt: "Y", skillIds: ["nao-existe"] })).toThrow("Skill nao encontrada");

      const route = (provider: ProviderName): RouteDecision => ({ taskKind: "review", selected: provider, candidates: [{ provider, score: 1, reasons: [], health: { provider, available: true, authenticated: true, detail: "" } }] });
      const runner: ControlRoomTaskRunner = { router: { route: async (request) => route(request.preferredProvider ?? "codex") },
        run: vi.fn(async (_request: AgentRunRequest, provider?: ProviderName) => ({ route: route(provider ?? "codex"), result: { provider: provider ?? "codex", status: "success" as const, response: "ok", durationMs: 1 } })) };
      const executor = new ControlRoomTaskExecutor(service, runner, acpRegistry());
      await executor.start(task.id);
      await vi.waitFor(() => expect(store.getTask(task.id)?.status).toBe("completed"));
      const [request, provider] = vi.mocked(runner.run).mock.calls[0]!;
      expect(provider).toBe("claude");
      expect(request.prompt).toContain('Voce atua como o agente "Revisor"');
      expect(request.prompt).toContain("Aponte riscos antes de elogios.");
      expect(request.prompt).toContain("--- Skill: gerar-prompts · Gera prompts por repositorio ---");
      expect(request.prompt.indexOf("--- Fim das skills ---")).toBeLessThan(request.prompt.indexOf("Revise o modulo"));

      catalog.deleteSkill(skill!.id);
      expect(store.getAgentProfile(revisor.id)?.skillIds).toEqual([]);
      // A removed duplicate does not come back with the next import.
      expect(catalog.importSkills(await discoverSkills(roots)).added).toEqual([]);
      expect(catalog.listSkills().some((item) => item.id === skill!.id || item.sourcePath === skill!.sourcePath)).toBe(false);
    } finally { store.close(); }
  });

  it("serve skills e agentes pela API local, inclusive a importacao", async () => {
    const { store, roots } = await home();
    const service = new ControlRoomService(store);
    const server = createControlRoomServer(service, undefined, undefined, undefined, undefined, new TaskFileExplorer(service), undefined, () => roots);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("Endereco ausente");
      const api = `http://127.0.0.1:${address.port}/api/control-room`;
      const post = (path: string, body: object) => fetch(`${api}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const imported = await (await post("/skills/import", { sources: ["codex"] })).json() as { added: number; skills: Array<{ id: string; source: string }> };
      expect(imported.added).toBe(1);
      expect(imported.skills.map((skill) => skill.source)).toEqual(["codex"]);
      const own = await (await post("/skills", { name: "Commits curtos", content: "Mensagens de commit no imperativo." })).json() as { id: string; source: string };
      expect(own.source).toBe("eleazar");
      const agent = await post("/agents", { name: "Implementador", role: "Implementa", skillIds: [own.id], provider: "codex", model: "gpt-x" });
      expect(agent.status).toBe(201);
      const created = await agent.json() as { id: string };
      expect(await (await post(`/agents/${created.id}/update`, { name: "Implementador", provider: null })).json()).toMatchObject({ provider: null, model: null, skillIds: [] });
      expect((await post("/agents", { name: "X", provider: "!!" })).status).toBe(400);
      expect(await (await fetch(`${api}/agents`)).json()).toHaveLength(1);
      expect((await post(`/skills/${own.id}/delete`, {})).status).toBe(200);
      expect((await post(`/agents/${created.id}/delete`, {})).status).toBe(200);
      expect(await (await fetch(`${api}/agents`)).json()).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    }
  });
});
