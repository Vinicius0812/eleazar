#!/usr/bin/env node

import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { createEleazar } from "./create-eleazar.js";
import { providerNames, type ProviderName } from "./core/contracts.js";

const parsed = parseArgs({
  allowPositionals: true,
  options: {
    cwd: { type: "string", short: "C" },
    json: { type: "boolean", default: false },
    model: { type: "string", short: "m" },
    prompt: { type: "string", short: "p" },
    provider: { type: "string", short: "P", default: "auto" },
    session: { type: "string", short: "s" }
  }
});

const [command = "help", ...positionals] = parsed.positionals;
const eleazar = createEleazar();

try {
  switch (command) {
    case "doctor":
      await doctor();
      break;
    case "plan":
      await plan();
      break;
    case "run":
      await run();
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      throw new Error(`Comando desconhecido: ${command}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function doctor(): Promise<void> {
  const decision = await eleazar.router.route({ prompt: "diagnostico" });
  const health = decision.candidates.map((candidate) => candidate.health);

  if (parsed.values.json) {
    console.log(JSON.stringify(health, null, 2));
    return;
  }

  console.log("Eleazar doctor\n");
  for (const item of health) {
    const status = item.available && item.authenticated !== false ? "OK" : "ATENCAO";
    console.log(`[${status}] ${item.provider}${item.version ? ` (${item.version})` : ""}`);
    console.log(`  ${item.detail}`);
  }
}

async function plan(): Promise<void> {
  const prompt = readPrompt(positionals);
  const preferredProvider = readProvider(parsed.values.provider);
  const decision = await eleazar.router.route({
    prompt,
    ...(preferredProvider ? { preferredProvider } : {})
  });

  if (parsed.values.json) {
    console.log(JSON.stringify(decision, null, 2));
    return;
  }

  console.log(`Tipo de tarefa: ${decision.taskKind}`);
  console.log(`Provedor selecionado: ${decision.selected ?? "nenhum"}\n`);
  for (const candidate of decision.candidates) {
    console.log(`- ${candidate.provider}: ${candidate.score}`);
    for (const reason of candidate.reasons) {
      console.log(`  ${reason}`);
    }
  }
}

async function run(): Promise<void> {
  const prompt = readPrompt(positionals);
  const preferredProvider = readProvider(parsed.values.provider);
  const cwd = resolve(parsed.values.cwd ?? process.cwd());
  const execution = await eleazar.run(
    {
      prompt,
      cwd,
      ...(parsed.values.model ? { model: parsed.values.model } : {}),
      ...(parsed.values.session ? { sessionId: parsed.values.session } : {})
    },
    preferredProvider
  );

  if (parsed.values.json) {
    console.log(JSON.stringify(execution, null, 2));
    return;
  }

  console.log(`Eleazar delegou para ${execution.result.provider}.\n`);
  if (execution.result.status === "success") {
    console.log(execution.result.response);
    if (execution.result.sessionId) {
      console.log(`\nSessao: ${execution.result.sessionId}`);
    }
    return;
  }

  throw new Error(execution.result.error ?? "A execucao falhou sem mensagem de erro.");
}

function readPrompt(positionals: readonly string[]): string {
  const prompt = parsed.values.prompt ?? positionals.join(" ").trim();
  if (!prompt) {
    throw new Error("Informe a tarefa com --prompt ou como argumento posicional.");
  }
  return prompt;
}

function readProvider(value: string | undefined): ProviderName | undefined {
  if (!value || value === "auto") {
    return undefined;
  }
  if (providerNames.includes(value as ProviderName)) {
    return value as ProviderName;
  }
  throw new Error(`Provedor invalido: ${value}. Use auto, codex ou antigravity.`);
}

function printHelp(): void {
  console.log(`Eleazar - orquestrador local-first de agentes\n
Uso:
  eleazar doctor [--json]
  eleazar plan <tarefa> [--provider auto|codex|antigravity]
  eleazar run <tarefa> [--provider auto|codex|antigravity] [--cwd <pasta>]

Opcoes:
  -p, --prompt      Texto da tarefa
  -P, --provider    Provedor preferido (padrao: auto)
  -m, --model       Modelo especifico do provedor
  -s, --session     ID de sessao a retomar
  -C, --cwd         Diretorio de trabalho
      --json        Saida JSON
`);
}
