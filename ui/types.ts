export interface Evidence {
  criterionId: string;
  passed: boolean;
  reference: string;
}
export interface Task {
  contract?: Contract;
  workspace?: string;
  workflowId?: string;
  nodeId?: string;
  dependsOn?: string[];
  queueReason?: string;
  queueBlockers?: string[];
  automationError?: string;
  userQuestion?: string;
  usedTokens?: number;
  verifications?: {
    round: number;
    checks: {
      command: string;
      passed: boolean;
      output: string;
      error?: string;
    }[];
    changed: string[];
    outside: string[];
    complete?: boolean;
  }[];
  id: string;
  goal: string;
  plan: string[];
  acceptance: { id: string; text: string }[];
  mode: "demo" | "real";
  status: string;
  rounds: number;
  maxRounds: number;
  contextId: string | null;
  remoteTaskId: string | null;
  ownerThreadId: string;
  coordinatorId?: string;
  autoReview: boolean;
  busy: boolean;
  updatedAt: string;
  executor: {
    type: string;
    connectionId?: string;
    cwd?: string;
    model?: string;
    agentId?: string;
  };
  result?: {
    text: string;
    remote?: {
      metadata?: {
        actualModel?: string;
        requestedModel?: string;
        conversationId?: number;
      };
    };
  };
  reviews: {
    decision: string;
    feedback: string;
    evidence: Evidence[];
    round: number;
  }[];
  events: { seq: number; at: string; type: string; message?: string }[];
}
export interface Connection {
  id: string;
  name: string;
  kind: "a2a" | "codex" | "acp" | "aimana";
  agentId?: string;
  agentName?: string;
  catalog?: {
    agents: {
      id: string;
      name: string;
      engine: string;
      defaultModel: string;
      models: { id: string; name: string }[];
    }[];
    projects: { cwd: string; name: string }[];
  };
  args?: string[];
  capabilities?: Record<string, boolean | string>;
  endpoint?: string;
  command?: string;
  model?: string;
  cwd?: string;
  status?: string;
  lastMessage?: string;
  hasToken?: boolean;
}
export interface Snapshot {
  workflows?: Workflow[];
  messages?: {
    id: string;
    taskId: string;
    kind: string;
    state: string;
    text: string;
    response?: string;
    error?: string;
  }[];
  scheduler?: { maxConcurrent: number; perConnection: number };
  tasks: Task[];
  connections: Connection[];
  database: string;
  version: string;
}
export interface Contract {
  autoAnswer: boolean;
  verification: { command: string; args: string[]; timeoutMs?: number }[];
  allowedPaths: string[];
  maxTokens: number;
  stopOnNoProgress: boolean;
  isolateWorktree?: boolean;
}
export interface WorkflowNode {
  id: string;
  goal: string;
  plan: string[];
  acceptance: string[];
  dependsOn: string[];
  connectionId: string;
  workspace?: string;
  contract?: Contract;
}
export interface Workflow {
  id: string;
  goal: string;
  coordinatorId: string;
  threadId: string;
  acceptance: string[];
  nodes: WorkflowNode[];
  taskIds: string[];
  status: string;
  lastError?: string;
  running?: boolean;
  paused?: boolean;
  automationPaused?: boolean;
  autoReview?: boolean;
  queueReason?: string;
  reviews: { decision: string; feedback: string; evidence: string[] }[];
}
declare global {
  interface Window {
    cooperation: {
      request<T = unknown>(method: string, data?: unknown): Promise<T>;
      subscribe(callback: (snapshot: Snapshot) => void): () => void;
      onOffline(callback: () => void): () => void;
      onNavigate(
        callback: (value: { page: string; id: string }) => void,
      ): () => void;
      onWarning(callback: (message: string) => void): () => void;
      pickDirectory(): Promise<string | null>;
      openData(): Promise<void>;
      quit(): Promise<void>;
    };
  }
}
