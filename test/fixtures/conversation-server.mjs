// Isolated JSON-RPC fixture, never calls a model or writes outside its test root.
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
} from "node:fs";
import path from "node:path";
const root = path.resolve(process.argv[2]);
mkdirSync(root, { recursive: true });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const file = (id) => {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("fixture thread ID");
  return path.join(root, `${id}.json`);
};
const read = (id) => JSON.parse(readFileSync(file(id), "utf8"));
const save = (thread) => writeFileSync(file(thread.id), JSON.stringify(thread));
createInterface({ input: process.stdin }).on("line", (line) => {
  const r = JSON.parse(line);
  if (!r.id) return;
  try {
    let result = {};
    const p = r.params;
    if (r.method === "model/list")
      result = {
        data: [
          {
            id: "fixture-main",
            model: "fixture-main",
            displayName: "Fixture Main",
          },
          {
            id: "fixture-cheap",
            model: "fixture-cheap",
            displayName: "Fixture Cheap",
          },
        ],
      };
    if (["thread/start", "thread/resume"].includes(r.method)) {
      if (
        p.approvalPolicy !== "never" ||
        !["read-only", "workspace-write"].includes(p.sandbox)
      )
        throw new Error("fixture policy mismatch");
      const thread =
        r.method === "thread/start"
          ? { id: randomUUID(), turns: [], ...p }
          : { ...read(p.threadId), ...p };
      save(thread);
      result = { thread };
    }
    if (r.method === "thread/read") result = { thread: read(p.threadId) };
    if (r.method === "turn/start") {
      const thread = read(p.threadId),
        prompt = p.input[0].text;
      appendFileSync(
        path.join(root, "calls.ndjson"),
        JSON.stringify({
          threadId: thread.id,
          cwd: thread.cwd,
          model: thread.model,
          sandbox: thread.sandbox,
          prompt,
        }) + "\n",
      );
      let text;
      if (thread.sandbox === "workspace-write") {
        const safe = path.resolve(thread.cwd),
          parent = path.dirname(root) + path.sep;
        if (!safe.startsWith(parent))
          throw new Error("outside fixture workspace");
        writeFileSync(
          path.join(safe, `${thread.model || "worker"}.txt`),
          "isolated fixture artifact\n",
        );
        text = prompt.includes("直接对话")
          ? "已在所选项目目录写入测试文件，并检查了内容。这是隔离协议测试，未调用真实模型。"
          : '{"status":"completed","summary":"已写入并核对隔离测试文件"}';
      } else if (prompt.includes("生成至多10个子任务")) {
        const data = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
        text = JSON.stringify({
          acceptance: ["检查各个交付文件"],
          nodes: data.executors.map((e, i) => ({
            id: `T${i + 1}`,
            goal: `执行器 ${e.name} 的交付`,
            plan: ["写入并验证测试文件"],
            acceptance: ["文件内容正确"],
            dependsOn: i ? ["T1"] : [],
            connectionId: e.id,
            workspace: data.workspace,
          })),
        });
      } else if (prompt.includes("全部子任务已分别验收"))
        text =
          '{"decision":"accept","feedback":"已核对所有测试交付与集成","evidence":["隔离文件内容检查"],"reviseNodes":[]}';
      else if (prompt.includes("主调审核者"))
        text =
          '{"decision":"accept","feedback":"文件已检查","evidence":[{"criterionId":"C1","passed":true,"reference":"isolated fixture artifact"}]}';
      else text = "当前协作在所选项目目录进行。";
      const turn = {
        id: randomUUID(),
        status: "completed",
        items: [{ type: "agentMessage", text }],
      };
      thread.turns.push(turn);
      save(thread);
      send({ id: r.id, result: { turn: { id: turn.id } } });
      send({
        method: "item/completed",
        params: { threadId: thread.id, item: turn.items[0] },
      });
      send({
        method: "turn/completed",
        params: {
          threadId: thread.id,
          turn: { id: turn.id, status: "completed" },
        },
      });
      return;
    }
    send({ id: r.id, result });
  } catch (error) {
    send({ id: r.id, error: { message: error.message } });
  }
});
