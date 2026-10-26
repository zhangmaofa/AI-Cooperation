const labels = {
  needs_input: "执行器有疑问待答复",
  needs_user: "需要你在原软件处理",
  pending_review: "交付已返回，等待审核",
  delivery_unknown: "执行状态待核对",
  failed: "执行器报告失败",
  stalled: "协作已暂停，需要核对",
};
exports.notices = function (previous, next) {
  if (!previous || next.preferences?.notifications === false) return [];
  const old = new Map(previous.tasks.map((t) => [t.id, t]));
  const signature = (t) =>
    `${t?.status}:${t?.remoteTaskId || ""}:${t?.rounds || 0}:${!!t?.userQuestion}:${!!t?.automationError}`;
  const result = next.tasks
    .filter(
      (t) =>
        labels[t.status] &&
        !(
          t.status === "needs_input" &&
          t.contract?.autoAnswer &&
          !t.userQuestion &&
          !t.automationError
        ) &&
        !(
          t.status === "pending_review" &&
          t.autoReview &&
          !t.automationError
        ) &&
        signature(old.get(t.id)) !== signature(t),
    )
    .map((t) => ({
      id: t.id,
      page: "tasks",
      title: labels[t.status],
      body: t.goal.slice(0, 140),
    }));
  for (const w of next.workflows || [])
    if (
      w.status === "accepted" &&
      previous.workflows?.find((p) => p.id === w.id)?.status !== "accepted"
    )
      result.push({
        id: w.id,
        page: "workflows",
        title: "协作计划已完成总体验收",
        body: w.goal.slice(0, 140),
      });
  return result;
};
