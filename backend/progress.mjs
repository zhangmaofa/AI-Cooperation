const labels = {
  reasoning: "正在分析任务",
  commandExecution: "正在运行命令或读取项目文件",
  fileChange: "正在处理文件修改",
  mcpToolCall: "正在调用工具",
  dynamicToolCall: "正在调用工具",
  webSearch: "正在检索资料",
  contextCompaction: "正在整理会话上下文",
  agentMessage: "正在返回公开回复",
};
export function progressUpdate(previous, event) {
  const now = event.at || new Date().toISOString();
  const next = {
    ...previous,
    startedAt: previous?.startedAt || now,
    lastActivityAt: now,
    eventCount: (previous?.eventCount || 0) + 1,
  };
  if (event.type === "started") {
    next.stage = "Codex 已接收，正在处理";
    next.turnId = event.turnId;
  } else if (event.type === "message") {
    if (event.phase === "commentary" && event.text)
      next.publicMessage = String(event.text).slice(-16000);
    else if (event.phase !== "commentary" && event.text)
      next.partialText = String(event.text).slice(-24000);
    next.stage =
      event.phase === "commentary" ? "已收到阶段性进度" : "正在返回回复";
  } else if (event.type === "error" || event.type === "approval") {
    next.warning = String(event.message || "原生回合需要核对")
      .replace(/Bearer\s+\S+|sk-[A-Za-z0-9_-]+/g, "[已隐藏]")
      .slice(0, 400);
    next.stage =
      event.type === "approval"
        ? "原生回合请求交互权限"
        : "Codex 报告错误，等待确认回合状态";
  } else {
    next.stage = labels[event.itemType || event.type] || "Codex 正在工作";
    if (
      event.type === "item-started" &&
      [
        "commandExecution",
        "fileChange",
        "mcpToolCall",
        "dynamicToolCall",
        "webSearch",
      ].includes(event.itemType)
    )
      next.toolCount = (previous?.toolCount || 0) + 1;
  }
  return next;
}
export function finalText(items) {
  const messages = items.filter((i) => i.type === "agentMessage");
  const final = messages.filter((i) => i.phase === "final_answer");
  if (final.length) return final.map((i) => i.text || "").join("\n");
  const partial = messages.filter((i) => i.phase === "partial_answer");
  if (partial.length) return partial.map((i) => i.text || "").join("\n");
  return messages.filter((i) => !i.phase).at(-1)?.text || "";
}
export function bufferedProgress(initial, commit, closed = () => false) {
  let value = initial,
    lastSaved = 0,
    timer;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (closed()) return;
    lastSaved = Date.now();
    commit(value);
  };
  return {
    update(event) {
      if (closed()) return;
      const oldStage = value?.stage;
      value = progressUpdate(value, event);
      if (Date.now() - lastSaved >= 500 || oldStage !== value.stage) flush();
      else if (!timer) {
        timer = setTimeout(flush, Math.max(1, 500 - (Date.now() - lastSaved)));
        timer.unref?.();
      }
    },
    value: () => value,
    flush,
    close() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
