import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (!request.id) return;
  let result = {};
  if (
    request.method === "thread/start" &&
    (request.params.sandbox !== "read-only" ||
      request.params.approvalPolicy !== "never")
  ) {
    send({
      id: request.id,
      error: { message: "Expected read-only coordinator policy" },
    });
    return;
  }
  if (request.method === "model/list")
    result = {
      data: [{ id: "test-model", model: "test-model", displayName: "Test" }],
    };
  if (request.method === "thread/start")
    result = { thread: { id: "fixture-thread" } };
  if (request.method === "turn/start")
    result = { turn: { id: "fixture-turn" } };
  send({ id: request.id, result });
  if (request.method === "turn/start") {
    send({
      method: "item/completed",
      params: {
        threadId: request.params.threadId,
        item: {
          type: "agentMessage",
          text: '{"plan":["Read"],"acceptance":["Evidence exists"]}',
        },
      },
    });
    send({
      method: "turn/completed",
      params: {
        threadId: request.params.threadId,
        turn: { id: "fixture-turn", status: "completed" },
      },
    });
  }
});
