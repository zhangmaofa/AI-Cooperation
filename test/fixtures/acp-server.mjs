import { createInterface } from "node:readline";
const send = (value) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
let promptId;
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === "permission") {
    if (m.result?.outcome?.outcome !== "cancelled") process.exit(3);
    send({ id: promptId, result: { stopReason: "end_turn" } });
    return;
  }
  if (m.method === "initialize")
    send({
      id: m.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "fixture" },
        agentCapabilities: { loadSession: !process.env.AICO_ACP_NO_LOAD },
      },
    });
  if (m.method === "session/new")
    send({ id: m.id, result: { sessionId: "native-acp-session" } });
  if (m.method === "session/load") send({ id: m.id, result: {} });
  if (m.method === "session/prompt") {
    if (m.params.prompt[0].text === "permission") {
      promptId = m.id;
      send({
        id: "permission",
        method: "session/request_permission",
        params: { sessionId: m.params.sessionId, options: [] },
      });
      return;
    }
    send({
      method: "session/update",
      params: {
        sessionId: m.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: '{"status":"completed","summary":"ACP fixture"}',
          },
        },
      },
    });
    send({ id: m.id, result: { stopReason: "end_turn" } });
  }
});
