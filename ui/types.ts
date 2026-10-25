export interface Evidence {
  criterionId: string;
  passed: boolean;
  reference: string;
}
export interface Task {
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
  };
  result?: { text: string };
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
  kind: "a2a" | "codex";
  endpoint?: string;
  command?: string;
  model?: string;
  cwd?: string;
  status?: string;
  lastMessage?: string;
  hasToken?: boolean;
}
export interface Snapshot {
  tasks: Task[];
  connections: Connection[];
  database: string;
  version: string;
}
declare global {
  interface Window {
    cooperation: {
      request<T = unknown>(method: string, data?: unknown): Promise<T>;
      subscribe(callback: (snapshot: Snapshot) => void): () => void;
      onOffline(callback: () => void): () => void;
      pickDirectory(): Promise<string | null>;
      openData(): Promise<void>;
      quit(): Promise<void>;
    };
  }
}
