import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
const threads = new Map();
let starts = 0;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const duration = Number(process.argv[2]) || 250;
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (!request.id) return;
  const p = request.params || {};
  let result = {};
  if (request.method === "thread/start") {
    const thread = { id: randomUUID(), turns: [] };
    threads.set(thread.id, thread);
    result = { thread };
  }
  if (request.method === "thread/resume" || request.method === "thread/read")
    result = { thread: threads.get(p.threadId) };
  if (request.method === "fixture/stats") result = { starts };
  if (request.method === "turn/start") {
    starts++;
    const prompt = p.input[0].text;
    const thread = threads.get(p.threadId);
    const turn = { id: randomUUID(), status: "inProgress", items: [] };
    thread.turns.push(turn);
    send({ id: request.id, result: { turn: { id: turn.id } } });
    const event = (method, extra) =>
      send({
        method,
        params: { threadId: thread.id, turnId: turn.id, ...extra },
      });
    const item = {
      id: "public",
      type: "agentMessage",
      phase: "commentary",
      text: "已定位候选文件，正在核对",
    };
    turn.items.push(item);
    event("item/started", {
      item: { id: item.id, type: item.type, phase: item.phase, text: "" },
    });
    event("item/agentMessage/delta", {
      itemId: item.id,
      delta: "已定位候选文件，",
    });
    event("item/agentMessage/delta", { itemId: item.id, delta: "正在核对" });
    event("item/completed", { item });
    event("item/started", {
      item: { type: "reasoning", content: "PRIVATE_REASONING_FIXTURE" },
    });
    event("item/reasoning/textDelta", { delta: "PRIVATE_REASONING_FIXTURE" });
    event("item/started", {
      item: { type: "commandExecution", command: "fixture-only" },
    });
    event("item/completed", { item: { type: "commandExecution" } });
    send({
      method: "turn/completed",
      params: {
        threadId: thread.id,
        turnId: "stale-unrelated",
        turn: { id: "stale-unrelated", status: "failed" },
      },
    });
    if (prompt.includes("native-failure")) {
      event("error", { error: { message: "fixture quota failure" } });
      turn.status = "failed";
      turn.error = { message: "fixture quota failure" };
      event("turn/completed", { turn });
      return;
    }
    const final = {
      id: "final",
      type: "agentMessage",
      phase: "final_answer",
      text: "fixture final reply",
    };
    setTimeout(
      () => {
        turn.items.push(final);
        event("item/started", { item: { ...final, text: "" } });
        event("item/agentMessage/delta", {
          itemId: final.id,
          delta: "fixture final ",
        });
      },
      Math.floor(duration / 3),
    );
    setTimeout(() => {
      event("item/agentMessage/delta", { itemId: final.id, delta: "reply" });
      event("item/completed", { item: final });
      turn.status = "completed";
      if (!prompt.includes("missing-terminal"))
        event("turn/completed", { turn });
    }, duration);
    return;
  }
  send({ id: request.id, result });
});
