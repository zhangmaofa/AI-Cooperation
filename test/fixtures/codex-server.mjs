import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let hasRollout = false;
const executor = process.env.AICO_FIXTURE_PROFILE === "executor";
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (!request.id) return;
  let result = {};
  if (
    request.method === "thread/start" &&
    (request.params.sandbox !== (executor ? "workspace-write" : "read-only") ||
      request.params.approvalPolicy !== "never")
  ) {
    send({
      id: request.id,
      error: { message: "Unexpected role sandbox policy" },
    });
    return;
  }
  if (request.method === "thread/resume" && !hasRollout) {
    send({
      id: request.id,
      error: { message: "no rollout found before first turn" },
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
    hasRollout = true;
    send({
      method: "item/completed",
      params: {
        threadId: request.params.threadId,
        item: {
          type: "agentMessage",
          text: executor
            ? '{"status":"completed","summary":"fixture execution"}'
            : '{"plan":["Read"],"acceptance":["Evidence exists"]}',
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
