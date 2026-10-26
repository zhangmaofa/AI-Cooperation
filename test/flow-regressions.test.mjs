import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DesktopService } from "../backend/service.mjs";
import notification from "../desktop/notifications.cjs";

const evidence = [
  {
    criterionId: "C1",
    passed: true,
    reference: "isolated fixture artifact inspected",
  },
];
const accept = { decision: "accept", feedback: "fixture checked", evidence };
function immediate(connection) {
  return {
    connection,
    openThread: async (id) => id || crypto.randomUUID(),
    run: async () => ({
      text: JSON.stringify({ status: "completed", summary: "fixture report" }),
    }),
    close() {},
  };
}
async function setup(factory = immediate) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aico-flow-fixes-"));
  const workspace = path.join(root, "work");
  await mkdir(workspace);
  const service = new DesktopService({
    root: path.join(root, "data"),
    clientFactory: factory,
  });
  service.store.setSetting("plan:main", {
    goal: "workflow fixture",
    coordinatorId: "codex-local",
  });
  return { service, root, workspace };
}
const node = (id, workspace, dependsOn = []) => ({
  id,
  goal: `${id} output`,
  plan: ["write and check"],
  acceptance: ["artifact valid"],
  connectionId: "codex-local",
  workspace,
  dependsOn,
});
const workflowInput = (nodes) => ({
  goal: "workflow fixture",
  acceptance: ["integrated"],
  coordinatorId: "codex-local",
  threadId: "main",
  autoReview: false,
  nodes,
});
const create = (s, cwd, more = {}) =>
  s.create({
    goal: "worker fixture",
    plan: ["write"],
    acceptance: ["artifact"],
    mode: "real",
    connectionId: "codex-local",
    workspace: cwd,
    maxRounds: 5,
    ...more,
  });
async function settle(s, id) {
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 2));
    const t = await s.action(id, "poll");
    if (t.status !== "working") return t;
  }
  throw new Error("fixture timeout");
}

test("a slow coordinator review does not block other task polls or the scheduler", async () => {
  let release,
    entered,
    mainCalls = 0;
  const waiting = new Promise((r) => (entered = r)),
    gate = new Promise((r) => (release = r));
  const {
    service: s,
    root,
    workspace,
  } = await setup((c, { role }) => ({
    ...immediate(c),
    async run() {
      if (role === "coordinator") {
        mainCalls++;
        entered();
        await gate;
        return { text: JSON.stringify(accept) };
      }
      return { text: JSON.stringify({ status: "completed", summary: "done" }) };
    },
  }));
  try {
    const other = path.join(root, "other");
    await mkdir(other);
    s.store.setSetting("scheduler", { maxConcurrent: 2, perConnection: 2 });
    s.store.setSetting("plan:review", {
      goal: "worker fixture",
      coordinatorId: "codex-local",
    });
    const first = await create(s, workspace, {
        coordinatorId: "codex-local",
        threadId: "review",
        autoReview: true,
      }),
      second = await create(s, other);
    await s.action(first.id, "dispatch");
    await s.action(second.id, "dispatch");
    const result = await Promise.race([
      s.tick().then(() => "returned"),
      new Promise((r) => setTimeout(() => r("blocked"), 150)),
    ]);
    assert.equal(result, "returned");
    await waiting;
    for (
      let i = 0;
      i < 40 && s.store.task(second.id).status !== "pending_review";
      i++
    )
      await new Promise((r) => setTimeout(r, 3));
    assert.equal(s.store.task(second.id).status, "pending_review");
    assert.equal(mainCalls, 1);
    await s.tick();
    assert.equal(mainCalls, 1);
    release();
    await s.drainBackground();
    assert.equal(s.store.task(first.id).status, "accepted");
  } finally {
    release();
    await s.drainBackground();
    s.close();
  }
});

test("workflow creation rolls back its own partial rows when a later child fails", async () => {
  const { service: s, workspace } = await setup();
  try {
    const prior = await create(s, workspace);
    const original = s.create.bind(s);
    let count = 0;
    s.create = async (input) => {
      if (++count === 2) throw new Error("injected second-child failure");
      return original(input);
    };
    await assert.rejects(
      s.workflows.create(
        workflowInput([node("A", workspace), node("B", workspace, ["A"])]),
      ),
      /second-child/,
    );
    assert.deepEqual(
      s.store.tasks().map((t) => t.id),
      [prior.id],
    );
    assert.equal(s.store.workflows().length, 0);
    const valid = await s.workflows.create(
      workflowInput([node("C", workspace)]),
    );
    valid.taskIds = [];
    s.store.saveWorkflow(valid);
    assert.throws(() => s.workflows.start(valid.id), /不完整/);
    await assert.rejects(s.workflows.review(valid.id), /不完整/);
    await s.tick();
    await s.drainBackground();
    assert.equal(s.workflows.get(valid.id).status, "needs_attention");
    assert.equal(s.mutationDepth, 0);
    assert.equal(s.store.messages().length, 0);
  } finally {
    s.close();
  }
});

