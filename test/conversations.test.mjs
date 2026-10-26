import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { DesktopService } from "../backend/service.mjs";
import { CodexClient } from "../backend/codex.mjs";

async function setup(factory) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aico-conversations-"));
  const cwd = path.join(root, "project");
  await mkdir(cwd);
  const service = new DesktopService({
    root: path.join(root, "data"),
    clientFactory: factory,
  });
  return { root, cwd, service };
}
const config = {
  mode: "single",
  coordinatorId: "",
  executorIds: ["codex-local"],
  maxRounds: 5,
};
async function turns(s, count = 1) {
  for (let i = 0; i < count; i++) {
    await s.tick();
    await s.drainBackground();
  }
}
async function reach(s, predicate) {
  for (let i = 0; i < 150; i++) {
    await turns(s);
    if (predicate()) return;
    await setTimeout(5);
  }
  assert.fail(JSON.stringify(s.snapshot(), null, 2));
}

test("project chat performs direct multi-turn work on one native session and persists isolated project history", async () => {
  const calls = [];
  const factory = (connection, { role }) => ({
    connection,
    openThread: async (id) => id || randomUUID(),
    close() {},
    run: async function (prompt, threadId, options) {
      calls.push({
        prompt,
        threadId,
        cwd: this.connection.cwd,
        role,
        model: this.connection.model,
      });
      options.onStarted({ turnId: `turn-${calls.length}` });
      await writeFile(
        path.join(this.connection.cwd, "answer.txt"),
        `actual fixture turn ${calls.length}`,
      );
      return {
        text:
          calls.length === 1
            ? '{"status":"needs_input","question":"请确认交付格式"}'
            : "已按照你的答复更新文件，并验证了内容。",
      };
    },
  });
  const { service: s, root, cwd } = await setup(factory);
  let reopened;
  try {
    const project = await s.handle("project.save", {
      name: "项目一",
      cwd,
      config,
    });
    const chat = await s.handle("conversation.create", {
      projectId: project.id,
    });
    await s.handle("conversation.send", {
      id: chat.id,
      text: "请设计方案并完成项目修改",
    });
    await s.drainBackground();
    await reach(s, () => s.chats.read(chat.id).status === "needs_input");
    assert.equal(s.chats.read(chat.id).status, "needs_input");
    await s.handle("conversation.send", { id: chat.id, text: "使用文本格式" });
    await s.drainBackground();
    await reach(s, () => s.chats.read(chat.id).status === "idle");
    const read = s.chats.read(chat.id);
    assert.equal(read.status, "idle");
    assert.equal(read.messages.filter((m) => m.role === "assistant").length, 2);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].threadId, calls[1].threadId);
    assert.ok(calls.every((c) => c.cwd === cwd && c.role === "executor"));
    assert.match(calls[0].prompt, /直接对话/);
    assert.equal(s.store.tasks().length, 0);
    assert.match(
      await readFile(path.join(cwd, "answer.txt"), "utf8"),
      /turn 2/,
    );
    const other = path.join(root, "other");
    await mkdir(other);
    const p2 = await s.chats.saveProject({
      name: "项目二",
      cwd: other,
      config,
    });
    const c2 = await s.chats.create({ projectId: p2.id });
    assert.deepEqual(s.chats.read(c2.id).messages, []);
    await assert.rejects(
      s.chats.saveProject({
        id: project.id,
        name: "改目录",
        cwd: other,
        config,
      }),
      /目录不能更换/,
    );
    s.close();
    reopened = new DesktopService({
      root: path.join(root, "data"),
      clientFactory: factory,
    });
    assert.equal(reopened.store.projects().length, 2);
    assert.equal(reopened.chats.read(chat.id).messages.length, 4);
    assert.equal(reopened.chats.read(chat.id).contextId, read.contextId);
    assert.equal(reopened.chats.read(chat.id).workspace, cwd);
  } finally {
    (reopened || s).close();
  }
});

test("direct chats share workspace leases with workflows, and uncertain restart never replays an instruction", async () => {
  const calls = [];
  const factory = (connection) => ({
    connection,
    close() {},
    openThread: async (id) => id || randomUUID(),
    run(prompt, id, options) {
      calls.push({ prompt, id });
      options.onStarted({ turnId: "known-turn" });
      return new Promise(() => {});
    },
    readTurn: async () => ({
      status: "completed",
      text: "核对到原生回合已完成",
    }),
  });
  const { service: s, root, cwd } = await setup(factory);
  let reopened;
  try {
    const p = await s.chats.saveProject({ name: "锁验证", cwd, config });
    const a = await s.chats.create({ projectId: p.id });
    const b = await s.chats.create({ projectId: p.id });
    await s.chats.send({ id: a.id, text: "第一回合" });
    await s.drainBackground();
    await s.chats.send({ id: b.id, text: "第二回合" });
    await s.drainBackground();
    assert.equal(s.chats.read(b.id).status, "queued");
    const task = await s.create({
      mode: "real",
      connectionId: "codex-local",
      workspace: cwd,
      goal: "另一个任务",
      plan: ["修改"],
      acceptance: ["证据"],
      maxRounds: 3,
    });
    await s.action(task.id, "dispatch");
    assert.equal(s.store.task(task.id).status, "queued");
    assert.equal(calls.length, 1);
    s.close();
    reopened = new DesktopService({
      root: path.join(root, "data"),
      clientFactory: factory,
    });
    await turns(reopened, 2);
    assert.equal(reopened.chats.read(a.id).status, "unknown");
    assert.equal(calls.length, 1);
    await assert.rejects(
      reopened.chats.send({ id: a.id, text: "不要重复发送" }),
      /原回合/,
    );
    await reopened.chats.poll(a.id, true);
    assert.equal(reopened.chats.read(a.id).status, "idle");
    assert.match(
      reopened.chats.read(a.id).messages.at(-1).text,
      /原生回合已完成/,
    );
    await turns(reopened);
    assert.equal(calls.length, 2);
    assert.equal(reopened.chats.read(b.id).status, "working");
  } finally {
    (reopened || s).close();
  }
});

