import { createHash, randomUUID } from "node:crypto";

import type { AgentProfile, ControlRoomStore, ControlRoomTask, Skill, SkillSource } from "./control-room.js";
import { isProviderName } from "./contracts.js";

/** A SKILL.md read from another tool's folder, before it becomes an Eleazar skill. */
export interface SkillCandidate {
  source: Exclude<SkillSource, "eleazar">;
  slug: string;
  name: string;
  description: string;
  content: string;
  sourcePath: string;
  supportFiles: string[];
}

export interface SkillImportResult { added: Skill[]; updated: Skill[]; unchanged: number; keptLocalEdits: Skill[]; }

export interface SkillInput { name: string; description?: string; content: string; }
export interface AgentProfileInput { name: string; role?: string; instructions?: string; skillIds?: readonly string[]; provider?: string | null; model?: string | null; }

/** Caps keep the prompt reasonable: an agent gets the skill's guidance, not a book. */
const maxSkillChars = 60_000;
const maxBriefingChars = 120_000;

export function contentHash(content: string): string { return createHash("sha256").update(content).digest("hex"); }

/**
 * Skills and agent profiles of the Eleazar. Both travel in the prompt, so they work the same with
 * every provider: nothing depends on Claude's or Codex's own skill mechanisms.
 */
export class SkillCatalog {
  constructor(private readonly store: ControlRoomStore) {}

  listSkills(): Skill[] { return this.store.listSkills(); }
  listAgents(): AgentProfile[] { return this.store.listAgentProfiles(); }

  createSkill(input: SkillInput): Skill {
    const now = new Date().toISOString();
    const skill: Skill = { id: randomUUID(), slug: slugify(input.name), ...validSkill(input), source: "eleazar", sourcePath: null, supportFiles: [], importedHash: null, createdAt: now, updatedAt: now };
    this.store.saveSkill(skill);
    return skill;
  }

  updateSkill(id: string, input: SkillInput): Skill {
    const current = this.requireSkill(id);
    const skill: Skill = { ...current, ...validSkill(input), updatedAt: new Date().toISOString() };
    this.store.saveSkill(skill);
    return skill;
  }

  /** Removes the Eleazar's copy and its links from agents; the original file is never touched. */
  deleteSkill(id: string): void {
    this.requireSkill(id);
    for (const profile of this.store.listAgentProfiles().filter((item) => item.skillIds.includes(id))) {
      this.store.saveAgentProfile({ ...profile, skillIds: profile.skillIds.filter((skillId) => skillId !== id), updatedAt: new Date().toISOString() });
    }
    this.store.deleteSkill(id);
  }

  /**
   * Adds skills found in other tools and refreshes the ones imported before, except when their copy
   * was edited here (its content no longer matches what was imported): the operator's edit wins.
   */
  importSkills(candidates: readonly SkillCandidate[]): SkillImportResult {
    const existing = this.store.listSkills();
    const result: SkillImportResult = { added: [], updated: [], unchanged: 0, keptLocalEdits: [] };
    const now = new Date().toISOString();
    for (const candidate of candidates) {
      const content = candidate.content.slice(0, maxSkillChars);
      const hash = contentHash(content);
      const previous = existing.find((skill) => skill.sourcePath === candidate.sourcePath);
      if (!previous) {
        const skill: Skill = { id: randomUUID(), slug: candidate.slug, name: candidate.name.slice(0, 120), description: candidate.description.slice(0, 1_000), content,
          source: candidate.source, sourcePath: candidate.sourcePath, supportFiles: candidate.supportFiles.slice(0, 50), importedHash: hash, createdAt: now, updatedAt: now };
        this.store.saveSkill(skill); result.added.push(skill); continue;
      }
      if (previous.importedHash === hash) { result.unchanged += 1; continue; }
      if (previous.importedHash !== contentHash(previous.content)) { result.keptLocalEdits.push(previous); continue; }
      const skill: Skill = { ...previous, name: candidate.name.slice(0, 120), description: candidate.description.slice(0, 1_000), content,
        supportFiles: candidate.supportFiles.slice(0, 50), importedHash: hash, updatedAt: now };
      this.store.saveSkill(skill); result.updated.push(skill);
    }
    return result;
  }

  createAgent(input: AgentProfileInput): AgentProfile {
    const now = new Date().toISOString();
    const profile: AgentProfile = { id: randomUUID(), ...this.validAgent(input), createdAt: now, updatedAt: now };
    this.store.saveAgentProfile(profile);
    return profile;
  }

