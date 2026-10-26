import { randomUUID } from "node:crypto";

export function coworkEndpoint(endpoint) {
  if (
    !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/cowork$/.test(endpoint || "") ||
    new URL(endpoint).port > 65535
  )
    throw new Error("Cowork 连接必须使用插件提供的本机地址");
  return endpoint;
}
export class CoworkClient {
  constructor(connection, { tokenProvider, fetchImpl = fetch } = {}) {
    this.connection = connection;
    this.endpoint = coworkEndpoint(connection.endpoint);
    this.tokenProvider = tokenProvider;
    this.fetch = fetchImpl;
  }
  async rpc(method, data = {}) {
    const token = await this.tokenProvider();
    if (!token) throw new Error("请重新配对 AIMana Cowork 插件");
    const id = randomUUID();
    const response = await this.fetch(this.endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(45000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ id, method, data }),
    });
    if (!response.ok) throw new Error(`AIMana Cowork HTTP ${response.status}`);
    const body = await response.json();
    if (body.id !== id) throw new Error("AIMana Cowork 响应不匹配");
    if (body.error) throw new Error(body.error);
    return body.result;
  }
  inspect() {
    return this.rpc("inspect");
  }
  send(request) {
    return this.rpc("send", {
      ...request,
      profile: {
        agentId: this.connection.agentId,
        model: this.connection.model,
        cwd: this.connection.cwd,
        permissionMode: "ask",
      },
    });
  }
  poll(id) {
    return this.rpc("poll", { id });
  }
  recover(id) {
    return this.poll(id);
  }
  cancel(id) {
    return this.rpc("cancel", { id });
  }
}
