const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
function url(threadId) {
  if (!uuid.test(threadId || ""))
    throw new Error(
      "尚未取得有效的 Codex 原生会话 ID，请先等待派发或核对原回合",
    );
  return `codex://threads/${threadId}`;
}
function conversationTarget(snapshot, id) {
  const c = snapshot?.conversations?.find((c) => c.id === id);
  if (!c) throw new Error("对话不存在");
  const connectionId =
    c.config.mode === "single"
      ? c.config.executorIds[0]
      : c.config.coordinatorId;
  if (snapshot.connections.find((c) => c.id === connectionId)?.kind !== "codex")
    throw new Error("这个角色没有绑定 Codex，请使用对应软件的打开入口");
  const threadId =
    c.config.mode === "single" ? c.nativeThreadId || c.contextId : c.threadId;
  return { url: url(threadId), threadId, conversationId: c.id };
}
function taskTarget(snapshot, id) {
  const task = snapshot?.tasks?.find((t) => t.id === id);
  if (!task || task.executor.type !== "codex")
    throw new Error("这个任务没有绑定 Codex 执行器");
  return {
    url: url(task.contextId),
    threadId: task.contextId,
    taskId: task.id,
  };
}
function automaticTargets(previous, next) {
  if (!previous || !next.preferences?.autoOpenCodex) return [];
  const result = [];
  for (const c of next.conversations || []) {
    const old = previous.conversations?.find((p) => p.id === c.id);
    if (!old) continue;
    const completed =
      ["idle", "needs_input", "failed"].includes(c.status) &&
      old.status !== c.status;
    const integrated =
      c.completedWorkflow && c.completedWorkflow !== old.completedWorkflow;
    if (!completed && !integrated) continue;
    try {
      const target = conversationTarget(next, c.id);
      result.push({
        ...target,
        key: `${c.id}:${c.remoteTaskId || c.completedWorkflow || c.revision}`,
      });
    } catch {
      /* An unpaired role or unconfirmed thread is not a valid desktop target. */
    }
  }
  return result;
}
module.exports = {
  codexThreadUrl: url,
  conversationTarget,
  taskTarget,
  automaticTargets,
};
