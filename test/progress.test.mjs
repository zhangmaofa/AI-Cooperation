import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout } from "node:timers/promises";
import { CodexClient } from "../backend/codex.mjs";
import { DesktopService } from "../backend/service.mjs";
const args = [path.resolve("test/fixtures/progress-server.mjs")];
test("quiet native work reconciles a lost completion event by reading the same turn without re-execution", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aico-quiet-progress-"));
  const cwd = path.join(root, "project");
  await mkdir(cwd);
  const s = new DesktopService({ root: path.join(root, "data") });
  s.store.saveConnection({
    id: "codex-local",
    name: "fixture",
    kind: "codex",
    command: process.execPath,
    args,
  });
  try {
    const p = await s.chats.saveProject({
      name: "静默核对",
      cwd,
      config: {
        mode: "single",
        coordinatorId: "",
        executorIds: ["codex-local"],
        maxRounds: 5,
      },
    });
    const c = await s.chats.create({ projectId: p.id });
    await s.chats.send({ id: c.id, text: "missing-terminal" });
    await s.drainBackground();
    const client = [...s.codex.values()][0];
    const run = await until(
      async () => s.store.executions()[0],
      (r) => !!r.turnId,
    );
    await until(
      () =>
        client.request("thread/read", {
          threadId: run.contextId,
          includeTurns: true,
        }),
      (r) => r.thread.turns[0].status === "completed",
    );
    const old = s.store.execution(run.id);
    s.store.saveExecution({
      ...old,
      progress: {
        ...old.progress,
        lastActivityAt: new Date(Date.now() - 95000).toISOString(),
      },
    });
    await s.chats.poll(c.id);
    assert.equal(s.chats.read(c.id).status, "idle");
    assert.equal(
      s.chats.read(c.id).messages.at(-1).text,
      "fixture final reply",
    );
    assert.equal((await client.request("fixture/stats")).starts, 1);
    assert.equal(client.turns.size, 0);
  } finally {
    s.close();
  }
});
async function until(action, check) {
  for (let i = 0; i < 150; i++) {
    const value = await action();
    if (check(value)) return value;
    await setTimeout(10);
  }
  assert.fail("fixture condition timed out");
}
test("Codex public commentary and final deltas stream without exposing reasoning or accepting stale terminal events", async () => {
  const client = new CodexClient({ command: process.execPath, args });
  const events = [];
  try {
    const response = await client.run("streaming", undefined, {
      onProgress: (e) => events.push(e),
    });
    assert.equal(response.text, "fixture final reply");
    assert.ok(
      events.some(
        (e) =>
          e.type === "message" &&
          e.phase === "commentary" &&
          e.text.includes("候选文件"),
      ),
    );
    assert.ok(
      events.some(
        (e) =>
          e.type === "message" &&
          e.phase === "final_answer" &&
          e.text === "fixture final ",
      ),
    );
    assert.equal(
      JSON.stringify(events).includes("PRIVATE_REASONING_FIXTURE"),
      false,
    );
    assert.equal((await client.request("fixture/stats")).starts, 1);
  } finally {
    client.close();
  }
});
test("reading a completed native turn settles a lost completion stream without starting another turn", async () => {
  const client = new CodexClient({ command: process.execPath, args });
  let started;
  try {
    const pending = client.run("missing-terminal", undefined, {
      onStarted: (value) => {
        started = value;
      },
    });
    await until(
      async () => started,
      (value) => !!value,
    );
    const read = await until(
      () => client.readTurn(started.threadId, started.turnId),
      (value) => value.status === "completed",
    );
    assert.equal(read.text, "fixture final reply");
    assert.equal((await pending).text, "fixture final reply");
    assert.equal(client.turns.size, 0);
    assert.equal((await client.request("fixture/stats")).starts, 1);
  } finally {
    client.close();
  }
});
test("conversation persists public activity before completion, can probe active native work, and records confirmed failures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aico-progress-"));
  const cwd = path.join(root, "project");
  await mkdir(cwd);
  const s = new DesktopService({ root: path.join(root, "data") });
  s.store.saveConnection({
    id: "codex-local",
    kind: "codex",
    name: "fixture",
    command: process.execPath,
    args: [...args, "750"],
    model: "fixture",
  });
  try {
    const project = await s.chats.saveProject({
      name: "进度",
      cwd,
      config: {
        mode: "single",
        coordinatorId: "",
        executorIds: ["codex-local"],
        maxRounds: 5,
      },
    });
    const chat = await s.chats.create({ projectId: project.id });
    await s.chats.send({ id: chat.id, text: "streaming" });
    await s.drainBackground();
    await until(
      async () => s.chats.read(chat.id),
      (c) => !!c.progress?.publicMessage,
    );
    assert.equal(s.chats.read(chat.id).status, "working");
    await s.chats.poll(chat.id, true);
    assert.match(s.chats.read(chat.id).progress.stage, /仍在进行/);
    await until(
      async () => {
        await s.chats.poll(chat.id);
        return s.chats.read(chat.id);
      },
      (c) => c.status === "idle",
    );
    assert.equal(
      s.chats.read(chat.id).messages.at(-1).text,
      "fixture final reply",
    );
    await s.chats.send({ id: chat.id, text: "native-failure" });
    await s.drainBackground();
    await until(
      async () => {
        await s.chats.poll(chat.id);
        return s.chats.read(chat.id);
      },
      (c) => c.status === "failed",
    );
    assert.match(
      s.chats.read(chat.id).messages.at(-1).text,
      /fixture quota failure/,
    );
    assert.equal(
      JSON.stringify(s.chats.read(chat.id).progress).includes(
        "PRIVATE_REASONING_FIXTURE",
      ),
      false,
    );
  } finally {
    s.close();
  }
});
