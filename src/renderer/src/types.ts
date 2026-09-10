export type Message = {
  id: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<Record<string, any>>;
  reasoning?: string;
  images?: string[];
  hidden?: boolean;
  tool_calls?: unknown[];
  created_at: string;
};

export type Session = {
  id: string;
  title: string;
  mode: 'chat' | 'project' | 'work';
  project_id: string | null;
  title_mode: 'auto' | 'user';
  remote_title: string;
  deleted_at: string | null;
  workspace: string;
  work_root?: string;
  work_archive_path?: string;
  model: string;
  messages: Message[];
  provider_state?: {
    provider?: 'deepseek' | 'qwen' | 'chatgpt' | 'api' | string;
    url?: string;
    last_run_id?: string;
    last_call_id?: string | null;
    conversations?: Array<{ provider: string; url: string; generation: number; status: 'active' | 'retiring' | 'pending_cleanup' | 'deleted'; run_id?: string; lease_id?: string; delete_error?: string }>;
  };
  context_state?: { estimated_tokens?: number; context_window?: number; trigger_tokens?: number; window_source?: string; generation?: number; needs_compaction?: boolean; last_compacted_at?: string };
  updated_at: string;
  last_event_seq: number;
};

export type RuntimeEvent = {
  id: string;
  seq: number;
  created_at: string;
  type: string;
  session_id: string;
  run_id: string;
  parent_run_id: string | null;
  call_id: string | null;
  data: Record<string, any>;
};

export type Model = { id: string; displayName?: string; owned_by?: string; provider?: string; providerDisplayName?: string; capabilities?: Record<string, any> };
export type PendingImage = { name: string; mimeType: string; data: string };
export type Project = { id: string; name: string; workspace: string; description?: string; created_at: string; updated_at: string };

export type RuntimeSdk = {
  request<T = any>(path: string, options?: { method?: string; body?: any; headers?: Record<string, string> }): Promise<{ status: number; headers: Record<string, string>; data: T }>;
  subscribe(sessionId: string, after: number, callback: (event: RuntimeEvent) => void): Promise<() => void>;
  runtimeInfo(): Promise<{ port: number; pid: number; version: number; origin?: string; transport?: string }>;
  chooseWorkspace(): Promise<string | null>;
  chooseFiles(): Promise<string[]>;
  chooseImages(): Promise<PendingImage[]>;
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<boolean>;
  revealWorkspace(workspace: string): Promise<boolean>;
  harnessCurrentWorkspace(): Promise<{ available: boolean; session_id: string; workspace_id?: string; path: string; title: string; reason: string }>;
  openExternal(url: string): Promise<boolean>;
  platform: string;
};

declare global {
  interface Window {
    webagent: RuntimeSdk;
    dsagent: RuntimeSdk;
  }
}
