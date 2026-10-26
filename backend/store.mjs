import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { Relay } from "../src/relay.mjs";

export class Store {
  constructor(root) {
    mkdirSync(root, { recursive: true });
    this.path = path.join(root, "cooperation.sqlite");
    this.db = new Database(this.path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, owner TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(task_id TEXT NOT NULL REFERENCES tasks(id), seq INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(task_id, seq));
      CREATE TABLE IF NOT EXISTS connections(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS executions(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, dedupe TEXT UNIQUE NOT NULL, task_id TEXT NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workflows(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_messages(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), payload TEXT NOT NULL);
      PRAGMA user_version = 4;
    `);
  }
  saveTask(task) {
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO tasks VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at,payload=excluded.payload",
        )
        .run(
          task.id,
          task.ownerThreadId,
          task.status,
          task.updatedAt,
          JSON.stringify(task),
        );
      const insert = this.db.prepare(
        "INSERT OR IGNORE INTO events VALUES (?,?,?)",
      );
      for (const event of task.events)
        insert.run(task.id, event.seq, JSON.stringify(event));
      if (task.pending) {
        const request = task.pending;
        this.enqueue({
          id: request.messageId,
          dedupe: request.messageId,
          taskId: task.id,
          direction: "executor",
          kind: "instruction",
          text: request.text,
          state: task.status === "delivery_unknown" ? "unknown" : "sending",
          round: task.rounds,
          contextId: request.contextId,
          at: task.updatedAt,
        });
        const record = this.messages(task.id).find(
          (m) => m.id === request.messageId,
        );
        this.saveMessage({
          ...record,
          state: task.status === "delivery_unknown" ? "unknown" : "sending",
        });
      } else {
        for (const record of this.messages(task.id).filter(
          (m) => m.direction === "executor" && m.state === "sending",
        ))
          this.saveMessage({
            ...record,
            state: "delivered",
            contextId: task.contextId,
            remoteTaskId: task.remoteTaskId,
            acknowledgedAt: task.updatedAt,
          });
      }
    })();
  }
  task(id) {
    const row = this.db.prepare("SELECT payload FROM tasks WHERE id=?").get(id);
    if (!row) throw new Error("任务不存在");
    return JSON.parse(row.payload);
  }
  tasks() {
    return this.db
      .prepare("SELECT payload FROM tasks ORDER BY updated_at DESC")
      .all()
      .map((r) => JSON.parse(r.payload));
  }
  connection(id) {
    const row = this.db
      .prepare("SELECT payload FROM connections WHERE id=?")
      .get(id);
    if (!row) throw new Error("连接不存在，请先配置 Agent");
    return JSON.parse(row.payload);
  }
  connections() {
    return this.db
      .prepare("SELECT payload FROM connections ORDER BY rowid")
      .all()
      .map((r) => JSON.parse(r.payload));
  }
  saveConnection(value) {
    this.db
      .prepare(
        "INSERT INTO connections VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
      )
      .run(value.id, JSON.stringify(value));
  }
  saveExecution(value) {
    this.db
      .prepare(
        "INSERT INTO executions VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
      )
      .run(value.id, JSON.stringify(value));
  }
  execution(id) {
    const row = this.db
      .prepare("SELECT payload FROM executions WHERE id=?")
      .get(id);
    if (!row) throw new Error("执行轮次不存在，无法恢复该 Codex 会话");
    return JSON.parse(row.payload);
  }
  executions() {
    return this.db
      .prepare("SELECT payload FROM executions")
      .all()
      .map((row) => JSON.parse(row.payload));
  }
  close() {
    this.db.close();
  }
  setting(key, fallback) {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(key);
    return row ? JSON.parse(row.value) : fallback;
  }
  setSetting(key, value) {
    this.db
      .prepare(
        "INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  enqueue(message) {
    this.db
      .prepare("INSERT OR IGNORE INTO messages VALUES (?,?,?,?,?)")
      .run(
        message.id,
        message.dedupe,
        message.taskId,
        message.state || "pending",
        JSON.stringify({ ...message, state: message.state || "pending" }),
      );
    return this.messages().find((m) => m.dedupe === message.dedupe);
  }
  messages(taskId) {
    return this.db
      .prepare(
        taskId
          ? "SELECT payload FROM messages WHERE task_id=? ORDER BY rowid"
          : "SELECT payload FROM messages ORDER BY rowid",
      )
      .all(...(taskId ? [taskId] : []))
      .map((row) => JSON.parse(row.payload));
  }
  saveMessage(message) {
    this.db
      .prepare("UPDATE messages SET state=?,payload=? WHERE id=?")
      .run(message.state, JSON.stringify(message), message.id);
  }
  workflows() {
    return this.db
      .prepare("SELECT payload FROM workflows ORDER BY rowid DESC")
      .all()
      .map((row) => JSON.parse(row.payload));
  }
  saveWorkflow(workflow) {
    this.db
      .prepare(
        "INSERT INTO workflows VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
      )
      .run(workflow.id, JSON.stringify(workflow));
  }
  projects() {
    return this.db
      .prepare("SELECT payload FROM projects ORDER BY rowid DESC")
      .all()
      .map((r) => JSON.parse(r.payload));
  }
  saveProject(value) {
    this.db
      .prepare(
        "INSERT INTO projects VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
      )
      .run(value.id, JSON.stringify(value));
  }
  conversations() {
    return this.db
      .prepare("SELECT payload FROM conversations ORDER BY rowid DESC")
      .all()
      .map((r) => JSON.parse(r.payload));
  }
  conversation(id) {
    const row = this.db
      .prepare("SELECT payload FROM conversations WHERE id=?")
      .get(id);
    if (!row) throw new Error("对话不存在");
    return JSON.parse(row.payload);
  }
  saveConversation(value) {
    this.db
      .prepare(
        "INSERT INTO conversations VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
      )
      .run(value.id, value.projectId, JSON.stringify(value));
  }
  conversationMessages(id) {
    return this.db
      .prepare(
        "SELECT payload FROM conversation_messages WHERE conversation_id=? ORDER BY rowid",
      )
      .all(id)
      .map((r) => JSON.parse(r.payload));
  }
  appendConversationMessage(value) {
    this.db
      .prepare("INSERT OR IGNORE INTO conversation_messages VALUES (?,?,?)")
      .run(value.id, value.conversationId, JSON.stringify(value));
  }
  rollbackWorkflow(id, taskIds) {
    this.db.transaction(() => {
      for (const taskId of taskIds) {
        this.db.prepare("DELETE FROM messages WHERE task_id=?").run(taskId);
        this.db.prepare("DELETE FROM events WHERE task_id=?").run(taskId);
        this.db.prepare("DELETE FROM tasks WHERE id=?").run(taskId);
      }
      this.db.prepare("DELETE FROM workflows WHERE id=?").run(id);
    })();
  }
}

export class SqliteRelay extends Relay {
  constructor(store, factory) {
    super({ root: path.dirname(store.path), adapterFactory: factory });
    this.store = store;
    this.busy = new Set();
  }
  async save(task) {
    this.store.saveTask(task);
  }
  async read(id, owner) {
    const task = this.store.task(id);
    if (task.ownerThreadId !== owner) throw new Error("任务不属于该主调会话");
    return task;
  }
  async locked(id, owner, action) {
    if (this.busy.has(id)) throw new Error("任务正在处理，请稍候");
    this.busy.add(id);
    try {
      return await action(await this.read(id, owner));
    } finally {
      this.busy.delete(id);
    }
  }
}
