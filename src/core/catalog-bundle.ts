import type { AgentProfile, Skill, SkillSource } from "./control-room.js";
import { skillSources } from "./control-room.js";
import { slugify, type SkillCatalog } from "./skill-catalog.js";
import { parseFrontmatter } from "./frontmatter.js";

/**
 * The catalog as files, the format used both to export and to import:
 *
 *   eleazar.json               { "format": "eleazar-catalog", "version": 1 }  (optional on import)
 *   skills/<nome>/SKILL.md     frontmatter name, description and origin, then the instructions
 *   agents/<nome>.json         { name, role, instructions, skills: [skill names], provider, model }
 *
 * On import any `SKILL.md` counts as a skill (its folder names it when the header has no name), so a
 * folder of Claude or Codex skills can be imported as it is.
 */
export interface BundleFile { path: string; text: string; }
export interface BundleSkill { name: string; description: string; content: string; origin: SkillSource; path: string; }
export interface BundleAgent { name: string; role: string; instructions: string; skills: string[]; provider: string | null; model: string | null; path: string; }
export interface ParsedBundle { skills: BundleSkill[]; agents: BundleAgent[]; ignored: string[]; warnings: string[]; }

export type ImportStatus = "new" | "same" | "conflict";
export type ConflictChoice = "skip" | "replace" | "duplicate";
export interface ImportPreview {
  skills: Array<{ name: string; origin: SkillSource; status: ImportStatus; path: string }>;
  agents: Array<{ name: string; status: ImportStatus; path: string; missingSkills: string[] }>;
  ignored: string[];
  warnings: string[];
}
export interface ImportOutcome { skills: { added: string[]; replaced: string[]; skipped: string[] }; agents: { added: string[]; replaced: string[]; skipped: string[] }; warnings: string[]; }

export const bundleFormat = { format: "eleazar-catalog", version: 1 } as const;

export function exportBundle(skills: readonly Skill[], agents: readonly AgentProfile[]): BundleFile[] {
  const files: BundleFile[] = [{ path: "eleazar.json", text: `${JSON.stringify({ ...bundleFormat, exportedAt: new Date().toISOString(), skills: skills.length, agents: agents.length }, null, 2)}\n` }];
  const folders = uniqueNames(skills.map((skill) => slugify(skill.name)));
  skills.forEach((skill, index) => {
    const header = ["---", `name: ${yamlValue(skill.name)}`, `description: ${yamlValue(skill.description)}`, `origin: ${skill.source}`, "---", ""].join("\n");
    files.push({ path: `skills/${folders[index]}/SKILL.md`, text: `${header}\n${skill.content.trim()}\n` });
  });
  const agentFiles = uniqueNames(agents.map((agent) => slugify(agent.name)));
  agents.forEach((agent, index) => {
    const body = { name: agent.name, role: agent.role, instructions: agent.instructions,
      skills: agent.skillIds.map((id) => skills.find((skill) => skill.id === id)?.name).filter((name): name is string => Boolean(name)),
      provider: agent.provider, model: agent.model };
    files.push({ path: `agents/${agentFiles[index]}.json`, text: `${JSON.stringify(body, null, 2)}\n` });
  });
  return files;
}

export function parseBundle(files: readonly BundleFile[]): ParsedBundle {
  const parsed: ParsedBundle = { skills: [], agents: [], ignored: [], warnings: [] };
  for (const file of files) {
    const path = file.path.replaceAll("\\", "/").replace(/^\/+/, "");
    const parts = path.split("/");
    const name = parts.at(-1) ?? "";
    if (name.toLowerCase() === "skill.md") {
      const { fields, body } = parseFrontmatter(file.text);
      const folder = parts.at(-2);
      const skillName = (fields.name || folder || "").trim();
      if (!skillName || !body.trim()) { parsed.warnings.push(`${path}: sem nome ou sem conteudo; ignorado.`); continue; }
      const origin = (skillSources as readonly string[]).includes(fields.origin ?? "") ? fields.origin as SkillSource : "eleazar";
      parsed.skills.push({ name: skillName.slice(0, 120), description: (fields.description ?? "").slice(0, 1_000), content: body.trim(), origin, path });
      continue;
    }
    if (name.toLowerCase().endsWith(".json") && parts.includes("agents")) {
      try {
        const value = JSON.parse(file.text) as Record<string, unknown>;
        if (typeof value.name !== "string" || !value.name.trim()) throw new Error("sem nome");
        parsed.agents.push({ name: value.name.trim().slice(0, 80), role: typeof value.role === "string" ? value.role : "",
          instructions: typeof value.instructions === "string" ? value.instructions : "",
          skills: Array.isArray(value.skills) ? value.skills.filter((item): item is string => typeof item === "string") : [],
          provider: typeof value.provider === "string" && value.provider ? value.provider : null,
          model: typeof value.model === "string" && value.model ? value.model : null, path });
      } catch (error) {
        parsed.warnings.push(`${path}: agente invalido (${error instanceof Error ? error.message : "JSON invalido"}); ignorado.`);
      }
      continue;
    }
    if (name !== "eleazar.json") parsed.ignored.push(path);
  }
  return parsed;
}