test("distributed conversation plans in project directory, routes user answers through its main thread and integrates two workers", async () => {
  const calls = [];
  let workerTurns = 0;
  const factory = (connection, { role }) => ({
    connection,
    close() {},
    openThread: async (id) => id || randomUUID(),
    run: async function (prompt, threadId, options = {}) {
      calls.push({ role, prompt, cwd: this.connection.cwd, threadId });
      options.onStarted?.({ turnId: randomUUID() });
      if (role === "executor") {
        workerTurns++;
        if (workerTurns === 1)
          return {
            text: '{"status":"needs_input","question":"用户希望哪种格式？"}',
          };
        await writeFile(
          path.join(this.connection.cwd, `${this.connection.connectionId}.txt`),
          "artifact checked",
        );
        return { text: '{"status":"completed","summary":"已写入并检查文件"}' };
      }
      if (prompt.includes("生成至多10个子任务"))
        return {
          threadId,
          text: JSON.stringify({
            acceptance: ["两个文件正确集成"],
            nodes: [
              {
                id: "A",
                goal: "第一份文件",
                plan: ["写文件"],
                acceptance: ["文件存在"],
                dependsOn: [],
                connectionId: "w1",
                workspace: "must-be-overridden",
              },
              {
                id: "B",
                goal: "第二份文件",
                plan: ["写文件"],
                acceptance: ["文件存在"],
                dependsOn: ["A"],
                connectionId: "w2",
              },
            ],
          }),
        };
      if (prompt.includes("用户已答复"))
        return { text: '{"answer":"按照用户要求，使用文本格式"}' };
      if (prompt.includes("答复执行器疑问"))
        return {
          text: '{"decision":"ask_user","answer":"请确认需要的文件格式"}',
        };
      if (prompt.includes("全部子任务已分别验收"))
        return {
          text: '{"decision":"accept","feedback":"已独立核对两个交付文件","evidence":["文件内容已检查"],"reviseNodes":[]}',
        };
      return {
        text: '{"decision":"accept","feedback":"已检查实际文件","evidence":[{"criterionId":"C1","passed":true,"reference":"fixture file inspected"}]}',
      };
    },
  });
  const { service: s, cwd } = await setup(factory);
  try {
    for (const id of ["w1", "w2"])
      s.store.saveConnection({
        id,
        name: id,
        kind: "codex",
        command: "not-executed.exe",
        model: "cheap",
        cwd,
      });
    const project = await s.chats.saveProject({
      name: "协作项目",
      cwd,
      config: {
        ...config,
        mode: "distributed",
        coordinatorId: "codex-local",
        executorIds: ["w1", "w2"],
      },
    });
    const chat = await s.chats.create({ projectId: project.id });
    await s.chats.send({ id: chat.id, text: "输出两个经过验证的文本文件" });
    await s.drainBackground();
    const plan = s.chats.read(chat.id);
    assert.ok(plan.plan.nodes.every((n) => n.workspace === cwd));
    assert.equal(s.store.tasks().length, 0, "planning never starts workers");
    await s.chats.start(chat.id);
    await turns(s, 5);
    const workflow = s.workflows.get(s.chats.read(chat.id).workflowId);
    const question = workflow.taskIds
      .map((id) => s.store.task(id))
      .find((t) => t.userQuestion);
    assert.ok(question);
    assert.match(s.chats.read(chat.id).messages.at(-1).text, /主调需要你确认/);
    await s.chats.send({
      id: chat.id,
      text: "使用文本格式",
      taskId: question.id,
    });
    await s.drainBackground();
    await reach(s, () => s.workflows.get(workflow.id).status === "accepted");
    await turns(s);
    assert.equal(s.workflows.get(workflow.id).status, "accepted");
    assert.match(s.chats.read(chat.id).messages.at(-1).text, /总体验收/);
    assert.ok(
      s.store
        .messages(question.id)
        .filter((m) => m.kind === "question")
        .every((m) => m.state === "delivered"),
    );
    assert.ok(calls.every((c) => c.cwd === cwd));
    const main = calls.filter((c) => c.role === "coordinator");
    assert.ok(main.every((c) => c.threadId === plan.threadId));
    assert.ok(
      main.some(
        (c) =>
          c.prompt.includes("使用文本格式") && c.prompt.includes("用户已答复"),
      ),
    );
    assert.equal(
      await readFile(path.join(cwd, "w1.txt"), "utf8"),
      "artifact checked",
    );
  } finally {
    s.close();
  }
});

