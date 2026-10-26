import test from "node:test";
import assert from "node:assert/strict";
import links from "../desktop/native-links.cjs";
const threadId = "11111111-2222-4333-8444-555555555555";
const chat = {
  id: "owned-chat",
  config: { mode: "single", executorIds: ["codex"] },
  contextId: threadId,
  status: "working",
  remoteTaskId: "first-turn",
};
const snapshot = {
  connections: [{ id: "codex", kind: "codex" }],
  conversations: [chat],
  tasks: [],
  preferences: { autoOpenCodex: true },
};
test("desktop links resolve only owned Codex conversations and validate native thread IDs", () => {
  assert.equal(
    links.conversationTarget(snapshot, chat.id).url,
    `codex://threads/${threadId}`,
  );
  assert.throws(
    () => links.conversationTarget(snapshot, "unregistered"),
    /不存在/,
  );
  assert.throws(
    () => links.codexThreadUrl("https://untrusted.invalid"),
    /有效/,
  );
  assert.throws(
    () =>
      links.conversationTarget(
        { ...snapshot, connections: [{ id: "codex", kind: "aimana" }] },
        chat.id,
      ),
    /没有绑定/,
  );
  assert.throws(
    () =>
      links.conversationTarget(
        { ...snapshot, conversations: [{ ...chat, contextId: "..\\..\\" }] },
        chat.id,
      ),
    /有效/,
  );
});
test("automatic desktop reveal happens after a turn, without startup or repeated poll spam", () => {
  const completed = {
    ...snapshot,
    conversations: [{ ...chat, status: "idle" }],
  };
  assert.deepEqual(links.automaticTargets(undefined, completed), []);
  assert.equal(links.automaticTargets(snapshot, completed).length, 1);
  assert.deepEqual(links.automaticTargets(completed, completed), []);
  assert.deepEqual(
    links.automaticTargets(
      { ...completed, preferences: { autoOpenCodex: false } },
      completed,
    ),
    [],
  );
  assert.deepEqual(
    links.automaticTargets(snapshot, {
      ...completed,
      preferences: { autoOpenCodex: false },
    }),
    [],
  );
});
test("distributed reveal opens the owning main session; individual tasks open their original worker", () => {
  const main = {
    ...chat,
    config: {
      mode: "distributed",
      coordinatorId: "codex",
      executorIds: ["codex"],
    },
    threadId,
    completedWorkflow: "workflow",
  };
  const next = {
    ...snapshot,
    conversations: [main],
    tasks: [{ id: "task", executor: { type: "codex" }, contextId: threadId }],
  };
  assert.equal(links.conversationTarget(next, chat.id).threadId, threadId);
  assert.equal(
    links.taskTarget(next, "task").url,
    `codex://threads/${threadId}`,
  );
  assert.equal(
    links.automaticTargets(
      { ...next, conversations: [{ ...main, completedWorkflow: undefined }] },
      next,
    ).length,
    1,
  );
});
