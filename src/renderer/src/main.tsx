import React from 'react';
import ReactDOM from 'react-dom/client';
import { installBrowserSdk } from './browser-sdk';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { Virtuoso } from 'react-virtuoso';
import { useAppStore, type ReasoningEffort } from './store';
import { FeatureWorkbench } from './FeatureWorkbench';
import { VisualCodeBlock } from './VisualCodeBlock';
import type { Message, Model, PendingImage, Project, RuntimeEvent, Session } from './types';
import '@mdi/font/css/materialdesignicons.css';
import './styles.css';
import 'katex/dist/katex.min.css';

// Electron's preload installs the privileged SDK before this bundle executes.
// Plain browsers receive the cookie-authenticated same-origin implementation.
installBrowserSdk();

type Capability = { id: string; label: string; description?: string; kind: string; path?: string };
type MenuAction = { label: string; icon: string; onClick: () => void | Promise<void>; disabled?: boolean };

const activities = [
  { id: 'sessions', icon: 'message-text-outline', label: '会话' },
  { id: 'files', icon: 'file-multiple-outline', label: '资源管理器' },
  { id: 'agents', icon: 'account-multiple-outline', label: 'Agents' },
  { id: 'harness', icon: 'horse-variant', label: 'DeepSeek Harness' },
  { id: 'tools', icon: 'tools', label: '工具与 MCP' },
  { id: 'plugins', icon: 'puzzle-outline', label: 'Skills 与插件' },
  { id: 'bots', icon: 'robot-outline', label: 'Bots' }
  ,{ id: 'api', icon: 'api', label: '本地 API' }
];

const panelNames: Record<string, string> = {
  sessions: '会话', files: '资源管理器', agents: 'Agents', tools: '工具与 MCP',
  plugins: 'Skills 与插件', bots: 'Bots 与移动端', harness: 'DeepSeek Harness', api: '本地 API', accounts: '账户', settings: '设置'
};

function providerLabel(model: Model) {
  if (model.providerDisplayName) return model.providerDisplayName;
  const id = model.owned_by || model.provider || '';
  return ({ deepseek: 'DeepSeek 网页', qwen: '千问网页版', rogator: 'Qianwen 网关', chatgpt: 'ChatGPT 网页', openai: 'OpenAI 兼容 API', anthropic: 'Anthropic API' } as Record<string, string>)[id] || id || '其他模型';
}

function ModelPicker({ models, value, disabled, onChange }: { models: Model[]; value: string; disabled?: boolean; onChange: (model: string) => void | Promise<void> }) {
  const [open, setOpen] = React.useState(false);
  const current = models.find((model) => model.id === value) || models[0];
  const groups = React.useMemo(() => {
    const result: Array<{ id: string; label: string; models: Model[] }> = [];
    for (const model of models) {
      const id = model.owned_by || model.provider || 'other';
      let group = result.find((item) => item.id === id);
      if (!group) { group = { id, label: providerLabel(model), models: [] }; result.push(group); }
      group.models.push(model);
    }
    return result;
  }, [models]);
  const currentGroup = groups.find((group) => group.models.some((model) => model.id === current?.id)) || groups[0];
  const [provider, setProvider] = React.useState(currentGroup?.id || '');
  const host = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => { if (!open && currentGroup) setProvider(currentGroup.id); }, [open, currentGroup?.id]);
  React.useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!host.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const active = groups.find((group) => group.id === provider) || groups[0];
  return <div className="model-picker" ref={host}>
    <button className={open ? 'model-picker-trigger active' : 'model-picker-trigger'} disabled={disabled || !current} title="选择提供商和模型" onClick={() => setOpen(!open)}><Icon name="brain" /><span><small>{current ? providerLabel(current) : '提供商'}</small><b>{current?.displayName || current?.id || '选择模型'}</b></span><Icon name="chevron-down" /></button>
    {open && <div className="model-picker-menu">
      <nav aria-label="模型提供商">{groups.map((group) => <button key={group.id} className={active?.id === group.id ? 'active' : ''} onMouseEnter={() => setProvider(group.id)} onClick={() => setProvider(group.id)}><span>{group.label}</span><small>{group.models.length}</small><Icon name="chevron-right" /></button>)}</nav>
      <section aria-label="模型">{active?.models.map((model) => <button key={model.id} className={model.id === value ? 'active' : ''} onClick={async () => { await onChange(model.id); setOpen(false); }}><Icon name={model.id === value ? 'check' : 'circle-small'} /><span><b>{model.displayName || model.id}</b><small>{model.id}</small></span></button>)}</section>
    </div>}
  </div>;
}

function Icon({ name, className = '' }: { name: string; className?: string }) {
  return <i aria-hidden="true" className={'mdi mdi-' + name + ' ' + className} />;
}

function ActionMenu({ title, icon = 'dots-horizontal', items }: { title: string; icon?: string; items: MenuAction[] }) {
  const [open, setOpen] = React.useState(false);
  const host = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!host.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  return <div className="action-menu" ref={host}>
    <button aria-label={title} title={title} className={open ? 'pressed' : ''} onClick={() => setOpen(!open)}><Icon name={icon} /></button>
    {open && <div className="action-menu-popup">{items.map((item) => <button key={item.label} disabled={item.disabled} onClick={() => { setOpen(false); void item.onClick(); }}><Icon name={item.icon} /><span>{item.label}</span></button>)}</div>}
  </div>;
}

function formatPayload(value: unknown, limit = 5000) {
  if (value == null || value === '') return '';
  let payload = value;
  if (typeof value === 'string') {
    try { payload = JSON.parse(value); } catch { payload = value; }
  }
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return text.length > limit ? text.slice(0, limit) + '\n…' : text;
}

function fileIcon(name: string) {
  const extension = name.split('.').pop()?.toLowerCase();
  if (['ts', 'tsx', 'js', 'jsx'].includes(extension || '')) return 'language-typescript';
  if (['json', 'jsonc'].includes(extension || '')) return 'code-json';
  if (['md', 'mdx'].includes(extension || '')) return 'language-markdown-outline';
  if (['css', 'scss', 'less'].includes(extension || '')) return 'language-css3';
  if (['html', 'htm'].includes(extension || '')) return 'language-html5';
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(extension || '')) return 'file-image-outline';
  if (['yml', 'yaml', 'toml', 'ini'].includes(extension || '')) return 'cog-outline';
  return 'file-outline';
}

