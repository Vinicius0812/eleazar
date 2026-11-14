import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Positive proof for tests: the fixture records, in its own cwd (a temp dir owned by the test), the outcome
// the client really sent for a permission request. Written atomically so a poller never reads half a file.
function writeReport(name, outcome) {
  const target = join(process.cwd(), name);
  writeFileSync(`${target}.tmp`, JSON.stringify({ outcome }));
  renameSync(`${target}.tmp`, target);
}
let ignoreCancel = false; // prompt "SLOW": keep running when the client cancels, so a late choice can still be observed
let buffer = "";
let permissionId = 100;
let pending;
const models = { id: "model", name: "Model", category: "model", type: "select", currentValue: "sonnet",
  options: [{ value: "sonnet", name: "Sonnet" }, { value: "opus", name: "Opus" }] };
const modes = { currentModeId: "auto", availableModes: [{ id: "auto", name: "Auto" }, { id: "default", name: "Manual" }] };
function modeOption() { return { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: modes.currentModeId,
  options: [{ value: "auto", name: "Auto" }, { value: "default", name: "Manual" }] }; }
function send(message) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`); }
// session/load of "replay-session" re-emits the stored conversation (history, a tool, usage and even a
// permission request) before answering, as the protocol allows. The client must not treat it as the new turn.
let prePermission;
function replayHistory(sessionId) {
  const update = (value) => send({ method: "session/update", params: { sessionId, update: value } });
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OLD_HISTORY " } });
  update({ sessionUpdate: "tool_call", toolCallId: "old-tool", title: "OLD_TOOL", status: "completed" });
  update({ sessionUpdate: "usage_update", used: 999, size: 1000 });
  send({ id: 900, method: "session/request_permission", params: { sessionId,
    toolCall: { toolCallId: "old-edit", title: "OLD_PERMISSION", kind: "edit", locations: [{ path: process.cwd() + "/sample.txt" }] },
    options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] } });
}
// Prompt "LATE": traffic sent right AFTER the terminal prompt response, while the client is tearing down.
function lateTraffic(sessionId) {
  const update = (value) => send({ method: "session/update", params: { sessionId, update: value } });
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "LATE_TEXT" } });
  update({ sessionUpdate: "tool_call", toolCallId: "late-tool", title: "LATE_TOOL", status: "pending" });
  send({ id: 901, method: "session/request_permission", params: { sessionId,
    toolCall: { toolCallId: "late-edit", title: "LATE_PERMISSION", kind: "edit", locations: [{ path: process.cwd() + "/sample.txt" }] },
    options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }] } });
}
function handle(message) {
  const { method, id, params } = message;
  if (id === 900 && !method) { prePermission = message.result?.outcome?.outcome; return; }
  if (id === 901 && !method) { writeReport("late-report.json", message.result?.outcome?.outcome); return; }
  if (method === "initialize") return send({ id, result: { protocolVersion: params.protocolVersion, agentInfo: { name: "fake-claude" },
    agentCapabilities: { loadSession: true, sessionCapabilities: { close: {}, additionalDirectories: {} } } } });
  if (method === "session/new" || method === "session/load") {
    if (params.sessionId === "simulate-startup-error") return send({ id, error: { code: -32603,
      message: "Claude Code nao conseguiu iniciar.", data: { startupFailureReason: "sandbox_required_unavailable" } } });
    const options = params._meta?.claudeCode?.options;
    if (options?.allowDangerouslySkipPermissions !== false || options?.settingSources?.length !== 0 ||
      options?.settings?.permissions?.blockReadsOutsideWorkingDirectories !== true ||
      options?.settings?.permissions?.blockWritesOutsideWorkingDirectories !== true ||
      !options?.settings?.permissions?.ask?.includes("Edit") || !options?.settings?.permissions?.ask?.includes("Write") ||
      JSON.stringify(options?.tools) !== JSON.stringify(["Read", "Glob", "Grep", "Edit", "Write"]) ||
      options?.sandbox !== undefined || params.mcpServers?.length !== 0) {
      return send({ id, error: { code: -32602, message: "Unsafe Claude policy" } });
    }
    if (method === "session/load" && params.sessionId === "replay-session") replayHistory(params.sessionId);
    return send({ id, result: { sessionId: params.sessionId ?? "claude-session", modes, configOptions: [models, modeOption()] } });
  }
  if (method === "session/set_mode") {
    modes.currentModeId = params.modeId;
    send({ method: "session/update", params: { sessionId: params.sessionId,
      update: { sessionUpdate: "config_option_update", configOptions: [models, modeOption()] } } });
    return send({ id, result: {} });
  }
  if (method === "session/set_config_option") { models.currentValue = params.value; return send({ id, result: { configOptions: [models, modeOption()] } }); }
  if (method === "session/close") return send({ id, result: {} });
  if (method === "session/prompt") {
    if (params.prompt[0].text === "HANG") return;
    if (params.prompt[0].text === "EXIT") process.exit(4);
    if (modes.currentModeId !== "default") return send({ id, error: { code: -32602, message: "Unsafe mode" } });
    send({ method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Claude partial " } } } });
    pending = { id, sessionId: params.sessionId, late: params.prompt[0].text === "LATE", slow: params.prompt[0].text === "SLOW" };
    ignoreCancel = pending.slow;
    const path = params.prompt[0].text === "OUTSIDE" ? process.execPath : process.cwd() + "/sample.txt";
    send({ id: permissionId++, method: "session/request_permission", params: { sessionId: params.sessionId,
      toolCall: { toolCallId: "edit-1", title: "Write", kind: "edit", locations: [{ path }] },
      options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] } });
    return;
  }
  if (method === "session/cancel") return ignoreCancel ? undefined : process.exit(0);
  if (typeof id === "number" && pending?.slow) { writeReport("slow-report.json", message.result?.outcome?.outcome); return; }
  if (typeof id === "number" && pending) {
    send({ method: "session/update", params: { sessionId: pending.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: (message.result?.outcome?.outcome === "selected" ? "allowed" : "denied") + (prePermission ? ` pre:${prePermission}` : "") } } } });
    send({ id: pending.id, result: { stopReason: "end_turn", usage: { inputTokens: 12, outputTokens: 3, cachedReadTokens: 2, totalTokens: 15 } } });
    if (pending.late) lateTraffic(pending.sessionId);
    pending = null;
  }
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { buffer += chunk; let index; while ((index = buffer.indexOf("\n")) >= 0) {
  const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (line.trim()) handle(JSON.parse(line));
} });
