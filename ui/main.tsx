import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  Connection,
  Contract,
  Evidence,
  Snapshot,
  Task,
  Project,
} from "./types";
import {
  DefaultConversationSettings,
  ProjectNavigation,
  ProjectDialog,
  ProjectConversation,
} from "./conversations";
import {
  ContractFields,
  defaultContract,
  TaskTools,
  WorkflowPage,
  SchedulerSettings,
  AimannaPairing,
  AimannaProfile,
  McpIntegration,
} from "./collaboration";
import "./theme.css";
import "./style.css";
import "./conversations.css";
import "./markdown.css";
import { MarkdownMessage } from "./markdown";
import { useDraftState, clearDraft } from "./drafts";
import {
  AppearanceSettings,
  applyPreferences,
  cachePreferences,
} from "./preferences";

const api = window.cooperation;
const statusNames: Record<string, string> = {
  ready: "待执行",
  sending: "正在派发",
  working: "执行中",
  needs_input: "等待答复",
  needs_user: "需要用户处理",
  pending_review: "待审核",
  revision_ready: "待返工",
  accepted: "已验收",
  failed: "执行失败",
  canceled: "已取消",
  budget_exhausted: "轮次已耗尽",
  delivery_unknown: "需核对远端",
  queued: "排队中",
  stalled: "无进展暂停",
  cancel_requested: "已请求停止",
};
const eventNames: Record<string, string> = {
  created: "任务已创建",
  execution_sending: "向执行 Agent 派发任务",
  answer_sending: "向原会话答复疑问",
  working: "执行 Agent 正在工作",
  needs_input: "执行 Agent 提出了疑问",
  pending_review: "交付已返回，等待审核",
  revision_ready: "审核要求修改，准备返工",
  accepted: "验收通过",
  budget_exhausted: "执行轮次已达到上限",
  delivery_unknown: "发送结果不确定，需核对远端",
  connection_error: "连接暂时不可用",
  coordinator_review: "Codex 正在审核",
  failed: "执行失败",
  queued: "等待调度",
  verified: "独立验证完成",
  coordinator_answer: "原主控已答复",
  question_escalated: "问题需要用户决定",
  stalled: "返工无进展，已暂停",
  integration_revision: "总体审核要求返工",
};
const time = (value: string) =>
  new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </>
    ),
    nodes: (
      <>
        <circle cx="12" cy="5" r="3" />
        <circle cx="5" cy="18" r="3" />
        <circle cx="19" cy="18" r="3" />
        <path d="m10.5 7.5-4 8m7-8 4 8M8 18h8" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    play: <path d="m9 5 11 7-11 7z" />,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    check: <path d="m5 12 4 4L19 6" />,
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 5 5" />
      </>
    ),
    close: <path d="m6 6 12 12M6 18 18 6" />,
    chat: (
      <path d="M20 15a3 3 0 0 1-3 3H9l-6 3V6a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3z" />
    ),
    file: (
      <>
        <path d="M14 3H5v18h14V8zM14 3v5h5M8 12h8M8 16h6" />
      </>
    ),
    link: (
      <>
        <path
          d="m10 14 4-4M8 16l-2 2a4 4 0 0 1-6-6l4-4m12 0 2-2a4 4 0 0 1 6 6l-4 4"
          transform="translate(1 0) scale(.92)"
        />
      </>
    ),
    refresh: (
      <>
        <path d="M20 8a8 8 0 1 0 0 9M20 3v6h-6" />
      </>
    ),
    bolt: <path d="m13 2-9 12h7l-1 8 10-13h-7z" />,
    info: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 10v7m0-10v.1" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.file}
    </svg>
  );
}
function Badge({ task }: { task: Task }) {
  return (
    <span className={`badge ${task.status}`}>
      {task.busy ? <span className="spin tiny" /> : <i />}
      {task.busy ? "处理中" : statusNames[task.status] || task.status}
    </span>
  );
}
function App() {
  const [state, setState] = useState<Snapshot>({
    tasks: [],
    connections: [],
    database: "",
    version: "0.7.2",
  });
  const [page, setPage] = useState("chats");
  const [projectId, setProjectId] = useState(() => {
    try {
      return localStorage.getItem("ai-cooperation:project") || "";
    } catch {
      return "";
    }
  });
  const [chatId, setChatId] = useState(() => {
    try {
      return localStorage.getItem("ai-cooperation:conversation") || "";
    } catch {
      return "";
    }
  });
  const [projectDialog, setProjectDialog] = useState<
    Project | null | undefined
  >(undefined);
  const snapshotRef = useRef(state);
  snapshotRef.current = state;
  function openConversation(id: string, conversation = "") {
    setProjectId(id);
    setChatId(conversation);
    setPage("chats");
  }
  useEffect(() => {
    try {
      localStorage.setItem("ai-cooperation:project", projectId);
      localStorage.setItem("ai-cooperation:conversation", chatId);
    } catch {}
  }, [projectId, chatId]);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState<"task" | "connection" | null>(null);
  const [editing, setEditing] = useState<Connection | null>(null);
  const [notice, setNotice] = useState("");
  const [offline, setOffline] = useState(false);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (state.preferences) {
      applyPreferences(state.preferences);
      cachePreferences(state.preferences);
    }
  }, [
    state.preferences?.mode,
    state.preferences?.accent,
    state.preferences?.fontScale,
    state.preferences?.notifications,
    state.preferences?.autoOpenCodex,
  ]);
  useEffect(() => {
    api
      .request<Snapshot>("snapshot")
      .then(setState)
      .catch((e) => setNotice(e.message));
    const unsubscribe = api.subscribe((snapshot) => {
      if (snapshot?.tasks && snapshot?.connections) setState(snapshot);
    });
    const stop = api.onOffline(() => setOffline(true));
    const stopNavigate = api.onNavigate((value) => {
      const chat = snapshotRef.current.conversations?.find(
        (c) =>
          c.id === value.id ||
          c.workflowIds.includes(value.id) ||
          (value.page === "tasks" &&
            snapshotRef.current.tasks.find((t) => t.id === value.id)
              ?.workflowId === c.workflowId),
      );
      if (chat) {
        openConversation(chat.projectId, chat.id);
        return;
      }
      if (value.page === "tasks") {
        setSelected(value.id);
        setPage("tasks");
      } else if (value.page === "workflows") setPage("workflows");
    });
    const draftError = () =>
      setNotice("本机草稿未能保存，请复制未提交的内容后再关闭窗口。");
    const stopWarning = api.onWarning(setNotice);
    window.addEventListener("cooperation:draft-error", draftError);
    return () => {
      unsubscribe();
      stop();
      stopNavigate();
      stopWarning();
      window.removeEventListener("cooperation:draft-error", draftError);
    };
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 7500);
    return () => clearTimeout(timer);
  }, [notice]);
  async function call<T>(
    method: string,
    data?: unknown,
  ): Promise<T | undefined> {
    try {
      return await api.request<T>(method, data);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }
  async function demo() {
    setPending(true);
    const task = await call<Task>("task.create", {
      goal: "整理项目交付清单，并补充验证步骤",
      plan: ["确认交付内容与范围", "整理交付清单", "根据审核反馈完善验证步骤"],
      acceptance: ["清单覆盖已约定的交付范围", "每项交付包含具体的验证步骤"],
      mode: "demo",
      maxRounds: 5,
    });
    if (task) {
      setSelected(task.id);
      setPage("tasks");
      await call("task.action", { id: task.id, action: "dispatch" });
    }
    setPending(false);
  }
  const current = state.tasks.find((t) => t.id === selected);
  const activeProject =
    state.projects?.find((p) => p.id === projectId) || state.projects?.[0];
  useEffect(() => {
    if (!state.projects || !state.conversations) return;
    if (projectId && !state.projects.some((p) => p.id === projectId)) {
      setProjectId(state.projects[0]?.id || "");
      setChatId("");
    } else if (
      chatId &&
      !state.conversations.some(
        (c) => c.id === chatId && c.projectId === activeProject?.id,
      )
    )
      setChatId("");
  }, [state.projects, state.conversations, projectId, chatId]);
  const actionable = state.tasks.filter((t) =>
    [
      "needs_input",
      "pending_review",
      "needs_user",
      "delivery_unknown",
      "stalled",
      "failed",
      "budget_exhausted",
      "cancel_requested",
    ].includes(t.status),
  );
  const visible = state.tasks.filter(
    (t) =>
      (filter === "all" ||
        (filter === "attention"
          ? actionable.includes(t)
          : t.status === "accepted")) &&
      t.goal.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Icon name="nodes" size={24} />
          </div>
          <div>
            <strong>AI-Cooperation</strong>
            <span>让 Agent 协作起来</span>
          </div>
        </div>
        <div className="workspace">
          <span className="workspace-icon">本</span>
          <div>
            <strong>本地工作空间</strong>
            <span>LOCAL WORKSPACE</span>
          </div>
          <span className="local-dot" />
        </div>
        <div className="nav-caption">工作空间</div>
        <nav>
          <button
            className={page === "chats" ? "active" : ""}
            onClick={() => setPage("chats")}
          >
            <Icon name="chat" />
            项目与对话
          </button>
          <button
            className={page === "tasks" ? "active" : ""}
            onClick={() => setPage("tasks")}
          >
            <Icon name="grid" />
            任务工作台<span className="nav-count">{state.tasks.length}</span>
          </button>
          <button
            className={page === "agents" ? "active" : ""}
            onClick={() => setPage("agents")}
          >
            <Icon name="nodes" />
            Agent 连接
            <span className="nav-count">{state.connections.length}</span>
          </button>
          <button
            className={page === "workflows" ? "active" : ""}
            onClick={() => setPage("workflows")}
          >
            <Icon name="nodes" />
            协作计划
            <span className="nav-count">{state.workflows?.length || 0}</span>
          </button>
          <button
            className={page === "settings" ? "active" : ""}
            onClick={() => setPage("settings")}
          >
            <Icon name="settings" />
            设置与说明
          </button>
        </nav>
        <ProjectNavigation
          call={call}
          state={state}
          projectId={activeProject?.id || ""}
          chatId={page === "chats" ? chatId : ""}
          open={openConversation}
          create={() => setProjectDialog(null)}
        />
        <div className="sidebar-note" hidden>
          <span className="small-label">协作方式</span>
          <strong>一个目标，多个 Agent</strong>
          <p>主调制定计划与审核，执行 Agent 完成具体工作。</p>
          <div className="mini-flow">
            <span>主调</span>
            <Icon name="arrow" size={14} />
            <span>协调器</span>
            <Icon name="arrow" size={14} />
            <span>执行</span>
          </div>
        </div>
        <div className="sidebar-bottom">
          <div>
            <i className={offline ? "dot offline" : "dot"} />
            <span>{offline ? "协调后台已停止" : "本地协调后台运行中"}</span>
          </div>
          <small>桌面预览版 · v{state.version}</small>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <span>
            工作空间 <b>/</b>{" "}
            {page === "chats"
              ? activeProject?.name || "项目与对话"
              : page === "tasks"
                ? "任务工作台"
                : page === "agents"
                  ? "Agent 连接"
                  : page === "workflows"
                    ? "协作计划"
                    : "设置与说明"}
          </span>
          <div>
            <span className="local-label">
              <Icon name="link" size={14} />
              本机运行
            </span>
            <span className="avatar">Z</span>
          </div>
        </header>
        <div
          className={`content ${page === "chats" ? "conversation-content" : ""}`}
        >
          {offline && (
            <div className="warning">
              后台进程已停止。请重启应用后核对远端任务状态，避免重复派发。
            </div>
          )}
          {page === "chats" &&
            (activeProject ? (
              <ProjectConversation
                key={chatId || `new-${activeProject.id}`}
                project={activeProject}
                chatId={chatId}
                state={state}
                call={call}
                select={(id) => openConversation(activeProject.id, id)}
                settings={() => setProjectDialog(activeProject)}
                agents={() => setPage("agents")}
                openTask={(id) => {
                  setSelected(id);
                  setPage("tasks");
                }}
              />
            ) : (
              <section className="project-empty">
                <div className="brand-mark">
                  <Icon name="nodes" size={26} />
                </div>
                <h1>从一个项目开始</h1>
                <p>保存工作目录，让 Agent 在项目里持续对话与协作。</p>
                <button
                  className="primary"
                  onClick={() => setProjectDialog(null)}
                >
                  添加第一个项目
                </button>
                <p className="hint">
                  支持单 Agent 直接执行，也支持主调与多个执行器协作。
                </p>
              </section>
            ))}
          {page === "tasks" && (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">YOUR AGENT WORKSPACE</span>
                  <h1>
                    任务工作台<span className="heading-dot">.</span>
                  </h1>
                  <p>从目标到交付，让每一次协作都有迹可循。</p>
                </div>
                <button className="primary" onClick={() => setModal("task")}>
                  <Icon name="plus" size={18} />
                  新建协作任务
                </button>
              </div>
              <div className="stats">
                <Stat
                  title="全部任务"
                  value={state.tasks.length}
                  icon="grid"
                  note="工作空间内的协作记录"
                />
                <Stat
                  title="正在执行"
                  value={
                    state.tasks.filter(
                      (t) =>
                        ["working", "sending"].includes(t.status) || t.busy,
                    ).length
                  }
                  icon="bolt"
                  note="由执行 Agent 处理"
                />
                <Stat
                  title="需要关注"
                  value={actionable.length}
                  icon="chat"
                  note="待答复、待审核或需核对"
                  warm
                />
                <Stat
                  title="验收完成"
                  value={
                    state.tasks.filter((t) => t.status === "accepted").length
                  }
                  icon="check"
                  note="验收记录已保存"
                />
              </div>
              <section className="demo-banner">
                <div className="banner-symbol">
                  <Icon name="nodes" size={32} />
                </div>
                <div>
                  <span className="small-label">第一次使用？</span>
                  <h3>先体验一次完整的协作</h3>
                  <p>
                    从执行提问到审核返工，用模拟任务了解整个流程。不会调用真实模型。
                  </p>
                </div>
                <button className="secondary" disabled={pending} onClick={demo}>
                  {pending ? (
                    <span className="spin" />
                  ) : (
                    <Icon name="play" size={16} />
                  )}
                  运行模拟演示
                  <Icon name="arrow" size={16} />
                </button>
              </section>
              <div className="work-area">
                <section className="task-list panel">
                  <div className="section-title">
                    <h2>
                      协作任务 <span>{state.tasks.length}</span>
                    </h2>
                    <span className="muted">
                      <Icon name="clock" size={16} />
                    </span>
                  </div>
                  <div className="tabs">
                    {[
                      ["all", "全部"],
                      ["attention", "待处理"],
                      ["done", "已完成"],
                    ].map(([key, label]) => (
                      <button
                        key={key}
                        className={filter === key ? "selected" : ""}
                        onClick={() => setFilter(key)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="search">
                    <Icon name="search" size={16} />
                    <input
                      aria-label="搜索任务"
                      placeholder="搜索任务…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
                  <div className="task-items">
                    {visible.length ? (
                      visible.map((task) => (
                        <button
                          key={task.id}
                          onClick={() => setSelected(task.id)}
                          className={`task-item ${selected === task.id ? "selected" : ""}`}
                        >
                          <div className="task-item-top">
                            <span className={`mode-tag ${task.mode}`}>
                              {task.mode === "demo" ? "模拟" : "真实"}
                            </span>
                            <small>{time(task.updatedAt)}</small>
                          </div>
                          <strong>{task.goal}</strong>
                          <div className="task-item-bottom">
                            <Badge task={task} />
                            <span>第 {task.rounds} 轮</span>
                          </div>
                        </button>
                      ))
                    ) : (
                      <div className="empty-small">
                        <Icon name="file" size={26} />
                        <p>
                          {search || filter !== "all"
                            ? "没有符合条件的任务"
                            : "你的协作记录将显示在这里"}
                        </p>
                      </div>
                    )}
                  </div>
                </section>
                {current ? (
                  <TaskDetail
                    task={current}
                    connections={state.connections}
                    tasks={state.tasks}
                    openTask={(id) => setSelected(id)}
                    call={call}
                    notify={setNotice}
                  />
                ) : (
                  <section className="task-detail panel empty-detail">
                    <div className="empty-art">
                      <Icon name="nodes" size={44} />
                      <span className="orbit one" />
                      <span className="orbit two" />
                    </div>
                    <h2>把想法交给 Agent，把进展留在这里</h2>
                    <p>
                      创建第一个任务，或运行模拟演示。
                      <br />
                      你可以在这里查看执行计划、答复疑问并审核交付。
                    </p>
                    <button
                      className="primary"
                      onClick={() => setModal("task")}
                    >
                      <Icon name="plus" size={17} />
                      创建第一个任务
                    </button>
                    <div className="empty-steps">
                      <span>
                        <i>1</i>明确目标
                      </span>
                      <Icon name="arrow" size={14} />
                      <span>
                        <i>2</i>执行协作
                      </span>
                      <Icon name="arrow" size={14} />
                      <span>
                        <i>3</i>审核交付
                      </span>
                    </div>
                  </section>
                )}
              </div>
            </>
          )}
          {page === "agents" && (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">CONNECTIONS</span>
                  <h1>
                    Agent 连接<span className="heading-dot">.</span>
                  </h1>
                  <p>连接主调与执行 Agent，为每个任务选择合适的伙伴。</p>
                </div>
                <button
                  className="primary"
                  onClick={() => {
                    setEditing(null);
                    setModal("connection");
                  }}
                >
                  <Icon name="plus" size={18} />
                  添加连接
                </button>
              </div>
              <div className="connection-tip">
                <Icon name="info" />
                <p>
                  Codex 既可主调，也可执行；同一连接可绑定独立会话。AIMana 通过
                  普通 Cowork 插件接收任务。连接测试不会自动派发任务。
                </p>
              </div>
              <AimannaPairing call={call} />
              <div className="agent-grid">
                {state.connections.map((connection) => (
                  <AgentCard
                    key={connection.id}
                    connection={connection}
                    call={call}
                    edit={() => {
                      setEditing(connection);
                      setModal("connection");
                    }}
                  />
                ))}
              </div>
              <section className="panel future">
                <Icon name="nodes" size={24} />
                <div>
                  <h3>按能力接入，而非绑定某个软件</h3>
                  <p>
                    当前支持 Codex app-server、A2A 0.3 与 ACP v1。兼容 ACP
                    的软件可共用协议驱动；具体权限与会话恢复能力以连接测试为准。
                  </p>
                </div>
              </section>
            </>
          )}
          {page === "workflows" && (
            <WorkflowPage
              state={state}
              call={call}
              openTask={(id) => {
                setSelected(id);
                setPage("tasks");
              }}
            />
          )}
          {page === "settings" && (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">PREFERENCES & ABOUT</span>
                  <h1>
                    设置与说明<span className="heading-dot">.</span>
                  </h1>
                  <p>本机运行，状态持久保存。</p>
                </div>
              </div>
              <AppearanceSettings state={state} call={call} />
              <DefaultConversationSettings
                state={state}
                call={call}
                agents={() => setPage("agents")}
              />
              <section className="panel settings-panel">
                <h2>运行与存储</h2>
                <div className="setting-row">
                  <div>
                    <strong>本地 SQLite 数据库</strong>
                    <p className="mono">{state.database || "正在连接后台…"}</p>
                  </div>
                  <button className="secondary" onClick={() => api.openData()}>
                    打开数据目录
                  </button>
                </div>
                <div className="setting-row">
                  <div>
                    <strong>后台运行方式</strong>
                    <p>
                      关闭窗口后进入系统托盘，任务继续；完全退出后不再轮询。远端任务可能仍在运行。
                    </p>
                  </div>
                  <span className="pill">普通用户进程</span>
                </div>
                <div className="setting-row">
                  <div>
                    <strong>凭据存储</strong>
                    <p>
                      A2A token 使用 Windows
                      安全存储加密，不回显到界面，不写入任务报告。
                    </p>
                  </div>
                  <span className="pill">本机加密</span>
                </div>
              </section>
              <section className="panel settings-panel">
                <h2>这个版本能做什么</h2>
                <ul className="feature-list">
                  <li>创建模拟或真实 A2A 任务，保存进度与同会话返工记录。</li>
                  <li>
                    Codex 可同时担任只读主调和工作区执行 Agent，两者会话独立。
                  </li>
                  <li>
                    保存 SQLite
                    任务历史；真实连接需要你已有的软件登录与对应权限。
                  </li>
                  <li>
                    支持子任务依赖、并发上限、工作区写入锁、主控答疑与独立验证。已有桌面聊天接管尚未实现。
                  </li>
                </ul>
              </section>
              <SchedulerSettings state={state} call={call} />
              <McpIntegration call={call} />
              <button className="danger-link" onClick={() => api.quit()}>
                完全退出 AI-Cooperation
              </button>
            </>
          )}
          <footer hidden={page === "chats"}>
            <span>AI-Cooperation · 本地 Agent 协同工作空间</span>
            <span>
              <i className="dot" /> SQLite 已启用
            </span>
          </footer>
        </div>
      </main>
      {notice && (
        <div className="toast" role="alert">
          <Icon name="info" size={18} />
          <span>
            {notice.replace(
              /^Error invoking remote method '[^']+': Error: /,
              "",
            )}
          </span>
          <button onClick={() => setNotice("")} aria-label="关闭提示">
            <Icon name="close" size={16} />
          </button>
        </div>
      )}
      {modal === "task" && (
        <NewTask
          connections={state.connections}
          call={call}
          close={() => setModal(null)}
          created={(task) => {
            setSelected(task.id);
            setPage("tasks");
            setModal(null);
          }}
        />
      )}
      {projectDialog !== undefined && (
        <ProjectDialog
          project={projectDialog || undefined}
          state={state}
          call={call}
          close={() => setProjectDialog(undefined)}
          saved={(project) => {
            setProjectDialog(undefined);
            openConversation(project.id);
          }}
        />
      )}
      {modal === "connection" && editing?.kind === "aimana" ? (
        <AimannaProfile
          connection={editing}
          call={call}
          close={() => setModal(null)}
        />
      ) : (
        modal === "connection" && (
          <ConnectionForm
            connection={editing}
            call={call}
            close={() => setModal(null)}
          />
        )
      )}
    </div>
  );
}

function Stat({
  title,
  value,
  icon,
  note,
  warm,
}: {
  title: string;
  value: number;
  icon: string;
  note: string;
  warm?: boolean;
}) {
  return (
    <section className="stat panel">
      <div>
        <span>{title}</span>
        <span className={`stat-icon ${warm ? "warm" : ""}`}>
          <Icon name={icon} size={19} />
        </span>
      </div>
      <strong>
        {value}
        <small>项</small>
      </strong>
      <p>{note}</p>
    </section>
  );
}
type Call = <T>(method: string, data?: unknown) => Promise<T | undefined>;
function TaskDetail({
  task,
  connections,
  call,
  notify,
  tasks,
  openTask,
}: {
  task: Task;
  connections: Connection[];
  call: Call;
  notify: (message: string) => void;
  tasks: Task[];
  openTask: (id: string) => void;
}) {
  const [tab, setTab] = useState("overview");
  const [answer, setAnswer] = useState("");
  const [feedback, setFeedback] = useState("");
  const [references, setReferences] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setAnswer("");
    setFeedback("");
    setReferences({});
    setTab("overview");
  }, [task.id]);
  async function act(action: string, data = {}) {
    setBusy(true);
    const value = await call("task.action", { id: task.id, action, data });
    setBusy(false);
    if (value && action === "answer") setAnswer("");
    return value;
  }
  const disabled = busy || task.busy;
  const executor =
    task.mode === "demo"
      ? "内置模拟 Agent"
      : connections.find((c) => c.id === task.executor.connectionId)?.name ||
        "A2A 执行器";
  return (
    <section className="task-detail panel">
      <div className="detail-heading">
        <div>
          <div className="detail-kicker">
            <span className={`mode-tag ${task.mode}`}>
              {task.mode === "demo"
                ? "模拟任务 · 未调用真实模型"
                : "真实 Agent 任务"}
            </span>
            <Badge task={task} />
          </div>
          <h2>{task.goal}</h2>
        </div>
        <button
          className="icon-button"
          aria-label="刷新任务状态"
          onClick={() => act("poll")}
          disabled={disabled}
        >
          <Icon name="refresh" size={17} />
        </button>
      </div>
      <div className="detail-meta">
        <span>
          <Icon name="nodes" size={15} />
          {executor}
        </span>
        <span>
          <Icon name="refresh" size={14} />
          {task.rounds} / {task.maxRounds} 轮
        </span>
        <span>
          <Icon name="clock" size={14} />
          {time(task.updatedAt)}
        </span>
      </div>
      <div className="tabs detail-tabs">
        {[
          ["overview", "计划与交付"],
          ["events", `活动记录 ${task.events.length}`],
          ["reviews", `审核历史 ${task.reviews.length}`],
        ].map(([key, label]) => (
          <button
            key={key}
            className={tab === key ? "selected" : ""}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="detail-body">
        {tab === "overview" && (
          <>
            <div className="subheading">
              <Icon name="file" size={17} />
              <h3>执行计划</h3>
              <span>{task.plan.length} 个步骤</span>
            </div>
            <ol className="plan-list">
              {task.plan.map((step, index) => (
                <li key={index}>
                  <span>{index + 1}</span>
                  <p>{step}</p>
                </li>
              ))}
            </ol>
            <div className="subheading">
              <Icon name="check" size={17} />
              <h3>验收标准</h3>
            </div>
            <div className="criteria">
              {task.acceptance.map((c) => (
                <div key={c.id}>
                  <span>{c.id}</span>
                  <p>{c.text}</p>
                </div>
              ))}
            </div>
            <TaskTools task={task} call={call} />
            {task.busy && (
              <p className="hint" role="status">
                {task.status === "pending_review"
                  ? "主控正在审核交付，其他执行器仍可继续工作。"
                  : task.status === "needs_input"
                    ? "正在处理执行器疑问，请稍候。"
                    : "正在处理该任务，请稍候。"}
              </p>
            )}
            {!!task.queueBlockers?.length && (
              <div className="verification-report">
                <strong>正在等待以下任务</strong>
                <div className="button-row">
                  {task.queueBlockers.map((id) => {
                    const peer = tasks.find((t) => t.id === id);
                    return (
                      <button
                        className="secondary"
                        key={id}
                        onClick={() => openTask(id)}
                      >
                        {peer?.nodeId || "任务"} · {peer?.goal || id} ·{" "}
                        {peer ? statusNames[peer.status] || peer.status : ""}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {task.result?.text && (
              <>
                <div className="subheading">
                  <Icon
                    name={task.status === "needs_input" ? "chat" : "file"}
                    size={17}
                  />
                  <h3>
                    {task.status === "needs_input"
                      ? "Agent 的疑问"
                      : "执行器回报"}
                  </h3>
                </div>
                <div
                  className={`report ${task.status === "needs_input" ? "question" : ""}`}
                >
                  <MarkdownMessage
                    text={task.result.text}
                    scope={{ taskId: task.id }}
                    copy
                  />
                </div>
              </>
            )}
            {task.status === "needs_input" && (
              <div className="action-box">
                <label htmlFor="answer">答复并继续原会话</label>
                <textarea
                  id="answer"
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  placeholder="补充执行 Agent 需要的信息…"
                />
                <button
                  className="primary"
                  disabled={disabled || !answer.trim()}
                  onClick={() => act("answer", { text: answer })}
                >
                  <Icon name="arrow" size={16} />
                  发送答复
                </button>
              </div>
            )}
            {task.status === "pending_review" && (
              <div className="action-box review-box">
                <div className="subheading">
                  <h3>审核这次交付</h3>
                  {task.coordinatorId && (
                    <button
                      className="secondary compact"
                      disabled={disabled}
                      onClick={() => act("codex-review")}
                    >
                      <Icon name="bolt" size={15} />
                      交给 Codex 审核
                    </button>
                  )}
                </div>
                <p className="hint">
                  对照实际产物填写验收证据。模拟任务中的审核仅用于体验流程。
                </p>
                <label htmlFor="feedback">审核意见 / 修改要求</label>
                <textarea
                  id="feedback"
                  placeholder="说明通过的依据，或列出需要修改的内容…"
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                />
                {task.acceptance.map((c) => (
                  <label className="evidence-label" key={c.id}>
                    {c.id} · 验收证据
                    <input
                      aria-label={`${c.id} 验收证据`}
                      placeholder="文件、测试结果或其他独立验证依据"
                      value={references[c.id] || ""}
                      onChange={(e) =>
                        setReferences({ ...references, [c.id]: e.target.value })
                      }
                    />
                  </label>
                ))}
                <div className="button-row">
                  <button
                    className="secondary"
                    disabled={disabled || !feedback.trim()}
                    onClick={() =>
                      act("review", { decision: "revise", feedback })
                    }
                  >
                    要求修改
                  </button>
                  <button
                    className="primary"
                    disabled={
                      disabled ||
                      !feedback.trim() ||
                      task.acceptance.some((c) => !references[c.id]?.trim())
                    }
                    onClick={() =>
                      act("review", {
                        decision: "accept",
                        feedback,
                        evidence: task.acceptance.map((c) => ({
                          criterionId: c.id,
                          passed: true,
                          reference: references[c.id],
                        })) as Evidence[],
                      })
                    }
                  >
                    <Icon name="check" size={16} />
                    验收通过
                  </button>
                </div>
              </div>
            )}
            {["ready", "revision_ready"].includes(task.status) && (
              <div className="next-action">
                <p>
                  {task.status === "revision_ready"
                    ? "修改要求已保存，继续发送给原来的执行会话。"
                    : "计划已保存，准备交给执行 Agent。"}
                </p>
                <button
                  className="primary"
                  disabled={disabled}
                  onClick={() => act("dispatch")}
                >
                  <Icon name="play" size={15} />
                  {task.status === "revision_ready"
                    ? "在原会话继续返工"
                    : "开始执行"}
                </button>
              </div>
            )}
            {task.status === "accepted" && (
              <div className="success">
                <Icon name="check" />
                <div>
                  <strong>任务已验收</strong>
                  <p>
                    交付与审核记录已保存。
                    {task.mode === "demo" ? "此任务为模拟演示。" : ""}
                  </p>
                </div>
              </div>
            )}
            {[
              "delivery_unknown",
              "failed",
              "needs_user",
              "budget_exhausted",
            ].includes(task.status) && (
              <div className="warning">
                {task.status === "delivery_unknown"
                  ? "发送结果不确定，请先核对远端会话。系统不会盲目重发。"
                  : task.status === "budget_exhausted"
                    ? "执行轮次已耗尽，任务尚未通过验收。"
                    : task.status === "needs_user"
                      ? "远端需要用户处理授权或认证，请在原软件中处理后刷新。"
                      : "执行器报告失败，请查看回报和活动记录。"}
              </div>
            )}
            <details className="session-details">
              <summary>查看会话绑定</summary>
              <div>
                {task.executor.cwd && (
                  <>
                    <span>执行目录</span>
                    <code>{task.executor.cwd}</code>
                  </>
                )}
                <span>主调会话</span>
                <code>{task.ownerThreadId}</code>
                <span>执行上下文</span>
                <code>{task.contextId || "派发后建立"}</code>
                {task.executor.type === "aimana" && (
                  <>
                    <span>AIMana Agent</span>
                    <code>{task.executor.agentId}</code>
                    <span>请求模型</span>
                    <code>{task.executor.model}</code>
                    <span>AIMana 会话报告模型</span>
                    <code>
                      {task.result?.remote?.metadata?.actualModel ||
                        "等待原生状态"}
                    </code>
                  </>
                )}
                <span>远端任务</span>
                <code>{task.remoteTaskId || "尚未创建"}</code>
                <span>任务 ID</span>
                <code>{task.id}</code>
              </div>
            </details>
          </>
        )}
        {tab === "events" && (
          <div className="timeline">
            {[...task.events].reverse().map((event) => (
              <div key={event.seq} className="timeline-item">
                <i />
                <div>
                  <strong>
                    {eventNames[event.type] ||
                      statusNames[event.type] ||
                      event.type}
                  </strong>
                  {event.message && <p>{event.message}</p>}
                  <small>{time(event.at)}</small>
                </div>
              </div>
            ))}
          </div>
        )}
        {tab === "reviews" &&
          (task.reviews.length ? (
            <div className="review-history">
              {[...task.reviews].reverse().map((review, index) => (
                <article key={index}>
                  <span
                    className={`pill ${review.decision === "accept" ? "green" : ""}`}
                  >
                    {review.decision === "accept" ? "验收通过" : "要求修改"}
                  </span>
                  <small>第 {review.round} 轮</small>
                  <p>{review.feedback}</p>
                  {review.evidence.map((e) => (
                    <div className="hint" key={e.criterionId}>
                      {e.criterionId}：{e.reference}
                    </div>
                  ))}
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-small">
              <Icon name="check" size={28} />
              <p>交付返回后，这里将记录每一次审核决定。</p>
            </div>
          ))}
      </div>
      {disabled && (
        <div className="working-bar">
          <span className="spin tiny" />
          正在处理，请等待回报…
        </div>
      )}
    </section>
  );
}

function Modal({
  title,
  subtitle,
  close,
  children,
}: {
  title: string;
  subtitle: string;
  close: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-heading">
          <div>
            <h2>{title}</h2>
            <p>{subtitle}</p>
          </div>
          <button
            className="icon-button"
            aria-label="关闭对话框"
            onClick={close}
          >
            <Icon name="close" />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
function NewTask({
  connections,
  call,
  close,
  created,
}: {
  connections: Connection[];
  call: Call;
  close: () => void;
  created: (task: Task) => void;
}) {
  const [mode, setMode] = useDraftState<"demo" | "real">(
    "task.mode",
    "demo",
    (v) => v === "demo" || v === "real",
  );
  const [goal, setGoal] = useDraftState("task.goal", "");
  const [plan, setPlan] = useDraftState("task.plan", "");
  const [acceptance, setAcceptance] = useDraftState("task.acceptance", "");
  const [coordinatorId, setCoordinator] = useDraftState(
    "task.coordinator",
    connections.find((c) => c.kind === "codex")?.id || "",
  );
  const [connectionId, setConnection] = useDraftState(
    "task.executor",
    connections.find((c) => c.kind === "a2a")?.id ||
      connections.find((c) => c.kind === "codex")?.id ||
      "",
  );
  const initialExecutor =
    connections.find((c) => c.kind === "a2a") ||
    connections.find((c) => c.kind === "codex");
  const [workspace, setWorkspace] = useDraftState(
    "task.workspace",
    initialExecutor?.cwd || "",
  );
  const selectedExecutor = connections.find((c) => c.id === connectionId);
  const [binding, setBinding] = useDraftState<{
    threadId: string;
    goal: string;
  } | null>(
    "task.binding",
    null,
    (v) =>
      v === null ||
      (typeof v === "object" &&
        v !== null &&
        typeof (v as { threadId?: unknown }).threadId === "string" &&
        typeof (v as { goal?: unknown }).goal === "string"),
  );
  const [autoReview, setAutoReview] = useDraftState("task.auto", false);
  const [contract, setContract] = useDraftState<Contract>(
    "task.contract",
    defaultContract,
    (v) =>
      !!v &&
      typeof v === "object" &&
      Array.isArray((v as Contract).verification) &&
      Array.isArray((v as Contract).allowedPaths),
  );
  const [maxRounds, setRounds] = useDraftState("task.rounds", 5);
  const [busy, setBusy] = useState(false);
  const lines = (value: string) =>
    value
      .split("\n")
      .map((v) => v.trim())
      .filter(Boolean);
  async function analyze() {
    setBusy(true);
    const result = await call<{
      plan: string[];
      acceptance: string[];
      threadId: string;
    }>("task.analyze", { goal, coordinatorId, workspace });
    if (result) {
      setPlan(result.plan.join("\n"));
      setAcceptance(result.acceptance.join("\n"));
      setBinding({ threadId: result.threadId, goal });
    }
    setBusy(false);
  }
  async function create() {
    setBusy(true);
    const task = await call<Task>("task.create", {
      goal,
      plan: lines(plan),
      acceptance: lines(acceptance),
      mode,
      connectionId,
      workspace: workspace || undefined,
      contract: {
        ...contract,
        autoAnswer: Boolean(
          binding &&
            binding.goal === goal &&
            mode === "real" &&
            contract.autoAnswer,
        ),
      },
      coordinatorId:
        binding?.goal === goal && mode === "real" ? coordinatorId : undefined,
      threadId:
        binding?.goal === goal && mode === "real"
          ? binding.threadId
          : undefined,
      maxRounds,
      autoReview: mode === "real" && autoReview,
    });
    setBusy(false);
    if (task) {
      clearDraft("task.");
      created(task);
    }
  }
  return (
    <Modal
      title="新建协作任务"
      subtitle="明确目标与验收标准，再交给 Agent 执行。"
      close={() => {
        if (!busy) close();
      }}
    >
      <div className="modal-body">
        <div className="mode-switch">
          <button
            className={mode === "demo" ? "selected" : ""}
            onClick={() => setMode("demo")}
          >
            模拟演示
          </button>
          <button
            className={mode === "real" ? "selected" : ""}
            onClick={() => setMode("real")}
          >
            真实 Agent
          </button>
        </div>
        <p className="hint">
          {mode === "demo"
            ? "本地模拟任务流，不调用真实模型或修改项目文件。"
            : "主调与执行可以都选 Codex，使用独立会话；也可以交给 AIMana Cowork、ACP 或 A2A 执行器。"}
        </p>
        <label>
          任务目标
          <textarea
            aria-label="任务目标"
            placeholder="你希望 Agent 完成什么？请包含具体范围和预期结果。"
            value={goal}
            onChange={(e) => {
              setGoal(e.target.value);
              setAutoReview(false);
            }}
          />
        </label>
        {mode === "real" && (
          <div className="form-two">
            <label>
              主调 Agent
              <select
                aria-label="主调 Agent"
                value={coordinatorId}
                onChange={(e) => {
                  setCoordinator(e.target.value);
                  setBinding(null);
                  setAutoReview(false);
                }}
              >
                {connections
                  .filter((c) => c.kind === "codex")
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              执行 Agent
              <select
                aria-label="执行 Agent"
                value={connectionId}
                onChange={(e) => {
                  setConnection(e.target.value);
                  setWorkspace(
                    connections.find((c) => c.id === e.target.value)?.cwd || "",
                  );
                }}
              >
                <option value="">请选择执行 Agent</option>
                {connections
                  .filter((c) =>
                    ["a2a", "codex", "acp", "aimana"].includes(c.kind),
                  )
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ·{" "}
                      {c.kind === "codex"
                        ? "Codex"
                        : c.kind === "aimana"
                          ? "AIMana Cowork"
                          : c.kind === "acp"
                            ? "ACP"
                            : "A2A"}
                    </option>
                  ))}
              </select>
            </label>
          </div>
        )}
        {mode === "real" && selectedExecutor && (
          <>
            <label>
              {selectedExecutor.kind === "a2a"
                ? "本地产物目录（可选）"
                : "执行工作目录"}
              <div className="input-action">
                <input
                  aria-label="执行工作目录"
                  value={workspace}
                  onChange={(e) => setWorkspace(e.target.value)}
                  placeholder="选择允许执行 Agent 修改的具体项目文件夹"
                />
                <button
                  className="secondary"
                  onClick={async () => {
                    const value = await api.pickDirectory();
                    if (value) setWorkspace(value);
                  }}
                >
                  选择目录
                </button>
              </div>
            </label>
            <p className="hint">
              {selectedExecutor.kind === "codex"
                ? "执行 Codex 使用工作区写入沙箱，主控只读，两者会话独立。"
                : selectedExecutor.kind === "aimana"
                  ? "在指定 AIMana Agent 的普通 Cowork 会话中执行；权限请求在 AIMana 原界面处理。目录需已添加到 AIMana。"
                  : selectedExecutor.kind === "acp"
                    ? "ACP 的实际文件权限由目标软件管理，请为本地执行器选择明确的工作目录。"
                    : "该目录仅供协调器检查本地产物和防止任务冲突，不会更改 AIMana 内部的工作目录；请选择与远端实际配置对应的目录。"}
            </p>
          </>
        )}
        {mode === "real" && !connectionId && (
          <div className="warning">
            尚未选择执行 Agent。可以选择本机 Codex，无需先配置 AIMana。
          </div>
        )}
        {mode === "real" &&
          selectedExecutor?.kind !== "a2a" &&
          !workspace.trim() && (
            <div className="warning">
              还不能开工：请选择执行工作目录，再创建任务。
            </div>
          )}
        <div className="field-title">
          <strong>执行计划与验收</strong>
          {mode === "real" && (
            <button
              className="secondary compact"
              disabled={busy || !goal.trim() || !coordinatorId}
              onClick={analyze}
            >
              {busy ? (
                <span className="spin tiny" />
              ) : (
                <Icon name="bolt" size={14} />
              )}
              让 Codex 制定计划
            </button>
          )}
        </div>
        <label>
          执行计划 <span className="hint">每行一个步骤</span>
          <textarea
            aria-label="执行计划"
            placeholder={"了解目标与当前情况\n完成范围内的修改\n验证并汇报结果"}
            value={plan}
            onChange={(e) => setPlan(e.target.value)}
          />
        </label>
        <label>
          验收标准 <span className="hint">每行一项</span>
          <textarea
            aria-label="验收标准"
            placeholder={"结果符合指定范围\n提供可检查的产物和验证证据"}
            value={acceptance}
            onChange={(e) => setAcceptance(e.target.value)}
          />
        </label>
        <div className="form-two">
          <label>
            最大执行轮次
            <input
              type="number"
              min={1}
              max={100}
              value={maxRounds}
              onChange={(e) => setRounds(Number(e.target.value))}
            />
          </label>
          {mode === "real" && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                disabled={!binding || binding.goal !== goal}
                checked={autoReview}
                onChange={(e) => setAutoReview(e.target.checked)}
              />
              <span>
                由 Codex 自动审核并返工<small>需先使用 Codex 制定计划</small>
              </span>
            </label>
          )}
        </div>
        {mode === "real" && (
          <ContractFields
            value={contract}
            change={setContract}
            coordinator={Boolean(binding && binding.goal === goal)}
          />
        )}
      </div>
      <div className="modal-footer">
        <button className="secondary" disabled={busy} onClick={close}>
          取消
        </button>
        <button
          className="primary"
          disabled={
            busy ||
            !goal.trim() ||
            !lines(plan).length ||
            !lines(acceptance).length ||
            !maxRounds ||
            (mode === "real" &&
              (!connectionId ||
                (selectedExecutor?.kind === "codex" && !workspace.trim())))
          }
          onClick={create}
        >
          {busy ? (
            <span className="spin tiny" />
          ) : (
            <Icon name="plus" size={16} />
          )}
          创建任务
        </button>
      </div>
    </Modal>
  );
}
function AgentCard({
  connection,
  call,
  edit,
}: {
  connection: Connection;
  call: Call;
  edit: () => void;
}) {
  const [testing, setTesting] = useState(false);
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  async function testConnection() {
    setTesting(true);
    const result = await call<{ models?: { id: string; name: string }[] }>(
      "connection.test",
      { id: connection.id },
    );
    if (result?.models) setModels(result.models);
    setTesting(false);
  }
  return (
    <section className="panel agent-card">
      <div className="agent-card-heading">
        <div className={`agent-logo ${connection.kind}`}>
          <Icon
            name={connection.kind === "codex" ? "bolt" : "nodes"}
            size={24}
          />
        </div>
        <span
          className={`pill ${connection.status === "connected" ? "green" : connection.status === "error" ? "red" : ""}`}
        >
          {testing
            ? "测试中…"
            : connection.status === "connected"
              ? "连接可用"
              : connection.status === "error"
                ? "连接失败"
                : "未测试"}
        </span>
      </div>
      <h2>{connection.name}</h2>
      <span className="small-label">
        {connection.kind === "codex"
          ? "主调 / 执行 · CODEX APP-SERVER"
          : connection.kind === "aimana"
            ? "执行 · AIMANA COWORK"
            : connection.kind === "acp"
              ? "执行 · ACP v1"
              : "执行 · A2A 0.3"}
      </span>
      <p className="connection-address">
        {connection.kind === "aimana"
          ? "AIMana++ · 普通 Cowork 会话桥"
          : connection.kind !== "a2a"
            ? connection.command
            : connection.endpoint}
      </p>
      {connection.kind === "aimana" && (
        <p className="hint">
          Agent：{connection.agentName || "待选择"} · 目录：
          {connection.cwd || "待选择"}
        </p>
      )}
      <div className="agent-meta">
        <span>模型</span>
        <strong>
          {connection.model ||
            (connection.kind === "a2a"
              ? "使用远端 Agent 配置"
              : "使用 Codex 默认配置")}
        </strong>
      </div>
      {connection.kind === "a2a" && (
        <div className="agent-meta">
          <span>访问凭据</span>
          <strong>{connection.hasToken ? "已加密保存" : "尚未配置"}</strong>
        </div>
      )}
      {connection.lastMessage && (
        <p
          className={`connection-result ${connection.status === "error" ? "error" : ""}`}
        >
          {connection.lastMessage}
        </p>
      )}
      {models.length > 0 && (
        <p className="hint">
          已发现 {models.length} 个模型：
          {models
            .slice(0, 4)
            .map((m) => m.name)
            .join("、")}
          {models.length > 4 ? "…" : ""}
        </p>
      )}
      <div className="button-row">
        <button className="secondary" onClick={edit}>
          配置连接
        </button>
        <button className="primary" disabled={testing} onClick={testConnection}>
          {testing ? (
            <span className="spin tiny" />
          ) : (
            <Icon name="link" size={15} />
          )}
          测试连接
        </button>
      </div>
    </section>
  );
}
function ConnectionForm({
  connection,
  call,
  close,
}: {
  connection: Connection | null;
  call: Call;
  close: () => void;
}) {
  const [kind, setKind] = useState<"a2a" | "codex" | "acp">(
    connection?.kind === "aimana" ? "a2a" : connection?.kind || "a2a",
  );
  const [args, setArgs] = useState(JSON.stringify(connection?.args || []));
  const [argsError, setArgsError] = useState(false);
  const [name, setName] = useState(connection?.name || "");
  const [endpoint, setEndpoint] = useState(connection?.endpoint || "");
  const [command, setCommand] = useState(connection?.command || "codex.exe");
  const [model, setModel] = useState(connection?.model || "");
  const [cwd, setCwd] = useState(connection?.cwd || "");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    let parsedArgs: unknown = [];
    try {
      parsedArgs = JSON.parse(args);
      if (
        !Array.isArray(parsedArgs) ||
        parsedArgs.some((v) => typeof v !== "string")
      )
        throw new Error();
    } catch {
      setArgsError(true);
      return;
    }
    setBusy(true);
    const result = await call("connection.save", {
      id: connection?.id,
      name,
      kind,
      endpoint: kind === "a2a" ? endpoint : undefined,
      command: kind !== "a2a" ? command : undefined,
      model: kind !== "a2a" ? model : undefined,
      cwd: kind !== "a2a" ? cwd : undefined,
      args: kind === "acp" ? parsedArgs : undefined,
      token: kind === "a2a" ? token : undefined,
    });
    setBusy(false);
    if (result) close();
  }
  return (
    <Modal
      title={connection ? "配置 Agent 连接" : "添加 Agent 连接"}
      subtitle="使用软件已有接口连接，本应用不会自动启用远端服务。"
      close={() => {
        if (!busy) close();
      }}
    >
      <div className="modal-body">
        <label>
          连接名称
          <input
            aria-label="连接名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：AIMana 项目执行 Agent"
          />
        </label>
        <label>
          连接类型
          <select
            aria-label="连接类型"
            disabled={Boolean(connection)}
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as "a2a" | "codex" | "acp");
              if (e.target.value === "acp") setCommand("");
            }}
          >
            <option value="a2a">A2A 0.3 · 执行 Agent</option>
            <option value="codex">Codex app-server · 主调或执行</option>
            <option value="acp">ACP v1 · 通用执行 Agent</option>
          </select>
        </label>
        {kind === "a2a" ? (
          <>
            <label>
              A2A 接口地址
              <input
                aria-label="A2A 接口地址"
                placeholder="http://127.0.0.1:43119/a2a/v0.3/agents/你的AgentID"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
              />
            </label>
            <p className="hint">
              在 AIMana 的原生 A2A 设置中启用目标
              Agent，并复制它实际显示的接口地址。Agent Card 地址请去掉末尾的
              /.well-known/agent-card.json。
            </p>
            <label>
              Agent 连接凭据（A2A Token）
              <input
                aria-label="访问 Token"
                type="password"
                autoComplete="new-password"
                placeholder={
                  connection?.hasToken
                    ? "已保存，留空则保持原凭据"
                    : "输入该 Agent 的 A2A token"
                }
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </label>
            <p className="hint">
              这是本地 Agent 连接凭据，与 AIMana 账号额度、模型 API key
              无关。只保存在本机加密文件中。支持粘贴完整 Agent Card 地址。
            </p>
          </>
        ) : (
          <>
            <label>
              {kind === "acp" ? "ACP 程序路径" : "Codex 程序路径"}
              <input
                aria-label="Codex 程序路径"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="codex.exe 或完整路径"
              />
            </label>
            {kind === "acp" && (
              <label>
                启动参数（JSON 数组）
                <input
                  aria-label="ACP 启动参数"
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                  placeholder={'["--acp"]'}
                />
                <small>
                  使用目标软件官方 ACP 启动参数；沿用该软件已有登录。ACP
                  不提供统一沙箱，权限由目标软件管理。
                </small>
              </label>
            )}
            {argsError && (
              <p role="alert" className="warning">
                启动参数必须是字符串 JSON 数组，例如 ["--acp"]。
              </p>
            )}
            <label>
              模型（可选）
              <input
                aria-label="模型"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="留空使用已有 Codex 配置；测试连接可查看模型列表"
              />
            </label>
            <label>
              工作目录（可选）
              <div className="input-action">
                <input
                  aria-label="工作目录"
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                  placeholder="默认项目目录；执行时也可为任务单独选择"
                />
                <button
                  className="secondary"
                  onClick={async () => {
                    const value = await api.pickDirectory();
                    if (value) setCwd(value);
                  }}
                >
                  选择
                </button>
              </div>
            </label>
            <p className="hint">
              使用本机 Codex
              已有登录。同一连接可用于主调或执行；主调会话只读，执行会话限定在选定工作目录中写入，两者彼此独立。
            </p>
          </>
        )}
      </div>
      <div className="modal-footer">
        <button className="secondary" disabled={busy} onClick={close}>
          取消
        </button>
        <button
          className="primary"
          disabled={
            busy ||
            !name.trim() ||
            (kind === "a2a" ? !endpoint.trim() : !command.trim())
          }
          onClick={save}
        >
          {busy && <span className="spin tiny" />}保存连接
        </button>
      </div>
    </Modal>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
