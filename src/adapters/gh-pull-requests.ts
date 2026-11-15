import type { PullRequestInspector, PullRequestState } from "../core/control-room.js";
import { withoutCredentials, type CommandRunner } from "./git-publisher.js";
import { runProcess } from "./process-runner.js";

const fields = "number,url,title,state,isDraft,reviewDecision,mergeable,statusCheckRollup";
const maxFailingNames = 5;

/** Reads pull requests through the user's authenticated GitHub CLI. It never writes to GitHub. */
export class GhPullRequestInspector implements PullRequestInspector {
  constructor(private readonly run: CommandRunner = runGh) {}

  async find(path: string, branch: string): Promise<PullRequestState | null> {
    let result: Awaited<ReturnType<CommandRunner>>;
    try { result = await this.run("gh", ["pr", "view", branch, "--json", fields], path, 30_000); }
    catch { throw new Error("GitHub CLI (gh) nao encontrado. Instale e autentique o gh para acompanhar pull requests."); }
    if (result.timedOut) throw new Error("A consulta ao GitHub excedeu o tempo limite.");
    if (result.exitCode !== 0) {
      if (/no pull requests? found/i.test(result.stderr)) return null;
      throw new Error(`Nao foi possivel consultar o pull request: ${withoutCredentials(result.stderr.trim().slice(-300)) || `codigo ${result.exitCode}`}`);
    }
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(result.stdout) as Record<string, unknown>; }
    catch { throw new Error("O GitHub CLI retornou uma resposta que nao e JSON."); }
    return parsePullRequest(raw);
  }
}

const runGh: CommandRunner = (command, args, cwd, timeoutMs) =>
  runProcess(command, args, { cwd, timeoutMs, maxOutputBytes: 2_000_000, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } });

export function parsePullRequest(raw: Record<string, unknown>): PullRequestState {
  const state = String(raw.state ?? "").toLowerCase();
  const review = String(raw.reviewDecision ?? "").toLowerCase();
  const mergeable = String(raw.mergeable ?? "").toLowerCase();
  const checks = { total: 0, passed: 0, failed: 0, pending: 0, failing: [] as string[] };
  for (const item of Array.isArray(raw.statusCheckRollup) ? raw.statusCheckRollup as Array<Record<string, unknown>> : []) {
    // Check runs report status + conclusion; commit statuses report a single state.
    const done = item.status === undefined || String(item.status).toUpperCase() === "COMPLETED";
    const outcome = String(item.conclusion ?? item.state ?? "").toUpperCase();
    checks.total += 1;
    if (!done || outcome === "" || outcome === "PENDING" || outcome === "EXPECTED" || outcome === "QUEUED" || outcome === "IN_PROGRESS") checks.pending += 1;
    else if (outcome === "SUCCESS" || outcome === "NEUTRAL" || outcome === "SKIPPED") checks.passed += 1;
    else {
      checks.failed += 1;
      if (checks.failing.length < maxFailingNames) checks.failing.push(String(item.name ?? item.context ?? "check").slice(0, 120));
    }
  }
  return {
    number: Number(raw.number),
    url: withoutCredentials(String(raw.url ?? "")),
    title: String(raw.title ?? ""),
    state: state === "merged" ? "merged" : state === "closed" ? "closed" : "open",
    isDraft: raw.isDraft === true,
    reviewDecision: review === "approved" || review === "changes_requested" || review === "review_required" ? review : null,
    mergeable: mergeable === "mergeable" || mergeable === "conflicting" ? mergeable : "unknown",
    checks
  };
}