/** What importing would do, without changing anything. Matching is by name, ignoring case. */
export function previewImport(catalog: SkillCatalog, bundle: ParsedBundle): ImportPreview {
  const skills = catalog.listSkills();
  const agents = catalog.listAgents();
  const known = new Set([...skills.map((skill) => key(skill.name)), ...bundle.skills.map((skill) => key(skill.name))]);
  return {
    skills: bundle.skills.map((item) => {
      const current = skills.find((skill) => key(skill.name) === key(item.name));
      return { name: item.name, origin: item.origin, path: item.path,
        status: !current ? "new" : current.content.trim() === item.content.trim() && current.description === item.description ? "same" : "conflict" };
    }),
    agents: bundle.agents.map((item) => {
      const current = agents.find((agent) => key(agent.name) === key(item.name));
      return { name: item.name, path: item.path, missingSkills: item.skills.filter((name) => !known.has(key(name))),
        status: !current ? "new" : sameAgent(current, item, skills) ? "same" : "conflict" };
    }),
    ignored: bundle.ignored,
    warnings: bundle.warnings,
  };
}

/**
 * Applies the bundle. New items are added, identical ones left alone, and items that exist with
 * different content follow `choice`: keep the current one, replace it, or keep both (the imported
 * copy gets " (importada)" in its name).
 */
export function applyImport(catalog: SkillCatalog, bundle: ParsedBundle, choice: ConflictChoice): ImportOutcome {
  const outcome: ImportOutcome = { skills: { added: [], replaced: [], skipped: [] }, agents: { added: [], replaced: [], skipped: [] }, warnings: [...bundle.warnings] };
  const preview = previewImport(catalog, bundle);
  bundle.skills.forEach((item, index) => {
    const status = preview.skills[index]!.status;
    const current = catalog.listSkills().find((skill) => key(skill.name) === key(item.name));
    const input = { name: item.name, description: item.description, content: item.content };
    if (status === "same" || (status === "conflict" && choice === "skip")) { outcome.skills.skipped.push(item.name); return; }
    if (status === "conflict" && choice === "replace" && current) { catalog.updateSkill(current.id, input); outcome.skills.replaced.push(item.name); return; }
    const name = status === "conflict" ? uniqueImportedName(item.name, catalog.listSkills().map((skill) => skill.name)) : item.name;
    catalog.createSkill({ ...input, name }, item.origin);
    outcome.skills.added.push(name);
  });
  const skills = catalog.listSkills();
  bundle.agents.forEach((item, index) => {
    const status = preview.agents[index]!.status;
    const skillIds = item.skills.map((name) => skills.find((skill) => key(skill.name) === key(name))?.id).filter((id): id is string => Boolean(id));
    const missing = item.skills.filter((name) => !skills.some((skill) => key(skill.name) === key(name)));
    if (missing.length) outcome.warnings.push(`${item.name}: skills nao encontradas (${missing.join(", ")}); o agente entrou sem elas.`);
    const input = { name: item.name, role: item.role, instructions: item.instructions, skillIds, provider: item.provider, model: item.model };
    const current = catalog.listAgents().find((agent) => key(agent.name) === key(item.name));
    if (status === "same" || (status === "conflict" && choice === "skip")) { outcome.agents.skipped.push(item.name); return; }
    try {
      if (status === "conflict" && choice === "replace" && current) { catalog.updateAgent(current.id, input); outcome.agents.replaced.push(item.name); return; }
      const name = status === "conflict" ? uniqueImportedName(item.name, catalog.listAgents().map((agent) => agent.name)).slice(0, 80) : item.name;
      catalog.createAgent({ ...input, name });
      outcome.agents.added.push(name);
    } catch (error) {
      outcome.warnings.push(`${item.name}: ${error instanceof Error ? error.message : "agente invalido"}`);
    }
  });
  return outcome;
}

function key(name: string): string { return name.trim().toLocaleLowerCase(); }

function sameAgent(current: AgentProfile, item: BundleAgent, skills: readonly Skill[]): boolean {
  const names = current.skillIds.map((id) => skills.find((skill) => skill.id === id)?.name ?? "").map(key).sort();
  return current.role === item.role && current.instructions === item.instructions && current.provider === item.provider && current.model === item.model
    && names.join("\0") === item.skills.map(key).sort().join("\0");
}

function uniqueImportedName(name: string, taken: readonly string[]): string {
  const used = new Set(taken.map(key));
  for (let index = 1; ; index += 1) {
    const candidate = index === 1 ? `${name} (importada)` : `${name} (importada ${index})`;
    if (!used.has(key(candidate))) return candidate;
  }
}

function uniqueNames(names: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => { const count = (seen.get(name) ?? 0) + 1; seen.set(name, count); return count === 1 ? name : `${name}-${count}`; });
}

function yamlValue(value: string): string {
  const single = value.replace(/\r?\n/g, " ").trim();
  return /^[\w .,()À-ÿ/-]*$/.test(single) && !single.startsWith("-") ? single : JSON.stringify(single);
}
