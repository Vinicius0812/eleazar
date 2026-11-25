#!/usr/bin/env node

import { resolve } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { parseArgs } from "node:util";

import { ClaudeAdapter } from "./adapters/claude.js";
import { CodexAdapter } from "./adapters/codex.js";
import { createLocalEleazar } from "./create-eleazar.js";
import type { ProviderName } from "./core/contracts.js";
import { escapeTerminal, runCrossReviewCommand, safeResultJson } from "./cross-review-cli.js";

const parsed = parseArgs({
  allowPositionals: true,
  options: {
    cwd: { type: "string", short: "C" },
    file: { type: "string", multiple: true },
    json: { type: "boolean", default: false },
    model: { type: "string", short: "m" },
    prompt: { type: "string", short: "p" },
    provider: { type: "string", short: "P", default: "auto" },
    session: { type: "string", short: "s" }
  }
});

const [command = "help", ...positionals] = parsed.positionals;
const eleazar = await createLocalEleazar(process.cwd(), (message) => console.error(message));
const providerNames = eleazar.registry.ids();

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
    case "cross-review":
      await crossReview();
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
  const health = await eleazar.health();

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
  if (preferredProvider === "claude" && parsed.values.session !== undefined) {
    throw new Error("Claude Code opera sem retomada de sessao.");
  }
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

async function crossReview(): Promise<void> {
  if (parsed.values.provider !== "auto" || parsed.values.session !== undefined || parsed.values.model !== undefined) {
    throw new Error("Revisao cruzada seleciona Codex e Claude em sessoes novas e nao aceita --provider, --session ou --model.");
  }
  let reader: Interface | undefined;
  let closed = false;
  try {
    const result = await runCrossReviewCommand({
      cwd: parsed.values.cwd ?? process.cwd(),
      prompt: parsed.values.prompt ?? positionals.join(" "),
      files: parsed.values.file ?? []
    }, {
      interactive: process.stdin.isTTY === true && process.stderr.isTTY === true,
      write: (text) => process.stderr.write(text),
      async confirm(question) {
        if (!reader) {
          reader = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
          reader.once("close", () => { closed = true; });
        }
        if (closed) return false;
        const controller = new AbortController();
        const abort = () => controller.abort();
        reader.once("close", abort);
        try {
          const answer = await reader.question(`${question} Digite SIM para aprovar: `, { signal: controller.signal });
          return answer.trim() === "SIM";
        } catch {
          return false;
        } finally {
          reader.removeListener("close", abort);
        }
      }
    }, { codex: new CodexAdapter("cross-review"), claude: new ClaudeAdapter(undefined, "cross-review") });
    if (parsed.values.json) console.log(safeResultJson(result));
    else {
      console.log(`Revisao cruzada: ${result.status} (${result.rounds.length} rodada(s) revisada(s)).`);
      for (const round of result.rounds) {
        console.log(`Rodada ${round.round}: ${round.verdict}`);
        for (const finding of round.findings) {
          console.log(`- ${escapeTerminal(finding.path)}:${finding.line} ${escapeTerminal(finding.message)}`);
        }
      }
      if (result.error) console.error(escapeTerminal(result.error));
    }
    if (result.status === "failed") process.exitCode = 1;
  } finally {
    reader?.close();
  }
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
  if (providerNames.includes(value)) return value;
  throw new Error(`Provedor invalido: ${value}. Use auto, ${providerNames.join(", ")}.`);
}

function printHelp(): void {
  console.log(`Eleazar - orquestrador local-first de agentes\n
Uso:
  eleazar doctor [--json]
  eleazar plan <tarefa> [--provider auto|${providerNames.join("|")}]
  eleazar run <tarefa> [--provider auto|${providerNames.join("|")}] [--cwd <pasta>]
  eleazar cross-review <tarefa> --cwd <raiz-git> --file <caminho-relativo> [--file <caminho-relativo>] [--json]

Opcoes:
  -p, --prompt      Texto da tarefa
  -P, --provider    Provedor preferido (padrao: auto, que escolhe so entre os ativos com autenticacao confirmada).
  -m, --model       Modelo especifico do provedor
  -s, --session     ID de sessao a retomar
  -C, --cwd         Diretorio de trabalho
      --file        Arquivo rastreado no escopo da revisao cruzada (repetivel)
      --json        Saida JSON
`);
}
