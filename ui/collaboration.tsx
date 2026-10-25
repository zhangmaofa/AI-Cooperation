import React, { useState } from "react";
import type {
  Connection,
  Contract,
  Snapshot,
  Task,
  Workflow,
  WorkflowNode,
} from "./types";
type Call = <T = unknown>(
  method: string,
  data?: unknown,
) => Promise<T | undefined>;
export const defaultContract: Contract = {
  autoAnswer: false,
  verification: [],
  allowedPaths: [],
  maxTokens: 0,
  stopOnNoProgress: true,
};

export function ContractFields({
  value,
  change,
  coordinator,
}: {
  value: Contract;
  change: (value: Contract) => void;
  coordinator: boolean;
}) {
  const [command, setCommand] = useState(value.verification[0]?.command || "");
  const [args, setArgs] = useState(
    JSON.stringify(value.verification[0]?.args || []),
  );
  const [invalid, setInvalid] = useState(false);
  function updateCommand(next: string, argv: string) {
    if (!next.trim()) {
      change({ ...value, verification: [] });
      setInvalid(false);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(argv);
      if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== "string"))
        throw new Error();
      change({
        ...value,
        verification: next.trim() ? [{ command: next, args: parsed }] : [],
      });
      setInvalid(false);
    } catch {
      setInvalid(true);
      change({ ...value, verification: [{ command: "", args: [] }] });
    }
  }
  return (
    <details className="advanced-contract">
      <summary>协作与验收设置</summary>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={value.autoAnswer}
          disabled={!coordinator}
          onChange={(e) => change({ ...value, autoAnswer: e.target.checked })}
        />
        <span>
          由原主控答复执行疑问<small>需要用户决定时转交给你</small>
        </span>
      </label>
      <label>
        约定修改的相对路径
        <input
          aria-label="允许修改的相对路径"
          placeholder="例如 src, test；留空使用整个工作目录"
          value={value.allowedPaths.join(", ")}
          onChange={(e) =>
            change({
              ...value,
              allowedPaths: e.target.value
                .split(",")
                .map((v) => v.trim())
                .filter(Boolean),
            })
          }
        />
      </label>
      <p className="hint">
        此范围用于任务指令与验收检查，实际文件访问权限仍由执行软件的沙箱管理。
      </p>
      <div className="form-two">
        <label>
          独立验证程序
          <input
            aria-label="独立验证程序"
            value={command}
            onChange={(e) => {
              setCommand(e.target.value);
              updateCommand(e.target.value, args);
            }}
            placeholder="例如 node.exe 或验证程序完整路径"
          />
        </label>
        <label>
          验证参数（JSON 数组）
          <input
            aria-label="验证参数"
            value={args}
            onChange={(e) => {
              setArgs(e.target.value);
              updateCommand(command, e.target.value);
            }}
            placeholder={'["--test"]'}
          />
        </label>
      </div>
      {invalid && (
        <p role="alert" className="warning">
          验证参数必须是字符串数组。请修正或清空验证程序。
        </p>
      )}
      <p className="hint">
        验证程序在执行工作目录运行；独立验证失败时禁止验收。复杂测试可调用项目已有的验证脚本。
      </p>
      <label>
        本任务可观测 token 上限
        <input
          type="number"
          min={0}
          value={value.maxTokens}
          onChange={(e) =>
            change({ ...value, maxTokens: Number(e.target.value) })
          }
        />
      </label>
      <p className="hint">
        0 表示不设上限。仅统计协议实际报告的用量；无法报告的执行器无法保证 token
        预算。
      </p>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={value.stopOnNoProgress}
          onChange={(e) =>
            change({ ...value, stopOnNoProgress: e.target.checked })
          }
        />
        <span>返工没有进展或审核重复时暂停</span>
      </label>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={Boolean(value.isolateWorktree)}
          onChange={(e) =>
            change({ ...value, isolateWorktree: e.target.checked })
          }
        />
        <span>
          使用独立 Git 工作区
          <small>
            仅本地执行器可用；从干净的已提交版本创建，产物保留在独立目录供审核，不自动合并
          </small>
        </span>
      </label>
    </details>
  );
}