  updateAgent(id: string, input: AgentProfileInput): AgentProfile {
    const current = this.store.getAgentProfile(id);
    if (!current) throw notFound("Agente nao encontrado.");
    const profile: AgentProfile = { ...current, ...this.validAgent(input), updatedAt: new Date().toISOString() };
    this.store.saveAgentProfile(profile);
    return profile;
  }

  deleteAgent(id: string): void {
    if (!this.store.deleteAgentProfile(id)) throw notFound("Agente nao encontrado.");
  }

  /** The agent profile of a task, if it has one still registered. */
  agentFor(task: ControlRoomTask): AgentProfile | null {
    return task.agentProfileId ? this.store.getAgentProfile(task.agentProfileId) : null;
  }

  /**
   * Text placed before the request: who the agent is in this task and the skills it should follow.
   * Empty when the task has neither an agent profile nor skills.
   */
  briefing(task: ControlRoomTask): string {
    const profile = this.agentFor(task);
    const skillIds = [...new Set([...(profile?.skillIds ?? []), ...(task.skillIds ?? [])])];
    const skills = skillIds.map((id) => this.store.getSkill(id)).filter((skill): skill is Skill => Boolean(skill));
    if (!profile && !skills.length) return "";
    const parts: string[] = [];
    if (profile) {
      parts.push(`Voce atua como o agente "${profile.name}" do Eleazar.`);
      if (profile.role.trim()) parts.push(`Funcao: ${profile.role.trim()}`);
      if (profile.instructions.trim()) parts.push("Instrucoes permanentes deste agente:", profile.instructions.trim());
    }
    if (skills.length) {
      parts.push("", "Skills que voce deve seguir nesta tarefa (formato SKILL.md; aplique as que forem pertinentes ao pedido):");
      let used = parts.join("\n").length;
      for (const skill of skills) {
        const files = skill.supportFiles.length && skill.sourcePath ? `\n(Arquivos de apoio desta skill, ao lado de ${skill.sourcePath}: ${skill.supportFiles.join(", ")}. Leia-os apenas se tiver acesso a essa pasta.)` : "";
        const block = `\n--- Skill: ${skill.name}${skill.description ? ` · ${skill.description}` : ""} ---\n${skill.content.trim()}${files}`;
        if (used + block.length > maxBriefingChars) { parts.push(`\n(Skills omitidas por tamanho: ${skills.slice(skills.indexOf(skill)).map((item) => item.name).join(", ")}.)`); break; }
        parts.push(block); used += block.length;
      }
      parts.push("--- Fim das skills ---");
    }
    return parts.join("\n");
  }

  private requireSkill(id: string): Skill {
    const skill = this.store.getSkill(id);
    if (!skill) throw notFound("Skill nao encontrada.");
    return skill;
  }

  private validAgent(input: AgentProfileInput): Omit<AgentProfile, "id" | "createdAt" | "updatedAt"> {
    const name = input.name.trim();
    if (!name || name.length > 80) throw new Error("Informe um nome de ate 80 caracteres para o agente.");
    if ((input.instructions ?? "").length > 20_000) throw new Error("As instrucoes do agente passam de 20000 caracteres.");
    const skillIds = [...new Set(input.skillIds ?? [])];
    if (skillIds.some((id) => !this.store.getSkill(id))) throw new Error("Skill nao encontrada.");
    const provider = input.provider?.trim() || null;
    if (provider && !isProviderName(provider)) throw new Error("Provedor invalido.");
    return { name, role: (input.role ?? "").trim().slice(0, 200), instructions: (input.instructions ?? "").trim(), skillIds, provider, model: provider ? input.model?.trim() || null : null };
  }
}

function validSkill(input: SkillInput): Pick<Skill, "name" | "description" | "content"> {
  const name = input.name.trim();
  if (!name || name.length > 120) throw new Error("Informe um nome de ate 120 caracteres para a skill.");
  if (!input.content.trim()) throw new Error("A skill precisa de conteudo.");
  if (input.content.length > maxSkillChars) throw new Error(`A skill passa de ${maxSkillChars} caracteres.`);
  return { name, description: (input.description ?? "").trim().slice(0, 1_000), content: input.content.trim() };
}

export function slugify(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "skill";
}

function notFound(message: string): Error { return Object.assign(new Error(message), { statusCode: 404 }); }
