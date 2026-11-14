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
let nextId = 100;
let pendingPrompt;
let sendQueue = Promise.resolve();
const model = { id: "model", name: "Model", category: "model", type: "select", currentValue: "base",
  options: [{ value: "base", name: "Base" }, { value: "gpt-6.1-sol", name: "GPT 6.1 Sol" }] };

function send(message) {
  const encoded = `${JSON.stringify(message)}\n`;
  const midpoint = Math.floor(encoded.length / 2);
  sendQueue = sendQueue.then(() => new Promise((resolve) => {
    process.stdout.write(encoded.slice(0, midpoint));
    setTimeout(() => { process.stdout.write(encoded.slice(midpoint)); resolve(); }, 2);
  }));
}

function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function notify(sessionId, update) { send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } }); }

// session/load of "replay-session" re-emits the stored conversation (history, a tool, usage and even a
// permission request) before answering, as the protocol allows. The client must not treat it as the new turn.
let prePermission;
function replayHistory(sessionId) {
  notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OLD_HISTORY " } });
  notify(sessionId, { sessionUpdate: "tool_call", toolCallId: "old-tool", title: "OLD_TOOL", status: "completed" });
  notify(sessionId, { sessionUpdate: "usage_update", used: 999, size: 1000 });
  send({ jsonrpc: "2.0", id: 900, method: "session/request_permission", params: { sessionId,
    toolCall: { toolCallId: "old-edit", title: "OLD_PERMISSION" },
    options: [{ optionId: "allow", name: "Permitir", kind: "allow_once" }, { optionId: "deny", name: "Negar", kind: "reject_once" }] } });
}

// Prompt "LATE": traffic sent right AFTER the terminal prompt response, while the client is tearing down.
function lateTraffic(sessionId) {
  notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "LATE_TEXT" } });
  notify(sessionId, { sessionUpdate: "tool_call", toolCallId: "late-tool", title: "LATE_TOOL", status: "pending" });
  send({ jsonrpc: "2.0", id: 901, method: "session/request_permission", params: { sessionId,
    toolCall: { toolCallId: "late-tool", title: "LATE_PERMISSION" },
    options: [{ optionId: "allow", name: "Permitir", kind: "allow_once" }] } });
}

function handle(message) {
  if (message.id === 900 && !message.method) { prePermission = message.result?.outcome?.outcome; return; }
  if (message.id === 901 && !message.method) { writeReport("late-report.json", message.result?.outcome?.outcome); return; }
  if (message.method === "initialize") {
    reply(message.id, { protocolVersion: message.params.protocolVersion, agentInfo: { name: "fake-acp", version: "1" },
      agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } } });
  } else if (message.method === "session/new") {
    reply(message.id, { sessionId: "fake-session", modes: { currentModeId: "workspace-write", availableModes: [{ id: "workspace-write", name: "Workspace write" }] }, configOptions: [model] });
  } else if (message.method === "session/load") {
    if (message.params.sessionId === "replay-session") replayHistory(message.params.sessionId);
    reply(message.id, { modes: { currentModeId: "workspace-write", availableModes: [{ id: "workspace-write", name: "Workspace write" }] }, configOptions: [model] });
  } else if (message.method === "session/set_config_option") {
    model.currentValue = message.params.value;
    reply(message.id, { configOptions: [model] });
  } else if (message.method === "session/close") {
    reply(message.id, {});
  } else if (message.method === "session/prompt") {
    const text = message.params.prompt[0].text;
    if (text === "EXIT") { process.exit(3); return; }
    if (text === "HANG") return;
    const sessionId = message.params.sessionId;
    notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "parte 1 " } });
    notify(sessionId, { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "ler arquivo", status: "pending" });
    notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "parte 2" } });
    pendingPrompt = { id: message.id, sessionId, late: text === "LATE", slow: text === "SLOW" };
    ignoreCancel = pendingPrompt.slow;
    send({ jsonrpc: "2.0", id: nextId++, method: "session/request_permission", params: {
      sessionId, toolCall: { toolCallId: "tool-1", title: "ler arquivo" },
      options: [{ optionId: "allow", name: "Permitir", kind: "allow_once" }, { optionId: "deny", name: "Negar", kind: "reject_once" }]
    } });
  } else if (message.method === "session/cancel") {
    if (!ignoreCancel) process.exit(0);
  } else if (message.id === 100 && pendingPrompt?.slow) {
    writeReport("slow-report.json", message.result?.outcome?.outcome);
  } else if (message.id === 100 && pendingPrompt) {
    const choice = message.result?.outcome?.outcome;
    notify(pendingPrompt.sessionId, { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed" });
    notify(pendingPrompt.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: (choice === "selected" ? " permitiu" : " negou") + (prePermission ? ` pre:${prePermission}` : "") } });
    reply(pendingPrompt.id, { stopReason: "end_turn" });
    if (pendingPrompt.late) lateTraffic(pendingPrompt.sessionId);
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