export function TaskTools({ task, call }: { task: Task; call: Call }) {
  const [busy, setBusy] = useState(false);
  async function act(action: string) {
    setBusy(true);
    try {
      await call("task.action", { id: task.id, action });
    } finally {
      setBusy(false);
    }
  }
  const verification = task.verifications?.at(-1);
  return (
    <div className="collaboration-tools">
      {task.queueReason && task.status === "queued" && (
        <p className="warning">{task.queueReason}</p>
      )}
      {task.userQuestion && task.status === "needs_input" && (
        <p className="warning">主控需要你确认：{task.userQuestion}</p>
      )}
      <div className="button-row">
        {task.status === "needs_input" && task.coordinatorId && (
          <button
            className="secondary"
            disabled={busy || task.busy}
            onClick={() => act("coordinator-answer")}
          >
            交给原主控答疑
          </button>
        )}
        {["delivery_unknown", "cancel_requested"].includes(task.status) &&
          task.remoteTaskId && (
            <button
              className="secondary"
              disabled={busy || task.busy}
              onClick={() => act("recover")}
            >
              核对原执行轮次
            </button>
          )}
        {task.status === "stalled" && (
          <button
            className="secondary"
            disabled={busy || task.busy}
            onClick={() => act("resume")}
          >
            已核对，允许继续原会话
          </button>
        )}
        {task.status === "pending_review" && (
          <button
            className="secondary"
            disabled={busy || task.busy}
            onClick={() => act("reverify")}
          >
            重新运行独立验证
          </button>
        )}
        {["ready", "queued", "working", "needs_input"].includes(
          task.status,
        ) && (
          <button
            className="secondary"
            disabled={busy || task.busy}
            onClick={() => act("cancel")}
          >
            请求停止任务
          </button>
        )}
      </div>
      {task.usedTokens !== undefined && (
        <p className="hint">
          本任务已报告用量：{task.usedTokens.toLocaleString()} tokens
        </p>
      )}
      {verification && (
        <details className="verification-report" open>
          <summary>第 {verification.round} 轮独立验证与产物</summary>
          {verification.checks.length ? (
            verification.checks.map((check, i) => (
              <div key={i}>
                <strong className={check.passed ? "check-pass" : "check-fail"}>
                  {check.passed ? "通过" : "失败"} · {check.command}
                </strong>
                <pre className="report">
                  {check.output || check.error || "无输出"}
                </pre>
              </div>
            ))
          ) : (
            <p className="hint">未配置验证程序；仍需逐项核查真实产物。</p>
          )}
          {verification.outside.length > 0 && (
            <p className="warning">
              范围外修改：{verification.outside.join("、")}
            </p>
          )}
          <p className="hint">
            {verification.complete === false
              ? "快照达到扫描上限，变更清单不完整。"
              : "已记录内容哈希。"}{" "}
            工作区变更 {verification.changed.length} 项
          </p>
          <ul>
            {verification.changed.slice(0, 30).map((file) => (
              <li key={file}>
                <code>{file}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function SchedulerSettings({
  state,
  call,
}: {
  state: Snapshot;
  call: Call;
}) {
  const [maxConcurrent, setMax] = useState(state.scheduler?.maxConcurrent || 2);
  const [perConnection, setPer] = useState(state.scheduler?.perConnection || 1);
  const [saved, setSaved] = useState(false);
  return (
    <section className="panel settings-panel">
      <h2>执行调度</h2>
      <p className="hint">
        注册连接数量与同时执行数量分别管理。同一工作区及其子目录共享写入锁；待答疑、待审核和未知状态保留工作区锁。
      </p>
      <div className="form-two">
        <label>
          最多同时执行
          <input
            aria-label="最多同时执行"
            type="number"
            min={1}
            max={10}
            value={maxConcurrent}
            onChange={(e) => setMax(Number(e.target.value))}
          />
        </label>
        <label>
          每个连接最多同时执行
          <input
            aria-label="每个连接最多同时执行"
            type="number"
            min={1}
            max={10}
            value={perConnection}
            onChange={(e) => setPer(Number(e.target.value))}
          />
        </label>
      </div>
      <button
        className="secondary"
        onClick={async () => {
          setSaved(
            Boolean(
              await call("scheduler.save", { maxConcurrent, perConnection }),
            ),
          );
        }}
      >
        保存调度设置
      </button>
      {saved && <span className="hint"> 已保存</span>}
    </section>
  );
}

export function McpIntegration({ call }: { call: Call }) {
  const [config, setConfig] = useState("");
  return (
    <section className="panel settings-panel">
      <h2>从原有 AI 对话管理任务</h2>
      <p className="hint">
        把本地 MCP
        工具连接到主控软件后，可以在原对话派发、答疑和审核。工具与桌面客户端使用同一后台和
        SQLite；原对话需要持续调用状态工具跟进，工具不会自动唤醒已关闭的聊天。
      </p>
      <button
        className="secondary"
        onClick={async () => {
          const value = await call("integration.info");
          if (value) setConfig(JSON.stringify(value, null, 2));
        }}
      >
        显示本机 MCP 启动配置
      </button>
      {config && <pre className="report">{config}</pre>}
    </section>
  );
}

export function AimannaPairing({ call }: { call: Call }) {
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <section className="panel settings-panel">
      <h2>连接本机 AIMana</h2>
      <p className="hint">
        通过 AIMana++ 面板选择已启用 Workspace 的 Agent 配对。沿用 AIMana
        账号额度，无需模型 API key，也不用手工查找地址和连接 token。
      </p>
      <div className="button-row">
        <button
          className="secondary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const result = await call<{ message: string }>("connector.install");
            if (result) setMessage(result.message);
            setBusy(false);
          }}
        >
          安装 / 更新 AIMana 连接插件
        </button>
        <button
          className="primary"
          disabled={busy}
          onClick={async () => {
            const result = await call<{ code: string }>("pairing.start");
            if (result) {
              setCode(result.code);
              setMessage(
                "两分钟内在 AIMana++ 面板的 AI-Cooperation 区块粘贴配对码，读取并选择 Agent，再点击配对。",
              );
            }
          }}
        >
          生成配对码
        </button>
        {code && (
          <button
            className="secondary"
            onClick={async () => {
              const result = await call<{ state: string }>("pairing.status");
              setMessage(
                result?.state === "paired"
                  ? "已配对，连接已保存。请在下方测试连接后派发任务。"
                  : result?.state === "expired"
                    ? "配对码已过期，请重新生成。"
                    : "等待 AIMana 确认配对。",
              );
            }}
          >
            检查配对结果
          </button>
        )}
      </div>
      {code && (
        <label>
          短时配对码
          <input
            aria-label="短时配对码"
            readOnly
            value={code}
            onFocus={(e) => e.target.select()}
          />
        </label>
      )}
      {message && (
        <p role="status" className="hint">
          {message}
        </p>
      )}
      <p className="hint">
        连接插件针对本机 AIMana 1.12.17
        接口编写，真实兼容性仍需配对和任务实测。不会自动更改 Workspace
        开关、模型或账号。
      </p>
    </section>
  );
}

const workflowStatus: Record<string, string> = {
  reviewing: "正在审核整体",
  draft: "待开工",
  working: "协作中",
  pending_review: "待总体审核",
  accepted: "整体已验收",
  needs_attention: "需要关注",
  budget_exhausted: "总体审核次数耗尽",
};
const taskStateLabel: Record<string, string> = {
  ready: "待执行",
  queued: "排队中",
  working: "执行中",
  sending: "派发中",
  pending_review: "待审核",
  revision_ready: "待返工",
  needs_input: "待答疑",
  needs_user: "需要用户处理",
  accepted: "已验收",
  failed: "失败",
  canceled: "已取消",
  cancel_requested: "停止确认中",
  stalled: "无进展暂停",
  delivery_unknown: "需核对远端",
  budget_exhausted: "预算耗尽",
};
export function WorkflowPage({
  state,
  call,
  openTask,
}: {
  state: Snapshot;
  call: Call;
  openTask: (id: string) => void;
}) {
  const [goal, setGoal] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [coordinatorId, setCoordinator] = useState(
    state.connections.find((c) => c.kind === "codex")?.id || "",
  );
  const [draft, setDraft] = useState<{
    nodes: WorkflowNode[];
    acceptance: string[];
    threadId: string;
    goal: string;
    coordinatorId: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [autoReview, setAuto] = useState(true);
  async function analyze() {
    setBusy(true);
    const result = await call<{
      nodes: WorkflowNode[];
      acceptance: string[];
      threadId: string;
    }>("workflow.analyze", { goal, workspace, coordinatorId });
    if (result) setDraft({ ...result, goal, coordinatorId });
    setBusy(false);
  }
  async function create() {
    if (!draft) return;
    setBusy(true);
    const result = await call("workflow.create", {
      ...draft,
      autoReview,
      maxRounds: 5,
    });
    if (result) {
      setDraft(null);
      setGoal("");
    }
    setBusy(false);
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">TEAM WORKFLOWS</span>
          <h1>
            协作计划<span className="heading-dot">.</span>
          </h1>
          <p>主控拆分目标，执行器按依赖协作，最后审核整体交付。</p>
        </div>
      </div>
      <section className="panel settings-panel">
        <h2>制定新的协作计划</h2>
        <label>
          总体目标
          <textarea
            aria-label="协作总体目标"
            value={goal}
            onChange={(e) => {
              setGoal(e.target.value);
              setDraft(null);
            }}
            placeholder="描述需要多位 Agent 配合完成的目标和范围"
          />
        </label>
        <div className="form-two">
          <label>
            主控
            <select
              aria-label="协作主控"
              value={coordinatorId}
              onChange={(e) => {
                setCoordinator(e.target.value);
                setDraft(null);
              }}
            >
              {state.connections
                .filter((c) => c.kind === "codex")
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            默认工作目录
            <div className="input-action">
              <input
                aria-label="协作默认工作目录"
                value={workspace}
                onChange={(e) => {
                  setWorkspace(e.target.value);
                  setDraft(null);
                }}
              />
              <button
                className="secondary"
                onClick={async () => {
                  const path = await window.cooperation.pickDirectory();
                  if (path) {
                    setWorkspace(path);
                    setDraft(null);
                  }
                }}
              >
                选择
              </button>
            </div>
          </label>
        </div>
        <button
          className="primary"
          disabled={busy || !goal.trim() || !coordinatorId}
          onClick={analyze}
        >
          {busy ? "正在处理…" : "让主控制定协作计划"}
        </button>
        <p className="hint">
          生成计划会使用模型额度。计划创建后再点击开工。同一目录自动串行，独立目录才可并行。
        </p>
        {draft && (
          <div className="workflow-draft">
            <h3>检查子任务与执行器</h3>
            {draft.nodes.map((node, index) => (
              <article className="workflow-node" key={node.id}>
                <strong>
                  {node.id} · {node.goal}
                </strong>
                <p className="hint">
                  前置任务：{node.dependsOn.join("、") || "无"}
                </p>
                <ol>
                  {node.plan.map((step, i) => (
                    <li key={i}>{step}</li>
                  ))}
                </ol>
                <p>验收：{node.acceptance.join("；")}</p>
                <div className="form-two">
                  <label>
                    执行 Agent
                    <select
                      aria-label={`${node.id} 执行 Agent`}
                      value={node.connectionId}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          nodes: draft.nodes.map((n, i) =>
                            i === index
                              ? { ...n, connectionId: e.target.value }
                              : n,
                          ),
                        })
                      }
                    >
                      {state.connections.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    执行工作目录
                    <input
                      aria-label={`${node.id} 执行工作目录`}
                      value={node.workspace || workspace}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          nodes: draft.nodes.map((n, i) =>
                            i === index
                              ? { ...n, workspace: e.target.value }
                              : n,
                          ),
                        })
                      }
                    />
                  </label>
                </div>
                <ContractFields
                  value={node.contract || defaultContract}
                  coordinator={false}
                  change={(contract) =>
                    setDraft({
                      ...draft,
                      nodes: draft.nodes.map((n, i) =>
                        i === index ? { ...n, contract } : n,
                      ),
                    })
                  }
                />
              </article>
            ))}
            <label>
              总体验收
              <textarea
                aria-label="总体验收标准"
                value={draft.acceptance.join("\n")}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    acceptance: e.target.value.split("\n").filter(Boolean),
                  })
                }
              />
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={autoReview}
                onChange={(e) => setAuto(e.target.checked)}
              />
              <span>开工后由原主控自动答疑、审核和返工，最后审核整体交付</span>
            </label>
            <button className="primary" disabled={busy} onClick={create}>
              保存协作计划
            </button>
          </div>
        )}
      </section>
      {(state.workflows || []).map((workflow) => (
        <section className="panel settings-panel" key={workflow.id}>
          <div className="section-title">
            <h2>{workflow.goal}</h2>
            <span className="pill">
              {workflowStatus[workflow.status] || workflow.status}
            </span>
          </div>
          {workflow.lastError && (
            <p className="warning">{workflow.lastError}</p>
          )}
          <div className="workflow-grid">
            {workflow.taskIds.map((id) => {
              const task = state.tasks.find((t) => t.id === id);
              return (
                task && (
                  <button
                    className="workflow-node"
                    key={id}
                    onClick={() => openTask(id)}
                  >
                    <strong>
                      {task.nodeId} · {task.goal}
                    </strong>
                    <p>
                      {taskStateLabel[task.status] || task.status} · 第{" "}
                      {task.rounds} 轮
                    </p>
                    <small>
                      {task.queueReason ||
                        state.connections.find(
                          (c) => c.id === task.executor.connectionId,
                        )?.name}
                    </small>
                  </button>
                )
              );
            })}
          </div>
          <div className="button-row">
            <button
              className="primary"
              disabled={busy || workflow.status === "accepted"}
              onClick={async () => {
                setBusy(true);
                await call("workflow.start", { id: workflow.id });
                setBusy(false);
              }}
            >
              开工 / 调度待执行项
            </button>
            <button
              className="secondary"
              disabled={
                busy ||
                workflow.status === "accepted" ||
                !workflow.taskIds.every(
                  (id) =>
                    state.tasks.find((t) => t.id === id)?.status === "accepted",
                )
              }
              onClick={async () => {
                setBusy(true);
                await call("workflow.review", { id: workflow.id });
                setBusy(false);
              }}
            >
              交给原主控审核整体
            </button>
          </div>
          {workflow.reviews.map((review, index) => (
            <p className="hint" key={index}>
              整体审核 {index + 1} · {review.feedback}
            </p>
          ))}
        </section>
      ))}
      <section className="panel settings-panel">
        <h2>主控收件箱</h2>
        {(state.messages || [])
          .slice(-12)
          .reverse()
          .map((message) => (
            <article className="workflow-node" key={message.id}>
              <strong>
                {message.kind === "question" ? "执行器疑问" : "执行器交付"} ·{" "}
                {message.state}
              </strong>
              <p>
                {message.response ||
                  message.error ||
                  message.text.slice(0, 300)}
              </p>
            </article>
          ))}
        {!state.messages?.length && (
          <p className="hint">执行器的疑问与结果会持久保存在这里。</p>
        )}
      </section>
    </>
  );
}