function cleanVisibleAssistant(value: string) {
  const text = String(value || '');
  const callingMarker = text.search(/(?:^|\n)\s*(?:\*\*)?Calling:(?:\*\*)?\s*`?[a-zA-Z0-9_-]+`?/i);
  const nativeMarker = text.search(/```(?:json|text)?\s*\[\s*\{\s*"(?:name|tool)"\s*:/i);
  const chineseMarker = text.search(/\[调用\s+[a-zA-Z0-9_-]+\]/);
  const xmlMarker = text.search(/<(?:read|read_file|list|list_directory|exec|bash|grep|glob|subagent)>/);
  const functionMarker = text.search(/<function_calls?>/);
  const reactMarker = text.search(/(?:^|\n)\s*Action:\s*`?[a-zA-Z0-9_-]+`?\s*\n\s*Action\s+Input:/);
  const markers = [callingMarker, nativeMarker, chineseMarker, xmlMarker, functionMarker, reactMarker].filter((index) => index >= 0);
  const marker = markers.length ? Math.min(...markers) : -1;
  return (marker >= 0 ? text.slice(0, marker) : text)
    .replace(/(?:^|\n)\s*(?:text\s*)?(?:复制|下载)[\s\S]*$/i, '')
    .trimEnd();
}

function containsToolProtocol(value: string) {
  const text = String(value || '');
  return /(?:^|\n)\s*(?:\*\*)?Calling:(?:\*\*)?\s*`?[a-zA-Z0-9_-]+`?/i.test(text)
    || /```(?:json|text)?\s*\[\s*\{\s*"(?:name|tool)"\s*:/i.test(text)
    || /\[调用\s+[a-zA-Z0-9_-]+\]/.test(text)
    || /<(?:read|read_file|list|list_directory|exec|bash|grep|glob|subagent)>[\s\S]*<\//.test(text)
    || /<function_calls?>[\s\S]*<\/function_calls?>/.test(text)
    || /(?:^|\n)\s*Action:\s*`?[a-zA-Z0-9_-]+`?\s*\n\s*Action\s+Input:/.test(text);
}

function briefReasoning(value: string) {
  const plain = String(value || '').replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim();
  if (!plain) return '';
  if (/^(?:正在|等待|DeepSeek|千问|工具)/.test(plain)) return plain.length > 64 ? plain.slice(0, 64).trimEnd() + '…' : plain;
  let sentence = plain.split(/[。！？!?]/)[0].trim()
    .replace(/^(?:首先)?(?:让我|我来|我会|接下来我会|现在我会)/, '')
    .replace(/^[，,:：\s]+/, '');
  if (sentence.length > 58) sentence = sentence.slice(0, 58).trimEnd();
  if (!/^正在/.test(sentence)) sentence = '正在' + sentence;
  return sentence.replace(/[.…]+$/, '') + '…';
}

const MarkdownContent = React.memo(function MarkdownContent({ children }: { children: string }) {
  return <ReactMarkdown
    remarkPlugins={[remarkGfm, remarkMath]}
    rehypePlugins={[rehypeKatex]}
    components={{
      code({ className, children: codeChildren, ...props }) {
        const language = /language-([^\s]+)/.exec(className || '')?.[1] || '';
        const source = String(codeChildren).replace(/\n$/, '');
        if (['mermaid', 'wa-plot', 'typst'].includes(language)) return <VisualCodeBlock language={language} source={source} />;
        return <code className={className} {...props}>{codeChildren}</code>;
      }
    }}
  >{children}</ReactMarkdown>;
});

const StableImage = React.memo(function StableImage({ source, index }: { source: string; index: number }) {
  const [ready, setReady] = React.useState(false);
  return <div className={'message-image-frame ' + (ready ? 'ready' : 'loading')} role="img" aria-label={'生成图片 ' + (index + 1)}>
    <img src={source} alt="" loading="lazy" decoding="async" onLoad={() => setReady(true)} onError={() => setReady(true)} />
  </div>;
});

function visibleMessageContent(content: Message['content']) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content || '');
  return content.map((part) => {
    if (part?.type === 'text' || part?.type === 'input_text') return String(part.text || '');
    if (part?.type === 'image' || part?.type === 'input_image') return `🖼️ ${String(part.name || '图片')}`;
    return '';
  }).filter(Boolean).join('\n\n');
}

const MessageView = React.memo(function MessageView({ message, mode }: { message: Message; mode?: Session['mode'] }) {
  const isUser = message.role === 'user';
  const role = isUser ? '你' : message.role === 'assistant' ? 'WebAgent' : message.role === 'tool' ? '工具结果' : '系统';
  const rawContent = visibleMessageContent(message.content);
  const visibleContent = message.role === 'assistant' && mode !== 'chat' ? cleanVisibleAssistant(rawContent) : rawContent;
  return <article className={'message ' + message.role}>
    <div className={'message-avatar ' + message.role}>{isUser ? <Icon name="account" /> : <span>WA</span>}</div>
    <div className="message-body">
      <header><strong>{role}</strong><time>{new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></header>
      {message.reasoning && <div className="reasoning-summary"><Icon name="thought-bubble-outline" /><span>{briefReasoning(message.reasoning)}</span></div>}
      {visibleContent && <div className="markdown"><MarkdownContent>{visibleContent}</MarkdownContent></div>}
      {!!message.images?.length && <div className="message-images">{message.images.map((source, index) => <StableImage key={source + index} source={source} index={index} />)}</div>}
    </div>
  </article>;
});

function collectionRevision(items: Array<Session | Project>) {
  return items.map((item) => {
    if ('mode' in item) return [item.id, item.updated_at, item.title, item.mode, item.model, item.project_id, item.deleted_at, item.last_event_seq].join('\u0000');
    return [item.id, item.updated_at, item.name, item.workspace].join('\u0000');
  }).join('\u0001');
}

function sessionMetadataChanged(current: Session, summary: Session) {
  return current.title !== summary.title
    || current.model !== summary.model
    || current.mode !== summary.mode
    || current.project_id !== summary.project_id
    || current.workspace !== summary.workspace
    || current.deleted_at !== summary.deleted_at
    || current.work_archive_path !== summary.work_archive_path;
}

type TimelineToolCard = {
  callId: string;
  tool: string;
  arguments: unknown;
  result: unknown;
  error: string;
  status: 'running' | 'completed' | 'failed';
  seq: number;
  createdAt: string;
  childEvents: RuntimeEvent[];
  childOutput: string;
};

type TimelineItem =
  | { kind: 'message'; key: string; createdAt: string; message: Message }
  | { kind: 'tool'; key: string; createdAt: string; card: TimelineToolCard };

function buildTimelineToolCards(events: RuntimeEvent[]) {
  const byId = new Map<string, TimelineToolCard>();
  const ensure = (callId: string, event: RuntimeEvent, tool = 'subagent') => {
    if (!byId.has(callId)) byId.set(callId, {
      callId,
      tool,
      arguments: '',
      result: '',
      error: '',
      status: 'running',
      seq: event.seq,
      createdAt: event.created_at,
      childEvents: [],
      childOutput: ''
    });
    return byId.get(callId)!;
  };
  events.forEach((event) => {
    const callId = String(event.call_id || event.data.call_id || '');
    if (!callId) return;
    if (event.type === 'tool_call.started') {
      const card = ensure(callId, event, String(event.data.tool || 'tool'));
      card.tool = String(event.data.tool || card.tool);
      card.arguments = event.data.arguments;
    } else if (event.type === 'tool_call.completed') {
      const card = ensure(callId, event, String(event.data.tool || 'tool'));
      card.tool = String(event.data.tool || card.tool);
      card.status = event.data.success ? 'completed' : 'failed';
      card.result = event.data.data;
      card.error = String(event.data.error || '');
    } else if (event.type === 'subagent.started') {
      const card = ensure(callId, event, 'subagent');
      card.tool = 'subagent · ' + String(event.data.template || 'general');
    } else if (event.type === 'subagent.event') {
      ensure(callId, event, 'subagent').childEvents.push(event);
    } else if (event.type === 'subagent.completed') {
      const card = ensure(callId, event, 'subagent');
      card.status = event.data.status === 'completed' ? 'completed' : 'failed';
      card.childOutput = String(event.data.output || '');
      card.error = String(event.data.error?.message || event.data.error || '');
    }
  });
  return Array.from(byId.values()).sort((a, b) => a.seq - b.seq);
}

function InlineToolCard({ card }: { card: TimelineToolCard }) {
  const running = card.status === 'running';
  const isSubagent = card.tool.startsWith('subagent');
  const childLatest = card.childEvents.slice(-5);
  return <article className="timeline-tool">
    <details className={'tool-card ' + card.status} open={running || undefined}>
      <summary>
        <span className="tool-card-icon"><Icon name={isSubagent ? 'account-multiple-outline' : 'wrench-outline'} /></span>
        <span className="tool-card-title"><b>{isSubagent ? '子代理' : card.tool}</b>{isSubagent && <small>{card.tool.replace(/^subagent\s*·?\s*/, '')}</small>}</span>
        <span className="tool-card-state"><Icon name={running ? 'loading' : card.status === 'completed' ? 'check-circle-outline' : 'alert-circle-outline'} className={running ? 'spin' : ''} />{running ? '运行中' : card.status === 'completed' ? '已完成' : '失败'}</span>
        <Icon name="chevron-down" className="tool-card-chevron" />
      </summary>
      <div className="tool-card-body">
        {formatPayload(card.arguments) && <div><label>输入</label><pre>{formatPayload(card.arguments)}</pre></div>}
        {childLatest.length > 0 && <div><label>子代理事件</label><div className="child-event-list">{childLatest.map((event) => <span key={event.id}><Icon name={/failed/.test(String(event.data.child_event?.type)) ? 'alert-circle-outline' : 'circle-small'} /><b>{String(event.data.child_event?.type || '')}</b><small>{String(event.data.child_event?.data?.text || event.data.child_event?.data?.tool || '')}</small></span>)}</div></div>}
        {formatPayload(card.result) && <div><label>输出</label><pre>{formatPayload(card.result)}</pre></div>}
        {card.childOutput && <div><label>子代理结果</label><div className="tool-card-output"><ReactMarkdown remarkPlugins={[remarkGfm]}>{card.childOutput}</ReactMarkdown></div></div>}
        {card.error && <div className="tool-card-error"><Icon name="alert-circle-outline" />{card.error}</div>}
      </div>
    </details>
  </article>;
}

const MessageTimeline = React.memo(function MessageTimeline({ items, mode }: { items: TimelineItem[]; mode?: Session['mode'] }) {
  return <Virtuoso
    className="message-list"
    data={items}
    computeItemKey={(_, item) => item.key}
    followOutput="smooth"
    itemContent={(_, item) => item.kind === 'message' ? <MessageView message={item.message} mode={mode} /> : <InlineToolCard card={item.card} />}
  />;
});

function InspectorPane({ session, events, onClose }: { session: Session | null; events: RuntimeEvent[]; onClose: () => void }) {
  const toolCount = events.filter((event) => event.type === 'tool_call.completed').length;
  const subagentCount = events.filter((event) => event.type === 'subagent.started').length;
  const latestRun = [...events].reverse().find((event) => event.type.startsWith('run.'));
  return <aside className="inspector-pane">
    <header><span>会话检查器</span><button title="关闭检查器" onClick={onClose}><Icon name="close" /></button></header>
    <section><h3>会话</h3><dl><dt>ID</dt><dd title={session?.id}>{session?.id || '—'}</dd><dt>模型</dt><dd>{session?.model || '—'}</dd><dt>消息</dt><dd>{session?.messages?.length || 0}</dd></dl></section>
    <section><h3>运行</h3><dl><dt>状态</dt><dd>{latestRun?.type.replace('run.', '') || 'idle'}</dd><dt>事件</dt><dd>{events.length}</dd><dt>工具</dt><dd>{toolCount}</dd><dt>子代理</dt><dd>{subagentCount}</dd></dl></section>
    <section><h3>工作区</h3><p title={session?.workspace}>{session?.workspace || '未选择工作区'}</p></section>
  </aside>;
}

function ActivityBar() {
  const { activity, set } = useAppStore();
  return <nav className="activity-bar" aria-label="主活动栏">
    <div className="brand" title="WebAgent"><span>WA</span></div>
    <div className="activity-primary">
      {activities.map((item) => <button key={item.id} className={activity === item.id ? 'active' : ''} aria-label={item.label} title={item.label} onClick={() => set({ activity: item.id })}><Icon name={item.icon} /></button>)}
    </div>
    <div className="activity-secondary">
      <button className={activity === 'accounts' ? 'active' : ''} aria-label="账户" title="Provider 账户" onClick={() => set({ activity: 'accounts', selectedCapability: null })}><Icon name="account-circle-outline" /></button>
      <button className={activity === 'settings' ? 'active' : ''} aria-label="设置" title="设置" onClick={() => set({ activity: 'settings' })}><Icon name="cog-outline" /></button>
    </div>
  </nav>;
}

function SideHeader({ activity, count, onCreate, menuItems = [] }: { activity: string; count?: number; onCreate?: () => void; menuItems?: MenuAction[] }) {
  return <header className="side-header">
    <span>{panelNames[activity] || activity}</span>
    <div>{typeof count === 'number' && <small>{count}</small>}{onCreate && <button onClick={onCreate} title="新建会话"><Icon name="plus" /></button>}{menuItems.length > 0 && <ActionMenu title="更多操作" items={menuItems} />}</div>
  </header>;
}

function SessionPanel({ onSelect, onCreate, onCreateProject, onCreateWork, onViewChange, onRefresh, trashed, onRename, onDelete, onRestore, onPermanentDelete }: { onSelect: (session: Session) => void; onCreate: () => void; onCreateProject: () => void; onCreateWork: () => void; onViewChange: (view: 'chat' | 'projects' | 'work' | 'trash') => void; onRefresh: () => void; trashed: Session[]; onRename: (session: Session) => void; onDelete: (session: Session) => void; onRestore: (session: Session) => void; onPermanentDelete: (session: Session) => void }) {
  const { sessions, current, projects, sessionView: view } = useAppStore();
  const [query, setQuery] = React.useState('');
  const source = view === 'trash' ? trashed : view === 'projects' ? sessions.filter((session) => session.mode === 'project') : view === 'work' ? sessions.filter((session) => session.mode === 'work') : sessions.filter((session) => session.mode === 'chat');
  const filtered = source.filter((session) => session.title.toLowerCase().includes(query.toLowerCase()));
  const row = (session: Session) => <div role="button" tabIndex={0} key={session.id} className={current?.id === session.id ? 'selected' : ''} onClick={() => onSelect(session)} onKeyDown={(event) => { if (event.key === 'Enter') onSelect(session); }}>
    <Icon name={session.mode === 'project' ? 'folder-code-outline' : session.mode === 'work' ? 'briefcase-outline' : 'message-text-outline'} /><span><b>{session.title}</b><small>{session.mode === 'project' ? '项目 · ' : session.mode === 'work' ? '工作 · ' : ''}{session.model} · {new Date(session.updated_at).toLocaleDateString()}</small></span>
    <span className="session-actions">{view === 'trash' ? <><button title="恢复" onClick={(event) => { event.stopPropagation(); onRestore(session); }}><Icon name="restore" /></button><button className="danger" title="永久删除（同步删除网页端）" onClick={(event) => { event.stopPropagation(); onPermanentDelete(session); }}><Icon name="delete-forever-outline" /></button></> : <><button title="重命名" onClick={(event) => { event.stopPropagation(); onRename(session); }}><Icon name="pencil-outline" /></button><button title="移到回收站" onClick={(event) => { event.stopPropagation(); onDelete(session); }}><Icon name="delete-outline" /></button></>}</span>
  </div>;
  return <>
    <SideHeader activity="sessions" count={sessions.length} onCreate={view === 'projects' ? () => onCreateProject() : view === 'work' ? () => onCreateWork() : view === 'trash' ? undefined : () => onCreate()} menuItems={[
      { label: '新建项目', icon: 'folder-plus-outline', onClick: onCreateProject },
      { label: '新建工作会话', icon: 'briefcase-plus-outline', onClick: onCreateWork },
      { label: '刷新会话', icon: 'refresh', onClick: onRefresh },
      { label: '打开当前工作区', icon: 'folder-open-outline', disabled: !current?.workspace, onClick: async () => { if (current?.workspace) await window.webagent.revealWorkspace(current.workspace); } },
      { label: '复制当前工作区路径', icon: 'content-copy', disabled: !current?.workspace, onClick: async () => { if (current?.workspace) await window.webagent.writeClipboard(current.workspace); } },
      { label: '复制当前会话 ID', icon: 'content-copy', disabled: !current, onClick: async () => { if (current) await window.webagent.writeClipboard(current.id); } }
    ]} />
    <label className="side-search"><Icon name="magnify" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索会话" /><kbd>⌘K</kbd></label>
    <div className="session-filters"><button className={view === 'chat' ? 'active' : ''} onClick={() => onViewChange('chat')}>对话</button><button className={view === 'projects' ? 'active' : ''} onClick={() => onViewChange('projects')}>项目</button><button className={view === 'work' ? 'active' : ''} onClick={() => onViewChange('work')}>工作</button><button className={view === 'trash' ? 'active' : ''} onClick={() => onViewChange('trash')} title="回收站"><Icon name="delete-outline" /></button></div>
    <div className="session-list">{view === 'projects' ? projects.map((project: Project) => <React.Fragment key={project.id}><div className="section-caption project-caption" title={project.workspace}><Icon name="folder-outline" /><span>{project.name}</span><button title="在资源管理器中打开项目" onClick={() => void window.webagent.revealWorkspace(project.workspace)}><Icon name="folder-open-outline" /></button><button title="复制项目路径" onClick={() => void window.webagent.writeClipboard(project.workspace)}><Icon name="content-copy" /></button></div>{filtered.filter((session) => session.project_id === project.id).map(row)}</React.Fragment>) : filtered.map(row)}</div>
  </>;
}

function TreeNode({ item, workspace, depth, onFile }: { item: Capability; workspace: string; depth: number; onFile: (path: string) => void }) {
  const [open, setOpen] = React.useState(false);
  const [children, setChildren] = React.useState<Capability[] | null>(null);
  const toggle = async () => {
    if (item.kind !== 'directory') { onFile(item.path || item.id); return; }
    const next = !open;
    setOpen(next);
    if (next && children === null) {
      try {
        const response = await window.webagent.request<{ data: Capability[] }>('/api/workspace/tree?workspace=' + encodeURIComponent(workspace) + '&path=' + encodeURIComponent(item.path || item.id));
        setChildren(response.data.data);
      } catch { setChildren([]); }
    }
  };
  return <>
    <button className="tree-row" style={{ paddingLeft: 7 + depth * 14 }} onClick={toggle} title={item.path || item.label}>
      <Icon name={item.kind === 'directory' ? (open ? 'chevron-down' : 'chevron-right') : 'blank'} className="tree-chevron" />
      <Icon name={item.kind === 'directory' ? (open ? 'folder-open-outline' : 'folder-outline') : fileIcon(item.label)} className={'tree-type ' + item.kind} />
      <span>{item.label}</span>
    </button>
    {open && children?.map((child) => <TreeNode key={child.id} item={child} workspace={workspace} depth={depth + 1} onFile={onFile} />)}
  </>;
}

function ExplorerPanel({ onChooseWorkspace, onFile }: { onChooseWorkspace: () => void; onFile: (path: string) => void }) {
  const workspace = useAppStore((state) => state.current?.workspace || '');
  const [items, setItems] = React.useState<Capability[]>([]);
  const [refreshKey, setRefreshKey] = React.useState(0);
  React.useEffect(() => {
    if (!workspace) return setItems([]);
    window.webagent.request<{ data: Capability[] }>('/api/workspace/tree?workspace=' + encodeURIComponent(workspace))
      .then((response) => setItems(response.data.data)).catch(() => setItems([]));
  }, [workspace, refreshKey]);
  const folderName = workspace ? workspace.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '未选择工作区';
  return <><SideHeader activity="files" menuItems={[
    { label: '选择工作区', icon: 'folder-open-outline', onClick: onChooseWorkspace },
    { label: '在资源管理器中打开', icon: 'folder-open-outline', disabled: !workspace, onClick: async () => { if (workspace) await window.webagent.revealWorkspace(workspace); } },
    { label: '复制工作区路径', icon: 'content-copy', disabled: !workspace, onClick: async () => { if (workspace) await window.webagent.writeClipboard(workspace); } },
    { label: '刷新文件树', icon: 'refresh', onClick: () => setRefreshKey((value) => value + 1) }
  ]} /><div className="section-caption explorer-root"><Icon name="chevron-down" /><span>{folderName}</span></div><div className="tree">{items.map((item) => <TreeNode key={item.id} item={item} workspace={workspace} depth={0} onFile={onFile} />)}</div></>;
}

function GenericPanel({ activity, onUse }: { activity: string; onUse: (item: Capability) => void }) {
  const current = useAppStore((state) => state.current);
  const [items, setItems] = React.useState<Capability[]>([]);
  const [refreshKey, setRefreshKey] = React.useState(0);
  React.useEffect(() => {
    const workspace = encodeURIComponent(current?.workspace || '');
    window.webagent.request<{ data: Capability[] }>('/api/capabilities/' + activity + '?workspace=' + workspace)
      .then((response) => setItems(response.data.data)).catch(() => setItems([]));
  }, [activity, current?.workspace, refreshKey]);
  const kindIcons: Record<string, string> = { agent: 'account-outline', tool: 'wrench-outline', mcp: 'server-network-outline', skill: 'lightning-bolt-outline', plugin: 'puzzle-outline', bot: 'robot-outline', task: 'clock-outline', provider: 'web', model: 'brain' };
  return <><SideHeader activity={activity} count={items.length} menuItems={[{ label: '刷新列表', icon: 'refresh', onClick: () => setRefreshKey((value) => value + 1) }]} /><div className="feature-list">{items.map((item) => <button key={item.id} title={item.description || item.label} onClick={() => onUse(item)}><Icon name={kindIcons[item.kind] || 'circle-small'} /><span><b>{item.label}</b>{item.description && <small>{item.description}</small>}</span><Icon name="chevron-right" className="feature-arrow" /></button>)}</div>
    {activity === 'settings' && <section className="provider-actions"><h3>Provider 账户</h3><button onClick={() => window.webagent.request('/api/providers/deepseek/login', { method: 'POST' }).catch(() => {})}><Icon name="login" /><span>登录 DeepSeek</span></button><button onClick={() => window.webagent.request('/api/providers/qwen/login', { method: 'POST' }).catch(() => {})}><Icon name="login" /><span>登录千问</span></button></section>}
  </>;
}

function BottomPanel() {
  const { events, bottomOpen, set } = useAppStore();
  const [tab, setTab] = React.useState<'logs' | 'subagents' | 'problems'>('logs');
  if (!bottomOpen) return null;
  const relevant = events.filter((event) => tab === 'subagents' ? /^(?:subagent|agent_cluster)\./.test(event.type) : tab === 'problems' ? /failed|error/.test(event.type) : /tool|subagent|agent_cluster|approval|provider|run\./.test(event.type));
  return <section className="bottom-panel">
    <header><div>{([['logs', '运行日志'], ['subagents', 'Agent 运行'], ['problems', '问题']] as const).map(([id, name]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{name}</button>)}</div><button title="关闭面板" onClick={() => set({ bottomOpen: false })}><Icon name="close" /></button></header>
    <div className="event-log">{relevant.length ? relevant.map((event) => <div key={event.id} className={/failed/.test(event.type) ? 'failed' : ''}><time>#{event.seq}</time><b>{event.type}</b><span>{String(event.data.tool || event.data.template || event.data.provider || event.data.error?.message || '')}</span></div>) : <div className="empty-state"><Icon name="check-circle-outline" /> 当前没有相关事件</div>}</div>
  </section>;
}

function Composer({ draft, setDraft, send, chooseWorkspace, attachFiles, pendingImages, removeImage }: { draft: string; setDraft: (value: string) => void; send: () => void; chooseWorkspace: () => void; attachFiles: () => void; pendingImages: PendingImage[]; removeImage: (index: number) => void }) {
  const state = useAppStore();
  const mode = state.current?.mode || 'chat';
  const modelId = state.current?.model || state.models[0]?.id || '';
  const model = state.models.find((item) => item.id === modelId);
  const supportsThinking = !!model?.capabilities?.deepThink || modelId === 'deepseek.web';
  const reasoningEffortLabels: Record<ReasoningEffort, string> = { none: '关闭', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大', auto: '自动' };
  const modelReasoningEfforts = (Array.isArray(model?.capabilities?.reasoningEfforts) ? model.capabilities.reasoningEfforts : [])
    .filter((effort: string): effort is ReasoningEffort => Object.prototype.hasOwnProperty.call(reasoningEffortLabels, effort));
  const selectedReasoningEffort = modelReasoningEfforts.includes(state.reasoningEffort) ? state.reasoningEffort : (state.reasoningEffort === 'none' ? 'none' : 'high');
  const supportsSearch = !!model?.capabilities?.webSearch || modelId === 'deepseek.web';
  const supportsImages = !!model?.capabilities?.multimodal?.input?.includes?.('image');
  const addClipboard = async () => {
    const text = await window.webagent.readClipboard();
    if (text) setDraft(draft + (draft ? '\n\n' : '') + '<context>\n' + text + '\n</context>');
  };
  return <div className="composer-wrap">
    <div className="composer">
      {!!pendingImages.length && <div className="composer-images">{pendingImages.map((image, index) => <span key={image.name + ':' + index}><Icon name="image-outline" />{image.name}<button title="移除图片" onClick={() => removeImage(index)}><Icon name="close" /></button></span>)}</div>}
      <textarea rows={2} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); } }} placeholder={mode === 'chat' ? '与 WebAgent 对话（不会执行本地工具）' : mode === 'work' ? '快速完成办公任务，结果自动归档并写入记忆' : '让 WebAgent 分析、修改并验证当前项目'} />
      <div className="composer-bar"><div className="composer-tools"><ActionMenu title="添加上下文" icon="plus" items={[
        { label: '附加工作区', icon: 'folder-open-outline', disabled: mode !== 'project', onClick: chooseWorkspace },
        { label: '粘贴剪贴板内容', icon: 'clipboard-text-outline', onClick: addClipboard },
        { label: '引用当前工作区', icon: 'source-branch', disabled: mode !== 'project' || !state.current?.workspace, onClick: () => setDraft(draft + (draft ? '\n' : '') + `@workspace("${state.current?.workspace}")`) }
      ]} />
        {(mode !== 'chat' || supportsImages) && <button title={supportsImages ? '附加图片' : '附加文件'} onClick={attachFiles}><Icon name="paperclip" /></button>}
        <ModelPicker models={state.models} value={modelId} disabled={!state.current} onChange={async (nextModel) => { if (!state.current) return; await window.webagent.request('/api/sessions/' + state.current.id, { method: 'PATCH', body: { model: nextModel } }); state.set({ current: { ...state.current, model: nextModel } }); }} />
        <span className="composer-divider" />
        {modelReasoningEfforts.length ? <label className={'reasoning-effort-picker ' + (selectedReasoningEffort !== 'none' ? 'active' : '')} title="思考强度"><Icon name="brain" /><select aria-label="思考强度" value={selectedReasoningEffort} onChange={(event) => state.set({ reasoningEffort: event.target.value as ReasoningEffort })}>{modelReasoningEfforts.map((effort) => <option key={effort} value={effort}>思考 · {reasoningEffortLabels[effort]}</option>)}</select></label>
          : <button className={'mode-toggle ' + (supportsThinking && state.reasoningEffort !== 'none' ? 'active' : '')} aria-pressed={supportsThinking && state.reasoningEffort !== 'none'} disabled={!supportsThinking} title={supportsThinking ? '切换深度思考' : '当前模型不支持深度思考'} onClick={() => state.set({ reasoningEffort: state.reasoningEffort === 'none' ? 'high' : 'none' })}><Icon name="brain" /><span>深度思考</span></button>}
        <button className={'mode-toggle ' + (supportsSearch && state.webSearch ? 'active' : '')} aria-pressed={supportsSearch && state.webSearch} disabled={!supportsSearch} title={supportsSearch ? '切换联网搜索' : '当前模型不支持联网搜索'} onClick={() => state.set({ webSearch: !state.webSearch })}><Icon name="web" /><span>联网搜索</span></button>
      </div><button className="send" aria-label="发送" disabled={state.busy || !draft.trim()} onClick={send}><Icon name={state.busy ? 'loading' : 'arrow-up'} className={state.busy ? 'spin' : ''} /></button></div>
    </div>
    <div className="composer-hint"><span className={'mode-pill ' + mode}>{mode === 'chat' ? '对话 · 仅原生思考/搜索与离线可视化' : mode === 'project' ? '项目 · 完整工具与 Agent 集群' : `工作 · 记忆开启 · ${state.current?.work_archive_path || '自动归档'}`}</span><span>Enter 发送 · Shift+Enter 换行</span></div>
    {state.error && <div className="error-banner"><Icon name="alert-circle-outline" />{state.error}</div>}
  </div>;
}

function App() {
  const state = useAppStore();
  const [draft, setDraft] = React.useState('');
  const [pendingImages, setPendingImages] = React.useState<PendingImage[]>([]);
  const [runtimeOnline, setRuntimeOnline] = React.useState(false);
  const [trashed, setTrashed] = React.useState<Session[]>([]);
  const stopRef = React.useRef<null | (() => void)>(null);
  const trashRevisionRef = React.useRef('');

  const reloadSessions = React.useCallback(async () => {
    const [response, trash, projects] = await Promise.all([
      window.webagent.request<{ data: Session[] }>('/api/sessions'),
      window.webagent.request<{ data: Session[] }>('/api/sessions?deleted=1'),
      window.webagent.request<{ data: Project[] }>('/api/projects')
    ]);
    const store = useAppStore.getState();
    const currentSummary = store.current && response.data.data.find((session) => session.id === store.current?.id);
    const patch: Partial<ReturnType<typeof useAppStore.getState>> = {};
    if (collectionRevision(store.sessions) !== collectionRevision(response.data.data)) patch.sessions = response.data.data;
    if (collectionRevision(store.projects) !== collectionRevision(projects.data.data)) patch.projects = projects.data.data;
    if (store.current && !currentSummary) {
      // A session may have been permanently deleted by another client while
      // this renderer was open. Never keep its stale transcript or tab alive.
      if (stopRef.current) stopRef.current();
      stopRef.current = null;
      patch.current = null;
      patch.events = [];
      patch.liveText = '';
      patch.statusText = '';
      patch.busy = false;
      patch.error = '';
      patch.inspectorOpen = false;
    } else if (currentSummary && store.current && sessionMetadataChanged(store.current, currentSummary)) {
      patch.current = { ...currentSummary, messages: store.current.messages };
    }
    if (Object.keys(patch).length) store.set(patch);
    const nextTrashRevision = collectionRevision(trash.data.data);
    if (trashRevisionRef.current !== nextTrashRevision) {
      trashRevisionRef.current = nextTrashRevision;
      setTrashed(trash.data.data);
    }
  }, []);

  const selectSession = React.useCallback(async (session: Session) => {
    if (stopRef.current) stopRef.current();
    setPendingImages([]);
    let response;
    try {
      response = await window.webagent.request<Session>('/api/sessions/' + encodeURIComponent(session.id));
    } catch (error: any) {
      if (error?.status === 404 || error?.code === 'session_not_found') {
        useAppStore.getState().set({ current: null, events: [], liveText: '', statusText: '', busy: false, error: '' });
        await reloadSessions();
        return;
      }
      throw error;
    }
    useAppStore.getState().set({
      current: response.data,
      sessionView: response.data.deleted_at ? 'trash' : response.data.mode === 'project' ? 'projects' : response.data.mode,
      events: [], liveText: '', statusText: '', error: '', busy: false
    });
    stopRef.current = await window.webagent.subscribe(session.id, 0, async (event: RuntimeEvent) => {
      useAppStore.getState().pushEvent(event);
      if (/run\.(completed|failed|cancelled)/.test(event.type)) {
        const refreshed = await window.webagent.request<Session>('/api/sessions/' + encodeURIComponent(session.id));
        useAppStore.getState().set({ current: refreshed.data, liveText: '' });
        reloadSessions();
      }
    });
  }, [reloadSessions]);

  React.useEffect(() => {
    Promise.all([window.webagent.request<{ data: any[] }>('/v1/models'), window.webagent.request<{ data: Session[] }>('/api/sessions'), window.webagent.request<{ data: Project[] }>('/api/projects'), window.webagent.runtimeInfo()])
      .then(([models, sessions, projects]) => {
        state.set({ models: models.data.data, sessions: sessions.data.data, projects: projects.data.data });
        setRuntimeOnline(true);
      }).catch((error) => state.set({ error: error.message }));
    const sessionRefresh = window.setInterval(reloadSessions, 2500);
    return () => { window.clearInterval(sessionRefresh); if (stopRef.current) stopRef.current(); };
  }, []);

  React.useEffect(() => {
    localStorage.setItem('webagent-theme', state.theme);
  }, [state.theme]);

  React.useEffect(() => {
    localStorage.setItem('webagent-reasoning-effort', state.reasoningEffort);
    localStorage.setItem('webagent-deep-think', String(state.reasoningEffort !== 'none'));
    localStorage.setItem('webagent-web-search', String(state.webSearch));
  }, [state.reasoningEffort, state.webSearch]);

  React.useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        const store = useAppStore.getState();
        store.set({ theme: store.theme === 'dark' ? 'light' : 'dark' });
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);

  const createSession = async () => {
    const response = await window.webagent.request<Session>('/api/sessions', { method: 'POST', body: { title: '新会话', mode: 'chat', workspace: '', model: state.models[0]?.id || 'deepseek.web' } });
    await reloadSessions();
    await selectSession(response.data);
    return response.data;
  };

  const createProject = async (selectedWorkspace?: string) => {
    const workspace = selectedWorkspace || await window.webagent.chooseWorkspace(); if (!workspace) return;
    const name = workspace.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '项目';
    const existing = state.projects.find((item) => item.workspace.toLowerCase() === workspace.toLowerCase());
    const project = existing || (await window.webagent.request<Project>('/api/projects', { method: 'POST', body: { name, workspace } })).data;
    const session = await window.webagent.request<Session>('/api/sessions', { method: 'POST', body: { title: '新项目会话', mode: 'project', project_id: project.id, workspace, model: state.models[0]?.id || 'deepseek.web' } });
    await reloadSessions(); await selectSession(session.data);
    return session.data;
  };

  const createWork = async () => {
    const session = await window.webagent.request<Session>('/api/sessions', { method: 'POST', body: { title: '新工作会话', mode: 'work', work_root: 'D:\\Work\\WAWorkSpace', model: state.models[0]?.id || 'deepseek.web' } });
    await reloadSessions();
    await selectSession(session.data);
    return session.data;
  };

  const chooseWorkspace = async () => {
    const workspace = await window.webagent.chooseWorkspace();
    if (!workspace) return;
    if (!state.current) {
      await createProject(workspace);
    } else {
      let project = state.projects.find((item) => item.workspace.toLowerCase() === workspace.toLowerCase());
      if (!project) project = (await window.webagent.request<Project>('/api/projects', { method: 'POST', body: { name: workspace.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '项目', workspace } })).data;
      const updated = await window.webagent.request<Session>('/api/sessions/' + state.current.id, { method: 'PATCH', body: { workspace, mode: 'project', project_id: project.id } });
      state.set({ current: updated.data });
    }
    state.set({ activity: 'files' });
  };

  const attachFiles = async () => {
    const activeModel = state.models.find((model) => model.id === state.current?.model);
    const supportsImages = !!activeModel?.capabilities?.multimodal?.input?.includes?.('image') || state.current?.model === 'deepseek.web';
    if (supportsImages) {
      const images = await window.webagent.chooseImages();
      if (images.length) setPendingImages((current) => current.concat(images));
      return;
    }
    const files = await window.webagent.chooseFiles();
    if (!files.length) return;
    const references = files.map((file) => `@file("${file}")`).join('\n');
    setDraft((value) => value + (value ? '\n' : '') + references);
  };

  const closeSession = () => {
    if (stopRef.current) stopRef.current();
    stopRef.current = null;
    setPendingImages([]);
    state.set({ current: null, events: [], liveText: '', statusText: '', busy: false, inspectorOpen: false });
  };

  const switchSessionView = (view: 'chat' | 'projects' | 'work' | 'trash') => {
    const snapshot = useAppStore.getState();
    const current = snapshot.current;
    const currentView = current?.mode === 'project' ? 'projects' : current?.mode;
    if (snapshot.busy && current && currentView !== view) {
      state.set({ error: '当前会话仍在运行，请完成或取消后再切换模式。' });
      return;
    }
    if (view === 'trash' || (current && currentView !== view)) {
      if (stopRef.current) stopRef.current();
      stopRef.current = null;
      state.set({ sessionView: view, current: null, events: [], liveText: '', statusText: '', busy: false, inspectorOpen: false });
      return;
    }
    state.set({ sessionView: view });
  };

  const renameSession = async () => {
    if (!state.current) return;
    const title = window.prompt('重命名会话', state.current.title)?.trim();
    if (!title || title === state.current.title) return;
    const updated = await window.webagent.request<Session>('/api/sessions/' + state.current.id, { method: 'PATCH', body: { title } });
    state.set({ current: updated.data });
    await reloadSessions();
  };

  const renameAnySession = async (session: Session) => {
    const title = window.prompt('重命名会话', session.title)?.trim(); if (!title || title === session.title) return;
    await window.webagent.request('/api/sessions/' + session.id, { method: 'PATCH', body: { title, title_mode: 'user' } }); await reloadSessions();
    if (state.current?.id === session.id) state.set({ current: { ...state.current, title, title_mode: 'user' } });
  };
  const deleteSession = async (session: Session) => {
    await window.webagent.request('/api/sessions/' + session.id, { method: 'DELETE' });
    if (state.current?.id === session.id) closeSession(); await reloadSessions();
  };
  const permanentlyDeleteSession = async (session: Session) => {
    if (!window.confirm(`永久删除“${session.title}”？\n\n这会同步删除 DeepSeek、Qwen 或 ChatGPT 网页端对话（如有），且无法恢复。`)) return;
    try {
      await window.webagent.request('/api/sessions/' + session.id + '?permanent=1&remote=1', { method: 'DELETE' });
      if (state.current?.id === session.id) closeSession();
      await reloadSessions();
    } catch (error: any) {
      const message = error?.message || '永久删除失败；本地记录已保留';
      state.set({ error: message });
      window.alert(message);
    }
  };
  const restoreSession = async (session: Session) => { await window.webagent.request('/api/sessions/' + session.id + '/restore', { method: 'POST' }); await reloadSessions(); };

  const useCapability = async (item: Capability) => {
    if (item.kind === 'model' && state.current) {
      const model = item.id.replace(/^model\//, '');
      await window.webagent.request('/api/sessions/' + state.current.id, { method: 'PATCH', body: { model } });
      state.set({ current: { ...state.current, model }, selectedCapability: item });
      return;
    }
    if (item.kind === 'provider' && /deepseek|qwen|chatgpt/.test(item.id)) {
      await window.webagent.request('/api/providers/' + item.id + '/login', { method: 'POST' });
      return;
    }
    state.set({ selectedCapability: item });
  };

  const send = async () => {
    if (!draft.trim() || state.busy) return;
    let current = state.current;
    if (!current) {
      current = (state.sessionView === 'projects'
        ? await createProject()
        : state.sessionView === 'work'
          ? await createWork()
          : await createSession()) ?? null;
      if (!current) return;
    }
    const promptText = draft.trim();
    const prompt: string | Array<Record<string, string>> = pendingImages.length
      ? [{ type: 'text', text: promptText }, ...pendingImages.map((image) => ({ type: 'image', data: image.data, mimeType: image.mimeType, name: image.name }))]
      : promptText;
    setDraft('');
    setPendingImages([]);
    state.set({ busy: true, liveText: '', statusText: '正在准备模型和工作区…', error: '' });
    try {
      const reasoningEffort = current.model === 'deepseek.web' && state.reasoningEffort !== 'none' ? 'high' : state.reasoningEffort;
      await window.webagent.request('/api/sessions/' + encodeURIComponent(current.id) + '/runs', { method: 'POST', body: { prompt, model: current.model, agent_mode: current.mode !== 'chat', deep_think: reasoningEffort !== 'none', reasoning_effort: reasoningEffort, web_search: current.model.startsWith('deepseek.') && state.webSearch } });
      const refreshed = await window.webagent.request<Session>('/api/sessions/' + encodeURIComponent(current.id));
      state.set({ current: refreshed.data });
    } catch (error: any) { state.set({ busy: false, error: error.message }); }
  };

  const messages = React.useMemo(() => (state.current?.messages || []).filter((message) => message.role !== 'tool'
    && !message.hidden
    && !(state.current?.mode !== 'chat' && message.role === 'assistant' && containsToolProtocol(String(message.content || '')))
    && (String(message.content || '').trim() || String(message.reasoning || '').trim())), [state.current?.messages, state.current?.mode]);
  const visibleLiveText = state.current?.mode === 'chat' ? state.liveText : cleanVisibleAssistant(state.liveText);
  const authEvent = [...state.events].reverse().find((event) => event.type === 'provider.auth_required' || event.type === 'provider.authenticated');
  const liveStatus = authEvent?.type === 'provider.auth_required' ? `等待 ${authEvent.data.provider} 登录完成…` : state.statusText || (state.busy ? '正在准备…' : '');
  const displayMessages = React.useMemo(() => visibleLiveText || state.busy
    ? messages.concat([{ id: 'live', role: 'assistant', content: visibleLiveText, reasoning: liveStatus, created_at: new Date().toISOString() } as Message])
    : messages, [messages, visibleLiveText, state.busy, liveStatus]);
  const timelineItems: TimelineItem[] = React.useMemo(() => [
    ...displayMessages.map((message): TimelineItem => ({ kind: 'message', key: 'message:' + message.id, createdAt: message.created_at, message })),
    ...buildTimelineToolCards(state.events).map((card): TimelineItem => ({ kind: 'tool', key: 'tool:' + card.callId, createdAt: card.createdAt, card }))
  ].sort((left, right) => {
    const timeDelta = (Date.parse(left.createdAt) || 0) - (Date.parse(right.createdAt) || 0);
    if (timeDelta) return timeDelta;
    if (left.kind === right.kind) return 0;
    return left.kind === 'message' ? -1 : 1;
  }), [displayMessages, state.events]);
  const resolvedApprovalIds = new Set(state.events.filter((event) => event.type === 'approval.resolved').map((event) => String(event.data.approval_id || '')));
  const pendingApprovals = state.events.filter((event) => event.type === 'approval.requested' && !resolvedApprovalIds.has(String(event.data.id || '')));
  const chatMode = state.activity === 'sessions' || state.activity === 'files';
  const sidebar = state.activity === 'sessions'
    ? <SessionPanel onSelect={selectSession} onCreate={createSession} onCreateProject={createProject} onCreateWork={createWork} onViewChange={switchSessionView} onRefresh={reloadSessions} trashed={trashed} onRename={renameAnySession} onDelete={deleteSession} onRestore={restoreSession} onPermanentDelete={permanentlyDeleteSession} />
    : state.activity === 'files'
      ? <ExplorerPanel onChooseWorkspace={chooseWorkspace} onFile={(file) => setDraft((value) => value + (value ? '\n' : '') + `@file("${file}")`)} />
      : state.activity === 'accounts' || state.activity === 'settings' || state.activity === 'harness' || state.activity === 'api'
        ? <><SideHeader activity={state.activity} /><div className="sidebar-help">{state.activity === 'accounts' ? '管理网页登录和上游兼容 API。' : state.activity === 'api' ? '选择一个 WebAgent 模型，通过独立 Token 发布为本地 OpenAI 兼容服务。' : state.activity === 'harness' ? '官方 DeepSeek Harness 工作台。模型流量经本地 WebAgent API 转发到已登录的 DeepSeek 网页。' : '搜索并修改用户与项目设置。'}</div></>
        : <GenericPanel activity={state.activity} onUse={useCapability} />;
  return <main className={'workbench ' + state.theme + (state.activity === 'harness' ? ' harness-focus' : '')}>
    <ActivityBar />
    <aside className="primary-sidebar">{sidebar}</aside>
    <section className="editor-area">
      <header className="editor-tabs"><div className="tab active"><Icon name={chatMode ? 'message-text-outline' : state.activity === 'agents' ? 'account-multiple-outline' : state.activity === 'harness' ? 'horse-variant' : state.activity === 'tools' ? 'tools' : state.activity === 'plugins' ? 'puzzle-outline' : state.activity === 'bots' ? 'robot-outline' : state.activity === 'api' ? 'api' : 'cog-outline'} /><span>{chatMode ? state.current?.title || '欢迎' : panelNames[state.activity]}</span>{chatMode && <button title="关闭当前会话" disabled={!state.current} onClick={closeSession}><Icon name="close" /></button>}</div><div className="editor-actions"><button className={state.inspectorOpen ? 'pressed' : ''} title="拆分编辑器 / 会话检查器" disabled={!chatMode} onClick={() => state.set({ inspectorOpen: !state.inspectorOpen })}><Icon name="view-column-outline" /></button><button title="切换主题" onClick={() => state.set({ theme: state.theme === 'dark' ? 'light' : 'dark' })}><Icon name={state.theme === 'dark' ? 'weather-sunny' : 'weather-night'} /></button><button className={state.bottomOpen ? 'pressed' : ''} title="切换面板" onClick={() => state.set({ bottomOpen: !state.bottomOpen })}><Icon name="panel-bottom" /></button><ActionMenu title="更多操作" items={[
        { label: '新建会话', icon: 'plus', onClick: createSession },
        { label: '新建工作会话', icon: 'briefcase-plus-outline', onClick: createWork },
        { label: '重命名会话', icon: 'pencil-outline', disabled: !state.current, onClick: renameSession },
        { label: '恢复自动命名', icon: 'sync', disabled: !state.current || state.current.title_mode === 'auto', onClick: async () => { if (state.current) { const updated = await window.webagent.request<Session>('/api/sessions/' + state.current.id + '/title-mode', { method: 'POST', body: { mode: 'auto' } }); state.set({ current: updated.data }); reloadSessions(); } } },
        { label: '移到回收站', icon: 'delete-outline', disabled: !state.current, onClick: async () => { if (state.current) await deleteSession(state.current); } },
        { label: '打开工作区', icon: 'folder-open-outline', disabled: !state.current?.workspace, onClick: async () => { if (state.current?.workspace) await window.webagent.revealWorkspace(state.current.workspace); } },
        { label: '复制工作区路径', icon: 'content-copy', disabled: !state.current?.workspace, onClick: async () => { if (state.current?.workspace) await window.webagent.writeClipboard(state.current.workspace); } },
        { label: '复制会话 ID', icon: 'content-copy', disabled: !state.current, onClick: async () => { if (state.current) await window.webagent.writeClipboard(state.current.id); } },
        { label: '压缩远端上下文', icon: 'archive-arrow-down-outline', disabled: !state.current, onClick: async () => { if (state.current) { await window.webagent.request('/api/sessions/' + state.current.id + '/compact', { method: 'POST' }); const refreshed = await window.webagent.request<Session>('/api/sessions/' + state.current.id); state.set({ current: refreshed.data }); } } },
        { label: '打开会话检查器', icon: 'information-outline', onClick: () => state.set({ inspectorOpen: true }) }
      ]} /></div></header>
      {chatMode ? <section className={'editor-body ' + (state.inspectorOpen ? 'with-inspector' : '')}><section className="chat-area">
        {timelineItems.length ? <MessageTimeline items={timelineItems} mode={state.current?.mode} /> : <div className="welcome"><div className="welcome-mark">WA</div><h1>开始使用 WebAgent</h1><p>对话、项目与工作三种模式共享同一个本地 Runtime</p><div className="welcome-grid"><button onClick={() => setDraft('请分析当前项目的结构，并指出最值得优先处理的问题。')}><Icon name="folder-search-outline" /><span>分析项目<small>项目模式可读取并修改工作区</small></span></button><button onClick={() => setDraft('请用 wa-plot 绘制 sin(x) 和 cos(x)。')}><Icon name="chart-line" /><span>离线绘图<small>对话模式安全渲染 SVG</small></span></button><button onClick={() => setDraft('请帮我整理今天的工作并归档。')}><Icon name="briefcase-outline" /><span>快速办公<small>工作模式自动记忆与归档</small></span></button></div></div>}
        {pendingApprovals.map((event) => <div className="approval-banner" key={event.data.id}><Icon name="shield-alert-outline" /><span><b>工具请求批准：{String(event.data.tool || '')}</b><small>{String(event.data.risk || '')}</small></span><button className="primary" onClick={() => window.webagent.request('/api/approvals/' + event.data.id, { method: 'POST', body: { approved: true } })}>允许</button><button onClick={() => window.webagent.request('/api/approvals/' + event.data.id, { method: 'POST', body: { approved: false } })}>拒绝</button></div>)}
        <Composer draft={draft} setDraft={setDraft} send={send} chooseWorkspace={chooseWorkspace} attachFiles={attachFiles} pendingImages={pendingImages} removeImage={(index) => setPendingImages((images) => images.filter((_, itemIndex) => itemIndex !== index))} />
      </section>{state.inspectorOpen && <InspectorPane session={state.current} events={state.events} onClose={() => state.set({ inspectorOpen: false })} />}</section> : <section className="feature-editor"><FeatureWorkbench activity={state.activity} selected={state.selectedCapability} /></section>}
      <BottomPanel />
    </section>
    <footer className="status-bar"><div><button className={runtimeOnline ? 'online' : 'offline'} onClick={() => state.set({ bottomOpen: true })}><Icon name={runtimeOnline ? 'check-circle-outline' : 'alert-circle-outline'} /> Runtime</button><button title={state.current?.workspace || ''} onClick={() => state.set({ activity: 'files' })}><Icon name="source-branch" /> {state.current?.workspace || '未选择工作区'}</button></div><div><button onClick={() => state.set({ bottomOpen: true })}><Icon name="account-multiple-outline" /> {state.events.filter((event) => event.type === 'subagent.started').length}</button><button onClick={() => state.set({ activity: 'accounts' })}><Icon name="brain" /> {state.current?.model || '未选择模型'}</button><button onClick={() => state.set({ bottomOpen: true })}>{state.busy ? <><Icon name="loading" className="spin" /> 运行中</> : <><Icon name="check" /> 就绪</>}</button><button title="查看问题" onClick={() => state.set({ bottomOpen: true })}><Icon name="bell-outline" /></button></div></footer>
  </main>;
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