test("pause survives restart and prevents new dispatch without pretending to stop active work", async () => {
  let starts = 0;
  const factory = (c) => ({
    ...immediate(c),
    async run() {
      starts++;
      return { text: JSON.stringify({ status: "completed", summary: "done" }) };
    },
  });
  const { service: s, root, workspace } = await setup(factory);
  let reopened;
  try {
    const w = await s.workflows.create(workflowInput([node("A", workspace)]));
    s.workflows.start(w.id);
    s.workflows.pause(w.id);
    await s.tick();
    await s.drainBackground();
    assert.equal(starts, 0);
    assert.equal(s.store.task(w.taskIds[0]).status, "queued");
    s.workflows.start(w.id);
    await s.tick();
    await s.drainBackground();
    assert.equal(starts, 1);
    s.workflows.pause(w.id);
    assert.equal(s.store.task(w.taskIds[0]).status, "working");
    s.close();
    reopened = new DesktopService({
      root: path.join(root, "data"),
      clientFactory: factory,
    });
    await reopened.tick();
    await reopened.drainBackground();
    assert.equal(reopened.workflows.get(w.id).paused, true);
    assert.equal(starts, 1);
    assert.equal(reopened.store.task(w.taskIds[0]).status, "delivery_unknown");
  } finally {
    if (!s.closed) s.close();
    reopened?.close();
  }
});

test("upstream rework invalidates transitive dependents and hands new accepted inputs to their original sessions", async () => {
  const {
    service: s,
    root,
    workspace,
  } = await setup((c) => ({
    ...immediate(c),
    run: async () => ({
      text: JSON.stringify({
        decision: "revise",
        feedback: "repair A",
        evidence: [],
        reviseNodes: ["A"],
      }),
    }),
  }));
  try {
    const dirs = { A: workspace };
    for (const id of ["B", "C", "D"]) {
      dirs[id] = path.join(root, id);
      await mkdir(dirs[id]);
    }
    const sent = [],
      runs = new Map();
    s.adapter = (config) => ({
      async send(req) {
        const id = Object.keys(dirs).find((k) => dirs[k] === config.cwd),
          round = (runs.get(id) || 0) + 1;
        runs.set(id, round);
        sent.push({ id, request: req });
        await writeFile(path.join(config.cwd, "result.txt"), `${id} v${round}`);
        return {
          kind: "task",
          id: `${id}-${round}`,
          contextId: req.contextId || `ctx-${id}`,
          status: {
            state: "completed",
            message: { parts: [{ kind: "text", text: `${id} v${round}` }] },
          },
        };
      },
    });
    const w = await s.workflows.create(
      workflowInput([
        node("A", dirs.A),
        node("B", dirs.B, ["A"]),
        node("C", dirs.C, ["B"]),
        node("D", dirs.D),
      ]),
    );
    s.workflows.start(w.id);
    for (const id of w.taskIds) {
      await s.action(id, "dispatch");
      await s.action(id, "review", accept);
    }
    await s.workflows.review(w.id);
    assert.deepEqual(
      w.taskIds.map((id) => s.store.task(id).status),
      ["queued", "queued", "queued", "accepted"],
    );
    assert.deepEqual(
      w.taskIds.map((id) => s.store.task(id).contextId),
      ["ctx-A", "ctx-B", "ctx-C", "ctx-D"],
    );
    await s.action(w.taskIds[0], "dispatch");
    await s.action(w.taskIds[0], "review", accept);
    await s.action(w.taskIds[1], "dispatch");
    const handoff = JSON.parse(sent.at(-1).request.text);
    assert.equal(handoff.dependencies[0].report, "A v2");
    assert.equal(handoff.dependencies[0].acceptedRound, 2);
    assert.equal(sent.at(-1).request.contextId, "ctx-B");
    assert.equal(s.store.task(w.taskIds[3]).status, "accepted");
  } finally {
    s.close();
  }
});

test("unchanged queue blockers are visible and do not append duplicate events each tick", async () => {
  const { service: s, workspace } = await setup();
  try {
    const first = await create(s, workspace),
      second = await create(s, workspace);
    await s.action(first.id, "dispatch");
    await settle(s, first.id);
    await s.action(second.id, "dispatch");
    const before = s.store.task(second.id);
    assert.deepEqual(before.queueBlockers, [first.id]);
    for (let i = 0; i < 30; i++) await s.action(second.id, "dispatch");
    assert.equal(s.store.task(second.id).events.length, before.events.length);
  } finally {
    s.close();
  }
});

test("preflight reports multiple actionable errors without persisting or executing a plan", async () => {
  const { service: s, workspace } = await setup();
  try {
    s.store.saveConnection({
      id: "aimana-unconfigured",
      name: "unconfigured",
      kind: "aimana",
    });
    const a = node("A", workspace, ["B"]),
      b = {
        ...node("B", path.join(workspace, "missing"), ["A"]),
        connectionId: "aimana-unconfigured",
      };
    const report = await s.workflows.preflight(workflowInput([a, b]));
    assert.equal(report.ok, false);
    assert.ok(report.issues.some((i) => /循环/.test(i.message)));
    assert.ok(report.issues.some((i) => /AIMana/.test(i.message)));
    assert.equal(s.store.tasks().length, 0);
    await assert.rejects(s.workflows.create(workflowInput([a, b])));
    assert.equal(s.store.workflows().length, 0);
  } finally {
    s.close();
  }
});

