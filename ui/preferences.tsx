import { useEffect, useRef, useState } from "react";
import type { Snapshot } from "./types";
import { clearDraft } from "./drafts";

export interface Preferences {
  mode: "system" | "light" | "dark";
  accent: "green" | "blue" | "purple" | "orange";
  fontScale: 1 | 1.15 | 1.3 | 1.5;
  notifications: boolean;
}
export const defaults: Preferences = {
  mode: "system",
  accent: "green",
  fontScale: 1.15,
  notifications: true,
};
const cacheKey = "ai-cooperation:preferences:v1";
let current = defaults;
export function applyPreferences(value: Preferences) {
  current = value;
  const root = document.documentElement;
  root.dataset.theme =
    value.mode === "system"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : value.mode;
  root.dataset.accent = value.accent;
  root.style.setProperty("--font-scale", String(value.fontScale));
}
export function cachePreferences(value: Preferences) {
  try {
    localStorage.setItem(cacheKey, JSON.stringify(value));
  } catch {}
}
// Apply a validated cache before React renders; SQLite remains authoritative.
try {
  const value = JSON.parse(localStorage.getItem(cacheKey) || "null");
  if (
    value &&
    ["system", "light", "dark"].includes(value.mode) &&
    ["green", "blue", "purple", "orange"].includes(value.accent) &&
    [1, 1.15, 1.3, 1.5].includes(value.fontScale) &&
    typeof value.notifications === "boolean"
  )
    current = value;
} catch {}
applyPreferences(current);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (current.mode === "system") applyPreferences(current);
});

export function AppearanceSettings({
  state,
  call,
}: {
  state: Snapshot;
  call: <T>(method: string, data?: unknown) => Promise<T | undefined>;
}) {
  const saved = state.preferences || defaults;
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const [draft, setDraft] = useState<Preferences>(saved);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  useEffect(() => {
    setDraft(saved);
  }, [saved.mode, saved.accent, saved.fontScale, saved.notifications]);
  useEffect(() => {
    applyPreferences(draft);
  }, [draft]);
  useEffect(() => {
    void call("preferences.preview", { mode: draft.mode });
  }, [draft.mode]);
  useEffect(
    () => () => {
      applyPreferences(savedRef.current);
      void window.cooperation
        .request("preferences.preview", { mode: savedRef.current.mode })
        .catch(() => {});
    },
    [],
  );
  function update(patch: Partial<Preferences>) {
    setDraft((value) => ({ ...value, ...patch }));
    setMessage("");
  }
  async function save() {
    setBusy(true);
    const result = await call<Preferences>("preferences.save", draft);
    if (result) {
      savedRef.current = result;
      cachePreferences(result);
      setMessage("设置已保存");
    } else setMessage("保存失败，外观仍为预览。请重试保存。");
    setBusy(false);
  }
  return (
    <>
      <section
        className="panel settings-panel appearance-settings"
        aria-label="外观与通知设置"
      >
        <h2>外观与通知</h2>
        <p className="hint">
          外观立即预览，点击保存后下次启动仍保留。离开此页会恢复已保存的外观。
        </p>
        <fieldset disabled={busy || !state.preferences}>
          <div className="setting-row">
            <div>
              <strong>明暗模式</strong>
              <p>跟随 Windows，或固定使用浅色、深色。</p>
            </div>
            <select
              aria-label="明暗模式"
              value={draft.mode}
              onChange={(e) =>
                update({ mode: e.target.value as Preferences["mode"] })
              }
            >
              <option value="system">跟随系统</option>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </div>
          <div className="setting-row">
            <div>
              <strong>主题颜色</strong>
              <p>用于主按钮、导航和选中状态；任务警告保留独立颜色。</p>
            </div>
            <div className="accent-options" role="group" aria-label="主题颜色">
              {(
                [
                  ["green", "森林绿"],
                  ["blue", "海洋蓝"],
                  ["purple", "紫罗兰"],
                  ["orange", "琥珀橙"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className="accent-option"
                  data-swatch={value}
                  aria-pressed={draft.accent === value}
                  onClick={() => update({ accent: value })}
                >
                  <i aria-hidden="true" />
                  {label}
                  {draft.accent === value && <span aria-hidden="true"> ✓</span>}
                </button>
              ))}
            </div>
          </div>
          <div className="setting-row">
            <div>
              <strong>字体大小</strong>
              <p>全局文字同步缩放，适用于列表、表单、报告和弹窗。</p>
            </div>
            <select
              aria-label="字体大小"
              value={draft.fontScale}
              onChange={(e) =>
                update({
                  fontScale: Number(e.target.value) as Preferences["fontScale"],
                })
              }
            >
              <option value="1">紧凑 · 100%</option>
              <option value="1.15">标准 · 115%（推荐）</option>
              <option value="1.3">较大 · 130%</option>
              <option value="1.5">大号 · 150%</option>
            </select>
          </div>
          <div className="appearance-preview">
            <strong>协作任务预览</strong>
            <p>执行 Agent 完成交付后，主控会根据计划和验收标准审核。</p>
            <div className="button-row">
              <span className="badge accepted">已验收</span>
              <span className="badge needs_user">需要你处理</span>
              <span className="preview-button">主题色预览</span>
            </div>
          </div>
          <div className="setting-row">
            <div>
              <strong>桌面通知</strong>
              <p>
                提醒人工待办与计划完成；点击通知可回到任务。实际显示受 Windows
                通知设置影响。
              </p>
            </div>
            <label className="checkbox-label notification-choice">
              <input
                type="checkbox"
                checked={draft.notifications}
                onChange={(e) => update({ notifications: e.target.checked })}
              />
              启用桌面通知
            </label>
          </div>
          <div className="button-row settings-actions">
            <button className="primary" disabled={!dirty} onClick={save}>
              {busy ? "正在保存…" : "保存设置"}
            </button>
            <button
              className="secondary"
              onClick={() => {
                setDraft({ ...defaults });
                setMessage("默认设置已预览，请点击保存。");
              }}
            >
              恢复默认设置
            </button>
            {dirty && <span className="hint">有未保存的设置</span>}
          </div>
        </fieldset>
        <p className="hint" role="status">
          {message}
        </p>
      </section>
      <section className="panel settings-panel">
        <h2>草稿管理</h2>
        <div className="setting-row">
          <div>
            <strong>未提交的任务与协作计划</strong>
            <p>
              草稿保存在当前电脑。清理仅移除未提交表单，已创建的任务、会话与历史记录保留。
            </p>
          </div>
          <button className="secondary" onClick={() => setConfirmClear(true)}>
            清空未提交草稿
          </button>
        </div>
        {confirmClear && (
          <div className="draft-confirm" role="group" aria-label="确认清理草稿">
            <p>确认清空所有未提交草稿？此操作无法撤销。</p>
            <div className="button-row">
              <button
                className="secondary"
                onClick={() => {
                  const cleared = clearDraft("");
                  setMessage(
                    cleared ? "未提交草稿已清空" : "草稿清理失败，请重试",
                  );
                  setConfirmClear(false);
                }}
              >
                确认清空草稿
              </button>
              <button
                className="secondary"
                onClick={() => setConfirmClear(false)}
              >
                保留草稿
              </button>
            </div>
          </div>
        )}
      </section>
    </>
  );
}
