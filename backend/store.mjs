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
      PRAGMA user_version = 1;
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
  close() {
    this.db.close();
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
