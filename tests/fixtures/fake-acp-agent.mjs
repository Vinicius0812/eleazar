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

function handle(message) {
  if (message.method === "initialize") {
    reply(message.id, { protocolVersion: message.params.protocolVersion, agentInfo: { name: "fake-acp", version: "1" },
      agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } } });
  } else if (message.method === "session/new") {
    reply(message.id, { sessionId: "fake-session", configOptions: [model] });
  } else if (message.method === "session/load") {
    reply(message.id, { configOptions: [model] });
  } else if (message.method === "session/set_config_option") {
    model.currentValue = message.params.value;
    reply(message.id, { configOptions: [model] });
  } else if (message.method === "session/prompt") {
    const text = message.params.prompt[0].text;
    if (text === "EXIT") { process.exit(3); return; }
    if (text === "HANG") return;
    const sessionId = message.params.sessionId;
    notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "parte 1 " } });
    notify(sessionId, { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "ler arquivo", status: "pending" });
    notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "parte 2" } });
    pendingPrompt = { id: message.id, sessionId };
    send({ jsonrpc: "2.0", id: nextId++, method: "session/request_permission", params: {
      sessionId, toolCall: { toolCallId: "tool-1", title: "ler arquivo" },
      options: [{ optionId: "allow", name: "Permitir", kind: "allow_once" }, { optionId: "deny", name: "Negar", kind: "reject_once" }]
    } });
  } else if (message.method === "session/cancel") {
    process.exit(0);
  } else if (message.id === 100 && pendingPrompt) {
    const choice = message.result?.outcome?.outcome;
    notify(pendingPrompt.sessionId, { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed" });
    notify(pendingPrompt.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: choice === "selected" ? " permitiu" : " negou" } });
    reply(pendingPrompt.id, { stopReason: "end_turn" });
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
