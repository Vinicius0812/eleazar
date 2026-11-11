import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runProcess } from "../src/adapters/process-runner.js";
import { openCrossReviewCheckout } from "../src/cross-review-git.js";

const tracked = "src/[alvo].ts";
const unrelated = "src/alvo.ts";
const fixtures: { root: string; directory: string }[] = [];

afterEach(async () => {
  for (const { root, directory } of fixtures.splice(0)) {
    if (dirname(directory) === root) await rm(directory, { recursive: true, force: true });
  }
});

async function git(directory: string, ...args: string[]) {
  const result = await runProcess("git", args, { cwd: directory, timeoutMs: 5_000 });
  if (result.exitCode !== 0 || result.timedOut) throw new Error(result.stderr || "Falha no Git do teste.");
  return result.stdout;
}

async function fixture() {
  const root = await realpath(tmpdir());
  const directory = await mkdtemp(join(root, "eleazar-cross-review-test-"));
  fixtures.push({ root, directory });
  await git(directory, "init", "--quiet");
  await git(directory, "config", "--local", "core.autocrlf", "true");
  await mkdir(join(directory, "src"));
  await writeFile(join(directory, tracked), "export const version = 1;\r\nexport const fixed = true;\r\n");
  await writeFile(join(directory, unrelated), "const other = 1;\r\n");
  await writeFile(join(directory, ".gitattributes"), "*.ts filter=local-only\r\n");
  await git(directory, "add", "--", ".");
  await git(directory, "-c", "user.name=Teste", "-c", "user.email=teste@example.test", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Base");
  return directory;
}

describe("cross-review Git scope", () => {
  it("usa caminho literal, respeita CRLF e não atualiza o índice ao coletar o patch", async () => {
    const directory = await fixture();
    await git(directory, "config", "--local", "filter.local-only.clean", "false");
    await git(directory, "config", "--local", "filter.local-only.required", "true");
    const originalIndex = await readFile(join(directory, ".git", "index"));
    const checkout = await openCrossReviewCheckout(directory, [tracked]);
    expect(await checkout.collect()).toBe("");
    await writeFile(join(directory, tracked), "export const version = 2;\r\nexport const fixed = true;\r\n");
    const patch = await checkout.collect();
    expect(patch).toContain("diff --git a/src/[alvo].ts b/src/[alvo].ts");
    expect(patch).toContain("-export const version = 1;\n+export const version = 2;\n export const fixed = true;");
    expect(patch).not.toContain("src/alvo.ts");
    expect(await readFile(join(directory, ".git", "index"))).toEqual(originalIndex);
  }, 12_000);

  it("recusa checkout inicialmente sujo, caminho fora da raiz e mudança não autorizada", async () => {
    const directory = await fixture();
    await expect(openCrossReviewCheckout(join(directory, "src"), ["[alvo].ts"])).rejects.toThrow("raiz");
    await expect(openCrossReviewCheckout(directory, ["../escape"])).rejects.toThrow("caminhos relativos");
    await expect(openCrossReviewCheckout(directory, ["src/*.ts"])).rejects.toThrow("rastreado");
    const checkout = await openCrossReviewCheckout(directory, [tracked]);
    await writeFile(join(directory, unrelated), "const other = 2;\r\n");
    await expect(checkout.collect()).rejects.toThrow("fora do escopo");
    await expect(openCrossReviewCheckout(directory, [tracked, unrelated])).rejects.toThrow("inicialmente limpo");
  }, 12_000);

  it("recusa diff binário, grande, renomeado ou preparado no índice", async () => {
    const directory = await fixture();
    const checkout = await openCrossReviewCheckout(directory, [tracked]);
    const target = join(directory, tracked);
    await writeFile(target, Buffer.from([0, 1, 255]));
    await expect(checkout.collect()).rejects.toThrow("texto");
    await writeFile(target, "x".repeat(36 * 1024));
    await expect(checkout.collect()).rejects.toThrow("limite");
    await rename(target, join(directory, "src", "renomeado.ts"));
    await expect(checkout.collect()).rejects.toThrow("renomeacoes");
    await rename(join(directory, "src", "renomeado.ts"), target);
    await writeFile(target, "export const version = 3;\r\n");
    await git(directory, "add", "--", tracked);
    await expect(checkout.collect()).rejects.toThrow("indice");
  }, 12_000);
});
