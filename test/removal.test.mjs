import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DesktopService } from "../backend/service.mjs";
const config = {
  mode: "single",
  coordinatorId: "",
  executorIds: ["codex-local"],
  maxRounds: 5,
};
test("project and chat removal is reversible, persistent, and preserves files, messages and independently removed chats", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aico-removal-")),
    cwd = path.join(root, "project");
  await mkdir(cwd);
  await writeFile(path.join(cwd, "keep.txt"), "keep");
  let s = new DesktopService({ root: path.join(root, "data") });
  try {
    const p = await s.chats.saveProject({ name: "保留源码", cwd, config });
    const a = await s.chats.create({ projectId: p.id }),
      b = await s.chats.create({ projectId: p.id });
    s.chats.append(a, "assistant", "## 历史内容\n\n原文 **保留**");
    await s.handle("conversation.remove", { id: a.id });
    assert.deepEqual(
      s.snapshot().conversations.map((c) => c.id),
      [b.id],
    );
    assert.equal(s.snapshot().archivedConversations[0].id, a.id);
    await assert.rejects(
      s.handle("conversation.send", { id: a.id, text: "不可发送" }),
      /已移除/,
    );
    await s.handle("project.remove", { id: p.id });
    assert.equal(s.snapshot().projects.length, 0);
    assert.equal(s.snapshot().conversations.length, 0);
    assert.equal(s.snapshot().archivedConversations.length, 0);
    assert.equal(s.snapshot().archivedProjects[0].id, p.id);
    await assert.rejects(
      s.handle("conversation.create", { projectId: p.id }),
      /已移除/,
    );
    await assert.rejects(
      s.handle("project.save", { name: "重复", cwd, config }),
      /恢复/,
    );
    s.close();
    s = new DesktopService({ root: path.join(root, "data") });
    assert.equal(s.snapshot().projects.length, 0);
    await s.handle("project.restore", { id: p.id });
    assert.deepEqual(
      s.snapshot().conversations.map((c) => c.id),
      [b.id],
    );
    await s.handle("conversation.restore", { id: a.id });
    assert.equal(
      s.chats.read(a.id).messages[0].text,
      "## 历史内容\n\n原文 **保留**",
    );
    assert.equal(s.snapshot().conversations.length, 2);
    assert.equal(await readFile(path.join(cwd, "keep.txt"), "utf8"), "keep");
  } finally {
    s.close();
  }
});
test("running, uncertain and queued chats block removal atomically for their parent project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aico-removal-busy-"));
  const s = new DesktopService({ root: path.join(root, "data") });
  try {
    const p = await s.chats.saveProject({ name: "工作中", cwd: root, config });
    const a = await s.chats.create({ projectId: p.id }),
      b = await s.chats.create({ projectId: p.id });
    for (const status of [
      "sending",
      "thinking",
      "queued",
      "unknown",
      "working",
      "cancel_requested",
      "needs_user",
    ]) {
      b.status = status;
      s.chats.save(b);
      await assert.rejects(
        s.handle("conversation.remove", { id: b.id }),
        /先停止/,
      );
      await assert.rejects(s.handle("project.remove", { id: p.id }), /先停止/);
      assert.equal(s.snapshot().conversations.length, 2);
      assert.equal(s.snapshot().projects.length, 1);
    }
    b.status = "idle";
    s.chats.save(b);
    s.chats.busy.add(b.id);
    await assert.rejects(
      s.handle("conversation.remove", { id: b.id }),
      /先停止/,
    );
    s.chats.busy.delete(b.id);
    b.workflowIds = ["flow"];
    s.chats.save(b);
    s.store.saveWorkflow({
      id: "flow",
      status: "working",
      taskIds: [],
      paused: false,
    });
    await assert.rejects(
      s.handle("project.remove", { id: p.id }),
      /先暂停协作/,
    );
    s.store.saveWorkflow({
      id: "flow",
      status: "paused",
      taskIds: [],
      paused: true,
    });
    await s.handle("project.remove", { id: p.id });
    assert.equal(s.snapshot().projects.length, 0);
  } finally {
    s.close();
  }
});