test("a coordinator cannot introduce unselected workers or launch an invalid plan", async () => {
  const factory = (connection) => ({
    connection,
    close() {},
    openThread: async () => "native-thread",
    run: async () => ({
      text: JSON.stringify({
        acceptance: ["交付"],
        nodes: [
          {
            id: "A",
            goal: "越界执行",
            plan: ["写"],
            acceptance: ["验"],
            connectionId: "not-selected",
          },
        ],
      }),
    }),
  });
  const { service: s, cwd } = await setup(factory);
  try {
    const p = await s.chats.saveProject({
      name: "配置边界",
      cwd,
      config: { ...config, mode: "distributed", coordinatorId: "codex-local" },
    });
    const c = await s.chats.create({ projectId: p.id });
    await s.chats.send({ id: c.id, text: "只用选定的执行器" });
    await s.drainBackground();
    assert.equal(s.chats.read(c.id).status, "failed");
    assert.match(s.chats.read(c.id).error, /未选择/);
    assert.equal(s.store.tasks().length, 0);
    await assert.rejects(s.chats.start(c.id), /可开工/);
  } finally {
    s.close();
  }
});

test("a lost second send cannot be recovered by mistaking the previous completed run for its reply", async () => {
  let fail = false;
  const factory = (connection) => ({
    connection,
    close() {},
    openThread: async (id) => {
      if (fail) throw new Error("fixture disconnected during send");
      return id || randomUUID();
    },
    run: async () => ({ text: "第一轮已完成" }),
  });
  const { service: s, cwd } = await setup(factory);
  try {
    const project = await s.chats.saveProject({
      name: "不确定发送",
      cwd,
      config,
    });
    const chat = await s.chats.create({ projectId: project.id });
    await s.chats.send({ id: chat.id, text: "第一轮" });
    await s.drainBackground();
    await reach(s, () => s.chats.read(chat.id).status === "idle");
    const previous = s.chats.read(chat.id).remoteTaskId;
    fail = true;
    await s.chats.send({ id: chat.id, text: "第二轮" });
    await s.drainBackground();
    assert.equal(s.chats.read(chat.id).status, "unknown");
    assert.notEqual(s.chats.read(chat.id).remoteTaskId, previous);
    await assert.rejects(s.chats.poll(chat.id, true));
    assert.equal(s.chats.read(chat.id).status, "unknown");
    assert.equal(
      s.chats.read(chat.id).messages.filter((m) => m.role === "assistant")
        .length,
      1,
    );
  } finally {
    s.close();
  }
});

test("queued Codex turns capture their own working directory instead of another project's profile", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aico-native-profiles-"));
  const native = path.join(root, "native");
  const client = new CodexClient({
    command: process.execPath,
    args: [path.resolve("test/fixtures/conversation-server.mjs"), native],
    cwd: path.join(root, "a"),
    model: "fixture-main",
  });
  try {
    const a = client.run("检查项目 A");
    client.connection = { ...client.connection, cwd: path.join(root, "b") };
    const b = client.run("检查项目 B");
    await Promise.all([a, b]);
    const calls = (await readFile(path.join(native, "calls.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(
      calls.map((c) => c.cwd),
      [path.join(root, "a"), path.join(root, "b")],
    );
  } finally {
    client.close();
  }
});

test("two project planners waiting on the same decision queue keep their independent project roots", async () => {
  const calls = [];
  const factory = (connection) => ({
    connection,
    close() {},
    openThread: async () => randomUUID(),
    run: async function (_prompt, threadId) {
      calls.push(this.connection.cwd);
      return {
        threadId,
        text: JSON.stringify({
          acceptance: ["交付"],
          nodes: [
            {
              id: "T",
              goal: "交付",
              plan: ["验证"],
              acceptance: ["证据"],
              connectionId: "codex-local",
            },
          ],
        }),
      };
    },
  });
  const { service: s, root, cwd } = await setup(factory);
  let release;
  s.collaboration.mainQueue = new Promise((resolve) => {
    release = resolve;
  });
  try {
    const other = path.join(root, "second-project");
    await mkdir(other);
    for (const [name, directory] of [
      ["A", cwd],
      ["B", other],
    ]) {
      const p = await s.chats.saveProject({
        name,
        cwd: directory,
        config: {
          ...config,
          mode: "distributed",
          coordinatorId: "codex-local",
        },
      });
      const c = await s.chats.create({ projectId: p.id });
      await s.chats.send({ id: c.id, text: `规划项目 ${name}` });
      await setTimeout(5);
    }
    release();
    await s.drainBackground();
    assert.deepEqual(calls, [cwd, other]);
  } finally {
    release();
    s.close();
  }
});
