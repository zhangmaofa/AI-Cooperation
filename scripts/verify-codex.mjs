// Explicit live integration check: invokes real models, writes only to a new temporary workspace.
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DesktopService } from "../backend/service.mjs";

const root = await mkdtemp(
  path.join(os.tmpdir(), "aico-live-codex-verification-"),
);
const workspace = path.join(root, "workspace");
await mkdir(workspace);
const service = new DesktopService({
  root,
  codexCommand: process.env.AICO_CODEX_COMMAND || "codex.exe",
});
const connection = service.store.connection("codex-local");
connection.cwd = workspace;
service.store.saveConnection(connection);
console.log(
  "Live model verification. It uses your Codex quota and only a new isolated temporary workspace.",
);
try {
  const goal =
    "In the selected workspace, create only hello.txt containing exactly AI-Cooperation executor works followed by a newline. Acceptance is limited to the file existing, matching those exact bytes, and the workspace containing only this file. Execution constraints: do not install software, access network, or modify any other file. Those constraints do not request additional audit reports or deliverables. This is an isolated integration test.";
  const planned = await service.analyze({ goal, coordinatorId: "codex-local" });
  let task = await service.create({
    ...planned,
    goal,
    mode: "real",
    connectionId: "codex-local",
    workspace,
    maxRounds: 2,
    autoReview: true,
  });
  task = await service.action(task.id, "dispatch");
  if (task.ownerThreadId === task.contextId)
    throw new Error("Coordinator and worker must have different threads");
  console.log(
    JSON.stringify({ stage: "dispatched", status: task.status, workspace }),
  );
  const deadline = Date.now() + 360000;
  while (task.status === "working" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    task = await service.action(task.id, "poll");
  }
  const content = await readFile(path.join(workspace, "hello.txt"), "utf8");
  if (content !== "AI-Cooperation executor works\n")
    throw new Error("Artifact contents do not exactly match");
  console.log(
    JSON.stringify({
      status: task.status,
      artifactVerified: true,
      reviews: task.reviews.length,
      rounds: task.rounds,
      coordinatorThreadId: task.ownerThreadId,
      executorThreadId: task.contextId,
      evidenceRoot: root,
    }),
  );
  if (task.status !== "accepted")
    throw new Error(
      `Real coordination did not reach acceptance: ${task.status}; ${task.result?.text || ""}`,
    );
} finally {
  service.close();
}
