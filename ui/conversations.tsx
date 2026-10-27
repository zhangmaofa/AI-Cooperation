import { useEffect, useRef, useState } from "react";
import type {
  AgentConfiguration,
  Connection,
  Conversation,
  Project,
  Snapshot,
  ExecutionProgress,
} from "./types";
import { clearDraft, useDraftState } from "./drafts";
import { MarkdownMessage, type MessageScope } from "./markdown";
type Call = <T>(method: string, data?: unknown) => Promise<T | undefined>;
const emptyConfig: AgentConfiguration = {
  mode: "single",
  coordinatorId: "",
  executorIds: [],
  maxRounds: 5,
};
const names: Record<string, string> = {
  codex: "Codex",
  aimana: "AIMana",
  acp: "ACP",
  a2a: "A2A",
};
const states: Record<string, string> = {
  idle: "可继续对话",
  queued: "等待执行",
  thinking: "主调正在处理",
  sending: "正在发送",
  working: "Agent 正在工作",
  unknown: "需要核对原回合",
  needs_user: "需要在原软件处理",
  needs_input: "等待你答复",
  failed: "本轮未完成",
  cancel_requested: "已请求停止",
};
function RunProgress({
  value,
  showText,
  scope,
}: {
  value: ExecutionProgress;
  showText: boolean;
  scope?: MessageScope;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const age = (at?: string) =>
    Math.max(
      0,
      Math.floor((now - Date.parse(at || new Date(now).toISOString())) / 1000),
    );
  const duration = (seconds: number) =>
    seconds < 60
      ? `${seconds} 秒`
      : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  const quiet = age(value.lastActivityAt);
  return (
    <section className="run-progress" aria-label="原生执行进度">
      <div className="run-progress-title">
        <strong>{value.stage || "正在等待原生回合进度"}</strong>
        <span>已用时 {duration(age(value.startedAt))}</span>
      </div>
      <p className="hint">
        最近收到进度：{duration(quiet)}前 · 已收到 {value.eventCount || 0}{" "}
        条事件{value.toolCount ? ` · 工具活动 ${value.toolCount} 次` : ""}
      </p>
      {value.publicMessage && (
        <div className="run-public-message">
          <span className="hint">Agent 的阶段性进度</span>
          <MarkdownMessage text={value.publicMessage} scope={scope} />
        </div>
      )}
      {showText && value.partialText && (
        <div className="run-stream">
          <span className="hint">正在返回的回复 · 本轮尚未确认结束</span>
          <MarkdownMessage text={value.partialText} scope={scope} />
        </div>
      )}
      {value.warning && <p className="warning">{value.warning}</p>}
      {quiet >= 45 && (
        <p className="hint">
          已有 {duration(quiet)}
          未收到新进度。模型或工具可能仍在处理，可点击“核对原回合”读取原生状态；不会重复发送问题。
        </p>
      )}
    </section>
  );
}
function label(c: Connection) {
  return `${c.name} · ${names[c.kind]} · ${c.model || "软件默认模型"}`;
}

function ConfigurationFields({
  value,
  change,
  connections,
}: {
  value: AgentConfiguration;
  change: (value: AgentConfiguration) => void;
  connections: Connection[];
}) {
  const workers = connections.filter((c) =>
    ["codex", "aimana", "acp"].includes(c.kind),
  );
  return (
    <div className="agent-configuration">
      <div className="conversation-modes" role="group" aria-label="对话模式">
        <button
          type="button"
          aria-pressed={value.mode === "single"}
          onClick={() =>
            change({
              ...value,
              mode: "single",
              executorIds: value.executorIds.slice(0, 1),
            })
          }
        >
          <strong>单 Agent</strong>
          <span>直接沟通，由它规划、执行与验证</span>
        </button>
        <button
          type="button"
          aria-pressed={value.mode === "distributed"}
          onClick={() => change({ ...value, mode: "distributed" })}
        >
          <strong>AI-Cooperation 协作</strong>
          <span>主调规划与审核，多个执行器分工</span>
        </button>
      </div>
      {value.mode === "distributed" && (
        <label>
          主调 Agent
          <select
            aria-label="对话主调 Agent"
            value={value.coordinatorId}
            onChange={(e) =>
              change({ ...value, coordinatorId: e.target.value })
            }
          >
            <option value="">选择主调软件与模型配置</option>
            {connections
              .filter((c) => c.kind === "codex")
              .map((c) => (
                <option value={c.id} key={c.id}>
                  {label(c)}
                </option>
              ))}
          </select>
          <span className="hint">
            当前主调支持 Codex；主调只读分析和审核。其他软件按执行器能力接入。
          </span>
        </label>
      )}
      {value.mode === "single" ? (
        <label>
          执行 Agent
          <select
            aria-label="对话执行 Agent"
            value={value.executorIds[0] || ""}
            onChange={(e) =>
              change({
                ...value,
                executorIds: e.target.value ? [e.target.value] : [],
              })
            }
          >
            <option value="">选择软件、Agent 与模型配置</option>
            {workers.map((c) => (
              <option key={c.id} value={c.id}>
                {label(c)}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <fieldset className="executor-picker">
          <legend>执行 Agent（可选多个）</legend>
          {workers.map((c) => (
            <label key={c.id} className="checkbox-label">
              <input
                aria-label={`执行器 ${c.name}`}
                type="checkbox"
                checked={value.executorIds.includes(c.id)}
                onChange={(e) =>
                  change({
                    ...value,
                    executorIds: e.target.checked
                      ? [...value.executorIds, c.id]
                      : value.executorIds.filter((id) => id !== c.id),
                  })
                }
              />
              {label(c)}
            </label>
          ))}
        </fieldset>
      )}
      {value.mode === "distributed" && (
        <label>
          每个子任务最多执行轮次
          <input
            aria-label="协作执行轮次"
            type="number"
            min="1"
            max="30"
            value={value.maxRounds}
            onChange={(e) =>
              change({ ...value, maxRounds: Number(e.target.value) })
            }
          />
          <span className="hint">
            同一目录的写入任务会排队；审核不通过会返回原会话，达到轮次上限后暂停。
          </span>
        </label>
      )}
      <p className="hint">
        每条连接保存软件、Agent 和模型。需要换模型时，可在“Agent
        连接”保存另一条配置，再在这里选择。
      </p>
    </div>
  );
}

export function DefaultConversationSettings({
  state,
  call,
  agents,
}: {
  state: Snapshot;
  call: Call;
  agents: () => void;
}) {
  const saved = state.conversationDefaults || emptyConfig;
  const [value, setValue] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => setValue(saved), [JSON.stringify(saved)]);
  return (
    <section className="panel settings-panel">
      <h2>新项目的默认 Agent 配置</h2>
      <p className="hint">
        项目创建时继承此配置；项目可单独覆盖。已有对话保留原模式、模型和会话绑定。
      </p>
      <ConfigurationFields
        value={value}
        change={setValue}
        connections={state.connections}
      />
      <div className="button-row">
        <button className="secondary" onClick={agents}>
          配置软件与模型
        </button>
        <button
          className="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const result = await call("conversation.defaults", value);
            if (result) setMessage("默认 Agent 配置已保存");
            setBusy(false);
          }}
        >
          保存默认 Agent 配置
        </button>
      </div>
      <p className="hint" role="status">
        {message}
      </p>
    </section>
  );
}

export function ProjectNavigation({
  state,
  projectId,
  chatId,
  open,
  create,
  call,
}: {
  state: Snapshot;
  projectId: string;
  chatId: string;
  open: (projectId: string, chatId?: string) => void;
  create: () => void;
  call: Call;
}) {
  const [removed, setRemoved] = useState(false);
  const [busy, setBusy] = useState(false);
  async function mutate(method: string, id: string) {
    setBusy(true);
    try {
      await call(method, { id });
    } finally {
      setBusy(false);
    }
  }
  function menu(kind: "project" | "conversation", id: string, title: string) {
    return (
      <details className="project-item-menu">
        <summary aria-label={`${title}的操作`} title="更多操作">
          ⋯
        </summary>
        <div>
          <button
            disabled={busy}
            onClick={() => void mutate(`${kind}.remove`, id)}
          >
            移除{kind === "project" ? "项目" : "对话"}
          </button>
        </div>
      </details>
    );
  }
  return (
    <section className="project-navigation" aria-label="项目与历史对话">
      <div className="project-nav-heading">
        <span>项目</span>
        <button aria-label="新建项目" onClick={create}>
          ＋
        </button>
      </div>
      {!state.projects?.length && (
        <p className="hint">添加项目目录，把对话和工作保存在一起。</p>
      )}
      {state.projects?.map((project) => (
        <div className="project-nav-group" key={project.id}>
          <div className="project-item-row">
            <button
              className={`project-nav-title ${projectId === project.id && !chatId ? "selected" : ""}`}
              onClick={() => open(project.id)}
            >
              <span aria-hidden="true">▱</span>
              <span>{project.name}</span>
            </button>
            {menu("project", project.id, project.name)}
          </div>
          <button className="new-project-chat" onClick={() => open(project.id)}>
            ＋ 在此项目新建对话
          </button>
          {(state.conversations || [])
            .filter((c) => c.projectId === project.id)
            .map((chat) => (
              <div className="project-item-row" key={chat.id}>
                <button
                  className={`project-chat-link ${chatId === chat.id ? "selected" : ""}`}
                  onClick={() => open(project.id, chat.id)}
                  title={chat.title}
                >
                  <i
                    className={
                      chat.status === "working" || chat.status === "thinking"
                        ? "dot"
                        : "chat-idle-dot"
                    }
                  />
                  <span>{chat.title}</span>
                </button>
                {menu("conversation", chat.id, chat.title)}
              </div>
            ))}
        </div>
      ))}
      <button
        className="new-project-chat"
        aria-expanded={removed}
        onClick={() => setRemoved(!removed)}
      >
        已移除（
        {(state.archivedProjects?.length || 0) +
          (state.archivedConversations?.length || 0)}
        ）
      </button>
      {removed && (
        <section className="removed-items" aria-label="已移除的项目和对话">
          <p className="hint">
            可随时恢复；项目文件与原软件中的会话保留。移除项目会收起其中的对话。
          </p>
          {state.archivedProjects?.map((p) => (
            <div key={p.id}>
              <span title={p.cwd}>项目 · {p.name}</span>
              <button
                disabled={busy}
                onClick={() => void mutate("project.restore", p.id)}
              >
                恢复
              </button>
            </div>
          ))}
          {state.archivedConversations?.map((c) => (
            <div key={c.id}>
              <span title={c.title}>对话 · {c.title}</span>
              <button
                disabled={busy}
                onClick={() => void mutate("conversation.restore", c.id)}
              >
                恢复
              </button>
            </div>
          ))}
          {!state.archivedProjects?.length &&
            !state.archivedConversations?.length && (
              <p className="hint">暂无已移除的项目或对话</p>
            )}
        </section>
      )}
    </section>
  );
}

export function ProjectDialog({
  project,
  state,
  call,
  close,
  saved,
}: {
  project?: Project;
  state: Snapshot;
  call: Call;
  close: () => void;
  saved: (project: Project) => void;
}) {
  const [name, setName] = useState(project?.name || "");
  const [cwd, setCwd] = useState(project?.cwd || "");
  const [config, setConfig] = useState(
    project?.config || state.conversationDefaults || emptyConfig,
  );
  const [busy, setBusy] = useState(false);
  return (
    <div className="modal-overlay">
      <section
        className="modal project-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={project ? "项目配置" : "新建项目"}
      >
        <div className="modal-heading">
          <div>
            <h2>{project ? "项目配置" : "新建项目"}</h2>
            <p>保存项目目录与默认配置，随时继续历史对话。</p>
          </div>
          <button
            className="icon-button"
            aria-label="关闭项目设置"
            onClick={close}
          >
            ×
          </button>
        </div>
        <div className="modal-body">
          <label>
            项目名称
            <input
              aria-label="项目名称"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            项目工作目录
            <div className="directory-field">
              <input
                aria-label="项目工作目录"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
              />
              <button
                className="secondary"
                onClick={async () => {
                  const directory = await window.cooperation.pickDirectory();
                  if (directory) {
                    setCwd(directory);
                    if (!name)
                      setName(
                        directory.split(/[\\/]/).filter(Boolean).at(-1) ||
                          "新项目",
                      );
                  }
                }}
              >
                选择目录
              </button>
            </div>
            <span className="hint">
              主调在这里读取项目、规划和审核；执行器在这里工作。已有对话后目录固定。
            </span>
          </label>
          <ConfigurationFields
            value={config}
            change={setConfig}
            connections={state.connections}
          />
        </div>
        <div className="modal-footer">
          <button className="secondary" onClick={close}>
            取消
          </button>
          <button
            className="primary"
            disabled={busy || !name.trim() || !cwd.trim()}
            onClick={async () => {
              setBusy(true);
              const result = await call<Project>("project.save", {
                id: project?.id,
                name,
                cwd,
                config,
              });
              if (result) saved(result);
              setBusy(false);
            }}
          >
            保存项目
          </button>
        </div>
      </section>
    </div>
  );
}

export function ProjectConversation({
  project,
  chatId,
  state,
  call,
  select,
  settings,
  agents,
  openTask,
}: {
  project: Project;
  chatId: string;
  state: Snapshot;
  call: Call;
  select: (id: string) => void;
  settings: () => void;
  agents: () => void;
  openTask: (id: string) => void;
}) {
  const [detail, setDetail] = useState<Conversation | null>(null);
  const adoptDetail = (result: Conversation) =>
    setDetail((current) =>
      current && current.id === result.id && current.revision > result.revision
        ? current
        : result,
    );
  const [config, setConfig] = useState(project.config);
  const [input, setInput] = useDraftState(
    `conversation.${chatId || `new-${project.id}`}`,
    "",
  );
  const [busy, setBusy] = useState(false);
  const [createdId, setCreatedId] = useState("");
  const [answerTask, setAnswerTask] = useState("");
  const [desktopNotice, setDesktopNotice] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const metadata = state.conversations?.find((c) => c.id === chatId);
  const activeConfig = detail?.config || config;
  const desktopRoleId =
    activeConfig.mode === "single"
      ? activeConfig.executorIds[0]
      : activeConfig.coordinatorId;
  const canOpenCodex =
    !!detail &&
    state.connections.find((c) => c.id === desktopRoleId)?.kind === "codex";
  const desktopThread =
    activeConfig.mode === "single"
      ? detail?.nativeThreadId || detail?.contextId
      : detail?.threadId;
  const workflow = state.workflows?.find((w) => w.id === detail?.workflowId);
  const tasks =
    workflow?.taskIds
      .map((id) => state.tasks.find((t) => t.id === id))
      .filter((t) => !!t) || [];
  const questions = tasks.filter(
    (t) => t.status === "needs_input" && !!t.userQuestion,
  );
  const locked =
    detail &&
    [
      "thinking",
      "queued",
      "sending",
      "working",
      "unknown",
      "needs_user",
      "cancel_requested",
    ].includes(detail.status);
  useEffect(() => {
    if (!chatId) return;
    let live = true;
    let reading = false;
    const refresh = () => {
      if (reading || !live) return;
      reading = true;
      void call<Conversation>("conversation.read", { id: chatId })
        .then((result) => {
          if (live && result) adoptDetail(result);
        })
        .finally(() => {
          reading = false;
        });
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    window.addEventListener("focus", refresh);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [chatId, metadata?.revision]);
  useEffect(() => {
    if (!chatId) setConfig(project.config);
  }, [JSON.stringify(project.config)]);
  useEffect(() => {
    if (detail?.messages?.length)
      endRef.current?.scrollIntoView({ block: "nearest" });
  }, [detail?.messages?.length, detail?.status]);
  useEffect(() => {
    if (questions.length === 1) setAnswerTask(questions[0].id);
    else if (!questions.some((t) => t.id === answerTask)) setAnswerTask("");
  }, [questions.map((t) => t.id).join(",")]);
  async function send() {
    if (!input.trim()) return;
    setBusy(true);
    let target = chatId || createdId;
    if (!target) {
      const created = await call<Conversation>("conversation.create", {
        projectId: project.id,
        config,
      });
      if (created) {
        target = created.id;
        setCreatedId(target);
      }
    }
    if (target) {
      const result = await call<Conversation>("conversation.send", {
        id: target,
        text: input,
        taskId: answerTask || undefined,
      });
      if (result) {
        setInput("");
        clearDraft(`conversation.${chatId || `new-${project.id}`}`);
        setAnswerTask("");
        adoptDetail(result);
        select(target);
      }
    }
    setBusy(false);
  }
  return (
    <div className="conversation-page">
      <div className="conversation-header">
        <div>
          <h1>{detail?.title || "新对话"}</h1>
          <p className="project-path" title={project.cwd}>
            {project.name} · {project.cwd}
          </p>
        </div>
        <div className="button-row">
          <button className="secondary" onClick={settings}>
            项目配置
          </button>
          <button className="secondary" onClick={agents}>
            Agent 连接
          </button>
          {canOpenCodex && (
            <button
              className="secondary"
              disabled={!desktopThread || busy}
              onClick={async () => {
                const result = await call("desktop.open-conversation", {
                  id: chatId,
                });
                if (result)
                  setDesktopNotice("已请求 Codex 桌面显示同一个原生会话");
              }}
            >
              在 Codex 桌面打开原对话
            </button>
          )}
        </div>
      </div>
      {desktopNotice && (
        <p className="hint" role="status">
          {desktopNotice}
        </p>
      )}
      <div
        className="conversation-stream"
        aria-label="对话内容"
        aria-live="polite"
      >
        {!chatId && (
          <section className="conversation-welcome">
            <span className="eyebrow">PROJECT CONVERSATION</span>
            <h2>今天想在这个项目里完成什么？</h2>
            <p>简单任务交给一个 Agent，复杂任务交给主调组织协作。</p>
            <ConfigurationFields
              value={config}
              change={setConfig}
              connections={state.connections}
            />
          </section>
        )}
        {chatId && !detail && <p className="hint">正在读取已保存的对话…</p>}
        {detail?.messages?.map((message) => (
          <article
            className={`conversation-message ${message.role}`}
            key={message.id}
          >
            <div className="message-author">
              {message.role === "user"
                ? "你"
                : message.role === "system"
                  ? "协调器"
                  : activeConfig.mode === "distributed"
                    ? "主调 Agent"
                    : "执行 Agent"}
              <time>
                {new Date(message.at).toLocaleTimeString("zh-CN", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </time>
            </div>
            <div className="message-text">
              {message.role === "assistant" ? (
                <MarkdownMessage
                  text={message.text}
                  scope={{ conversationId: chatId }}
                  copy
                />
              ) : (
                message.text
              )}
            </div>
          </article>
        ))}
        {detail?.plan && !detail.workflowId && (
          <section className="chat-plan panel">
            <h2>主调的协作计划</h2>
            <ol>
              {detail.plan.nodes.map((node) => (
                <li key={node.id}>
                  <strong>
                    {node.id} · {node.goal}
                  </strong>
                  <p>
                    {
                      state.connections.find((c) => c.id === node.connectionId)
                        ?.name
                    }{" "}
                    ·{" "}
                    {node.dependsOn.length
                      ? `等待 ${node.dependsOn.join("、")}`
                      : "无前置依赖"}
                  </p>
                  <ul>
                    {node.plan.map((step, i) => (
                      <li key={i}>{step}</li>
                    ))}
                  </ul>
                  <p>验收：{node.acceptance.join("；")}</p>
                  {!!node.contract?.verification?.length && (
                    <pre>
                      {node.contract.verification
                        .map((v) => `${v.command} ${v.args.join(" ")}`)
                        .join("\n")}
                    </pre>
                  )}
                </li>
              ))}
            </ol>
            <h3>总体验收</h3>
            <ul>
              {detail.plan.acceptance.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
            <p className="hint">
              将在 {project.cwd} 执行；同目录写入按锁串行。每项最多{" "}
              {activeConfig.maxRounds} 轮，自动答疑与审核会使用主调额度。
            </p>
            <button
              className="primary"
              disabled={busy || !!locked}
              onClick={async () => {
                setBusy(true);
                const result = await call<Conversation>("conversation.start", {
                  id: chatId,
                });
                if (result) adoptDetail(result);
                setBusy(false);
              }}
            >
              开始协作
            </button>
          </section>
        )}
        {workflow && (
          <section className="chat-workflow panel">
            <div className="section-title">
              <h2>
                执行进展 · {tasks.filter((t) => t.status === "accepted").length}
                /{tasks.length} 已验收
              </h2>
              <span className="pill">
                {workflow.status === "accepted"
                  ? "总体验收通过"
                  : workflow.automationPaused
                    ? "已暂停新工作"
                    : workflow.status === "reviewing"
                      ? "主调总体审核中"
                      : "协作进行中"}
              </span>
            </div>
            {tasks.map((task) => (
              <details key={task.id}>
                <summary>
                  {task.nodeId} · {task.goal}
                  <span>
                    {task.busy
                      ? "处理中"
                      : (
                          {
                            accepted: "已验收",
                            working: "执行中",
                            needs_input: "等待答复",
                            queued: "排队",
                            pending_review: "待主调审核",
                            failed: "失败",
                            delivery_unknown: "待核对",
                          } as Record<string, string>
                        )[task.status] || task.status}
                  </span>
                </summary>
                <p>{task.queueReason || task.automationError}</p>
                {task.result?.text ? (
                  <MarkdownMessage
                    text={task.result.text}
                    scope={{ taskId: task.id }}
                    copy
                  />
                ) : (
                  <p className="hint">尚未返回交付</p>
                )}
                <button className="secondary" onClick={() => openTask(task.id)}>
                  查看任务、会话与验证详情
                </button>
                {task.executor.type === "codex" && (
                  <button
                    className="secondary"
                    disabled={!task.contextId}
                    onClick={() =>
                      void call("desktop.open-task", { id: task.id })
                    }
                  >
                    在 Codex 桌面查看执行会话
                  </button>
                )}
              </details>
            ))}
            {workflow.status !== "accepted" && (
              <div className="button-row">
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void call(
                      workflow.automationPaused
                        ? "workflow.start"
                        : "workflow.pause",
                      { id: workflow.id },
                    )
                  }
                >
                  {workflow.automationPaused ? "继续协作" : "暂停新工作"}
                </button>
                <span className="hint">暂停不取消已在原软件运行的回合。</span>
              </div>
            )}
          </section>
        )}
        {detail?.queueReason && (
          <p className="chat-status">{detail.queueReason}</p>
        )}
        {detail?.error && <div className="warning">{detail.error}</div>}
        {detail?.progress &&
          [
            "working",
            "sending",
            "thinking",
            "unknown",
            "needs_user",
            "cancel_requested",
          ].includes(detail.status) && (
            <RunProgress
              value={detail.progress}
              showText={activeConfig.mode === "single"}
              scope={{ conversationId: chatId }}
            />
          )}
        {detail &&
          (detail.nativeThreadId || detail.contextId || detail.threadId) && (
            <details className="native-session-details">
              <summary>会话与连接信息</summary>
              <p>
                本对话使用协调器管理的原生会话，可点击上方按钮在 Codex
                桌面查看同一份记录。任务运行期间请通过协调器继续派发，避免两个入口同时发送消息。
              </p>
              <p>
                会话：
                <code>
                  {detail.nativeThreadId || detail.contextId || detail.threadId}
                </code>
              </p>
              <p>
                原生回合：<code>{detail.nativeTurnId || "尚未记录"}</code>
              </p>
            </details>
          )}
        {detail &&
          activeConfig.mode === "single" &&
          state.connections.find((c) => c.id === activeConfig.executorIds[0])
            ?.kind === "aimana" && (
            <button
              className="secondary"
              onClick={() => void call("conversation.open", { id: chatId })}
            >
              打开 AIMana 原对话
            </button>
          )}
        {detail && detail.status !== "idle" && (
          <div className="chat-status" role="status">
            {states[detail.status] || detail.status}
            {[
              "unknown",
              "needs_user",
              "cancel_requested",
              "working",
              "thinking",
            ].includes(detail.status) && (
              <button
                className="secondary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  await call("conversation.recover", { id: chatId });
                  setBusy(false);
                }}
              >
                核对原回合
              </button>
            )}
            {activeConfig.mode === "single" &&
              ["working", "queued", "needs_user"].includes(detail.status) && (
                <button
                  className="secondary"
                  onClick={() =>
                    void call("conversation.cancel", { id: chatId })
                  }
                >
                  请求停止本轮
                </button>
              )}
          </div>
        )}
        <div ref={endRef} />
      </div>
      <form
        className="conversation-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {questions.length > 0 && (
          <label>
            主调有问题需要你确认
            <select
              aria-label="答复的子任务"
              value={answerTask}
              onChange={(e) => setAnswerTask(e.target.value)}
            >
              <option value="">选择要答复的问题，或继续向主调提问</option>
              {questions.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.nodeId} · {t.userQuestion}
                </option>
              ))}
            </select>
          </label>
        )}
        <textarea
          aria-label="对话消息"
          placeholder={
            activeConfig.mode === "distributed"
              ? "向主调描述目标、补充计划或答复疑问…"
              : "描述需求，由这个 Agent 直接规划和完成…"
          }
          value={input}
          disabled={busy || !!locked}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              (e.ctrlKey || e.metaKey) &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              if (!locked && !busy) void send();
            }
          }}
        />
        <div className="composer-actions">
          <span className="hint">
            {activeConfig.mode === "distributed"
              ? "AI-Cooperation · 主调汇总与审核"
              : "单 Agent · 直接对话"}{" "}
            · Ctrl+Enter 发送{chatId && " · 本对话配置已固定"}
          </span>
          <button
            className="primary"
            type="submit"
            disabled={
              busy ||
              !!locked ||
              !input.trim() ||
              !activeConfig.executorIds.length ||
              (activeConfig.mode === "distributed" &&
                !activeConfig.coordinatorId)
            }
          >
            {busy ? "正在提交…" : "发送消息 ↑"}
          </button>
        </div>
      </form>
    </div>
  );
}
