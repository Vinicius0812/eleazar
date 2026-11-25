// Mirrors what agy 1.5.9 was observed to do over ACP: mode ids, the thought_level option, and
// session/set_mode answering BEFORE the config_option_update that confirms the mode.
let buffer = "";
let pending;
let currentMode = "default";
let model = "gemini-4-neon";
const modeIds = ["default", "accept-edits", "auto", "plan"];
const choices = (values) => values.map((value) => ({ value, name: value }));
const configOptions = () => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: model, options: choices(["gemini-4-neon", "gemini-4-carbon"]) },
  { id: "thought_level", name: "Thinking Level", category: "thought_level", type: "select", currentValue: "high", options: choices(["low", "high"]) },
  { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: currentMode, options: choices(modeIds) }
];
function send(message) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`); }
function update(sessionId, value) { send({ method: "session/update", params: { sessionId, update: value } }); }

function handle(message) {
  const { method, id, params } = message;
  if (method === "initialize") return send({ id, result: { protocolVersion: params.protocolVersion,
    agentInfo: { name: "Antigravity ACP Server", version: "1.5.9" },
    agentCapabilities: { loadSession: true, sessionCapabilities: { close: {}, additionalDirectories: {} } } } });
  if (method === "session/new" || method === "session/load") {
    if (params.sessionId === "no-login") return send({ id, error: { code: -32000, message: "Authentication required" } });
    if (params.mcpServers?.length !== 0) return send({ id, error: { code: -32602, message: "Unexpected MCP servers" } });
    // Sessions named "plan-*" were left in another mode, so the client must switch them back.
    currentMode = params.sessionId?.startsWith("plan-") ? "plan" : "default";
    return send({ id, result: { sessionId: params.sessionId ?? "agy-session", configOptions: configOptions(),
      modes: { currentModeId: currentMode, availableModes: modeIds.map((mode) => ({ id: mode, name: mode })) } } });
  }
  if (method === "session/set_mode") {
    send({ id, result: {} });
    if (params.sessionId === "plan-unconfirmed") return;
    currentMode = params.modeId;
    setTimeout(() => {
      update(params.sessionId, { sessionUpdate: "current_mode_update", currentModeId: currentMode });
      update(params.sessionId, { sessionUpdate: "config_option_update", configOptions: configOptions() });
    }, 50);
    return;
  }
  if (method === "session/set_config_option") { model = params.value; return send({ id, result: { configOptions: configOptions() } }); }
  if (method === "session/close") return send({ id, result: {} });
  if (method === "session/prompt") {
    if (currentMode !== "default") return send({ id, error: { code: -32602, message: "Unsafe mode" } });
    const text = params.prompt[0].text;
    if (text === "HANG") return;
    if (text === "EXIT") process.exit(4);
    if (text === "TWO_MESSAGES") {
      const say = (value) => update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } });
      say("Vou "); say("ler.");
      update(params.sessionId, { sessionUpdate: "tool_call", toolCallId: "read-1", title: "File notas.txt", status: "in_progress" });
      update(params.sessionId, { sessionUpdate: "tool_call_update", toolCallId: "read-1", status: "completed" });
      say("São "); say("3.");
      return send({ id, result: { stopReason: "end_turn" } });
    }
    pending = { id, sessionId: params.sessionId };
    const uriPath = `${/^[A-Za-z]:/.test(process.cwd()) ? "/" : ""}${process.cwd().replaceAll("\\", "/")}/sample.txt`;
    const locations = text === "URI_PATH" ? [{ path: uriPath }] : text === "NO_LOCATION" ? [] : [{ path: text === "OUTSIDE" ? process.execPath : `${process.cwd()}/sample.txt` }];
    return send({ id: 100, method: "session/request_permission", params: { sessionId: params.sessionId,
      toolCall: { toolCallId: "edit-1", title: "Write", kind: "edit", locations },
      options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] } });
  }
  if (method === "session/cancel") return process.exit(0);
  if (id === 100 && pending) {
    const allowed = message.result?.outcome?.outcome === "selected" && message.result.outcome.optionId === "allow";
    update(pending.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: allowed ? "allowed" : "denied" } });
    send({ id: pending.id, result: { stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 4, cachedReadTokens: 3, cachedWriteTokens: 0, thoughtTokens: 2, totalTokens: 17 } } });
    pending = undefined;
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