test("a failed overall review can resume with its automatic mode intact instead of staying permanently blocked", async () => {
  let calls = 0;
  const { service: s, workspace } = await setup((c) => ({
    ...immediate(c),
    async run() {
      if (++calls === 1) throw new Error("temporary reviewer failure");
      return {
        text: JSON.stringify({
          decision: "accept",
          feedback: "checked",
          evidence: ["fixture evidence"],
          reviseNodes: [],
        }),
      };
    },
  }));
  try {
    const w = await s.workflows.create({
      ...workflowInput([node("A", workspace)]),
      autoReview: true,
    });
    const t = s.store.task(w.taskIds[0]);
    t.status = "accepted";
    s.store.saveTask(t);
    s.workflows.start(w.id);
    await assert.rejects(s.workflows.review(w.id), /temporary/);
    assert.equal(s.workflows.get(w.id).autoReview, true);
    assert.equal(s.workflows.get(w.id).automationPaused, true);
    s.workflows.start(w.id);
    await s.tick();
    await s.drainBackground();
    assert.equal(s.workflows.get(w.id).status, "accepted");
    assert.equal(calls, 2);
  } finally {
    s.close();
  }
});

test("desktop notices avoid startup spam, repeated polls and routine automatic review", () => {
  const t = {
    id: "task",
    goal: "fixture",
    status: "needs_input",
    remoteTaskId: "run",
    rounds: 1,
    contract: { autoAnswer: true },
  };
  const snapshot = { tasks: [t], workflows: [] };
  assert.deepEqual(notification.notices(undefined, snapshot), []);
  assert.deepEqual(
    notification.notices({ tasks: [], workflows: [] }, snapshot),
    [],
  );
  const escalated = {
    tasks: [{ ...t, userQuestion: "user decision" }],
    workflows: [],
  };
  assert.equal(notification.notices(snapshot, escalated).length, 1);
  assert.deepEqual(notification.notices(escalated, escalated), []);
  assert.deepEqual(
    notification.notices(snapshot, {
      tasks: [{ ...t, status: "pending_review", autoReview: true }],
      workflows: [],
    }),
    [],
  );
});

test("explicit retry reuses a confirmed failed session and never retries an uncertain send", async () => {
  const { service: s, workspace } = await setup();
  try {
    const requests = [];
    s.adapter = () => ({
      async send(request) {
        requests.push(request);
        return {
          kind: "task",
          id: `run-${requests.length}`,
          contextId: request.contextId || "original-context",
          status: {
            state: requests.length === 1 ? "failed" : "completed",
            message: { parts: [{ kind: "text", text: "fixture report" }] },
          },
        };
      },
    });
    let t = await create(s, workspace);
    t = await s.action(t.id, "dispatch");
    assert.equal(t.status, "failed");
    await s.action(t.id, "retry");
    await s.tick();
    await s.drainBackground();
    assert.equal(s.store.task(t.id).status, "pending_review");
    assert.equal(requests[1].contextId, "original-context");
    s.adapter = () => ({
      async send() {
        throw new Error("uncertain transport");
      },
    });
    const unknown = await create(s, workspace);
    await s.action(t.id, "review", accept);
    await s.action(unknown.id, "dispatch");
    assert.equal(s.store.task(unknown.id).status, "delivery_unknown");
    await assert.rejects(s.action(unknown.id, "retry"), /未知发送/);
  } finally {
    s.close();
  }
});

test("pausing during an in-flight review prevents its rejection from dispatching another worker turn", async () => {
  let enter,
    release,
    starts = 0;
  const entered = new Promise((r) => (enter = r)),
    gate = new Promise((r) => (release = r));
  const { service: s, workspace } = await setup((c, { role }) => ({
    ...immediate(c),
    async run() {
      if (role === "coordinator") {
        enter();
        await gate;
        return {
          text: JSON.stringify({
            decision: "revise",
            feedback: "repair fixture",
            evidence: [],
          }),
        };
      }
      starts++;
      return {
        text: JSON.stringify({
          status: "completed",
          summary: "fixture output",
        }),
      };
    },
  }));
  try {
    const w = await s.workflows.create({
      ...workflowInput([node("A", workspace)]),
      autoReview: true,
    });
    s.workflows.start(w.id);
    await s.action(w.taskIds[0], "dispatch");
    const review = s.action(w.taskIds[0], "poll");
    await entered;
    s.workflows.pause(w.id);
    release();
    await review;
    await s.tick();
    await s.drainBackground();
    assert.equal(starts, 1);
    assert.equal(s.workflows.get(w.id).paused, true);
    assert.equal(s.store.task(w.taskIds[0]).status, "revision_ready");
  } finally {
    release();
    await s.drainBackground();
    s.close();
  }
});
