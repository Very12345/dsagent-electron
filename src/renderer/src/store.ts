import { create } from 'zustand';
import type { Model, Project, RuntimeEvent, Session } from './types';

const bootParams = new URLSearchParams(location.search);
const initialTheme: 'dark' | 'light' = bootParams.get('theme') === 'light' || (!bootParams.get('theme') && localStorage.getItem('webagent-theme') === 'light') ? 'light' : 'dark';
const initialActivity = bootParams.get('activity') || 'sessions';
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';
const reasoningEfforts = new Set<ReasoningEffort>(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'auto']);
const savedReasoningEffort = localStorage.getItem('webagent-reasoning-effort') as ReasoningEffort | null;
const initialReasoningEffort: ReasoningEffort = savedReasoningEffort && reasoningEfforts.has(savedReasoningEffort)
  ? savedReasoningEffort
  : localStorage.getItem('webagent-deep-think') === 'true' ? 'low' : 'none';
const initialWebSearch = localStorage.getItem('webagent-web-search') === 'true';

type AppState = {
  sessions: Session[];
  current: Session | null;
  models: Model[];
  projects: Project[];
  events: RuntimeEvent[];
  liveText: string;
  statusText: string;
  busy: boolean;
  error: string;
  activity: string;
  sessionView: 'chat' | 'projects' | 'work' | 'trash';
  selectedCapability: any | null;
  bottomOpen: boolean;
  inspectorOpen: boolean;
  theme: 'dark' | 'light';
  reasoningEffort: ReasoningEffort;
  webSearch: boolean;
  set: (patch: Partial<AppState>) => void;
  pushEvent: (event: RuntimeEvent) => void;
};

export const useAppStore = create<AppState>((set) => ({
  sessions: [], current: null, models: [], projects: [], events: [], liveText: '', statusText: '', busy: false,
  error: '', activity: initialActivity, sessionView: 'chat', selectedCapability: null, bottomOpen: false, inspectorOpen: false, theme: initialTheme,
  reasoningEffort: initialReasoningEffort, webSearch: initialWebSearch,
  set,
  pushEvent: (event) => set((state) => ({
    events: state.events.concat(event).slice(-500),
    liveText: event.type === 'response.output_text.delta'
      ? state.liveText + String(event.data.delta || '')
      : event.type === 'response.output_text.replace' || event.type === 'response.output_text.done'
        ? String(event.data.text || '')
        : event.type === 'response.output_text.reset' ? '' : state.liveText,
    statusText: event.type === 'response.status' || event.type === 'response.reasoning.summary'
      ? String(event.data.text || '')
      : /run\.(completed|failed|cancelled)/.test(event.type) ? '' : state.statusText,
    busy: event.type === 'run.created' || event.type === 'run.in_progress' ? true : /run\.(completed|failed|cancelled)/.test(event.type) ? false : state.busy,
    error: event.type === 'run.failed' ? String(event.data.error?.message || '运行失败') : state.error
  }))
}));
