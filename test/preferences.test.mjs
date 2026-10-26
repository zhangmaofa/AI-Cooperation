import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DesktopService } from "../backend/service.mjs";
import { defaultPreferences } from "../backend/preferences.mjs";
import notification from "../desktop/notifications.cjs";

test("preferences persist in SQLite, reject invalid UI payloads and leave existing tasks intact", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aico-preferences-"));
  let service = new DesktopService({ root });
  try {
    assert.deepEqual(service.snapshot().preferences, defaultPreferences);
    const task = await service.create({
      mode: "demo",
      goal: "保留记录",
      plan: ["检查"],
      acceptance: ["完成"],
      maxRounds: 3,
    });
    const wanted = {
      mode: "dark",
      accent: "blue",
      fontScale: 1.5,
      notifications: false,
      autoOpenCodex: true,
    };
    await service.handle("preferences.save", wanted);
    for (const patch of [
      { fontScale: 99 },
      { accent: "url(invalid)" },
      { mode: "unknown" },
      { notifications: "false" },
      { unknown: true },
    ])
      await assert.rejects(
        service.handle("preferences.save", { ...wanted, ...patch }),
      );
    service.close();
    service = new DesktopService({ root });
    assert.deepEqual(service.snapshot().preferences, wanted);
    assert.equal(service.snapshot().tasks[0].id, task.id);
    service.store.setSetting("preferences", { mode: "corrupt" });
    assert.deepEqual(service.snapshot().preferences, defaultPreferences);
  } finally {
    service.close();
  }
});

test("muted desktop notifications do not replay when re-enabled", () => {
  const before = { tasks: [], workflows: [] };
  const off = {
    tasks: [{ id: "t", status: "needs_user", goal: "权限待处理" }],
    workflows: [{ id: "w", status: "accepted", goal: "完成" }],
    preferences: { notifications: false },
  };
  assert.deepEqual(notification.notices(before, off), []);
  const on = { ...off, preferences: { notifications: true } };
  assert.deepEqual(notification.notices(off, on), []);
  assert.equal(
    notification.notices(on, {
      ...on,
      tasks: [{ ...on.tasks[0], status: "failed" }],
    }).length,
    1,
  );
});
