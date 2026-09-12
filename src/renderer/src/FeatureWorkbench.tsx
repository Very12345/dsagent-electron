import React from 'react';
import { useAppStore } from './store';

type Capability = { id: string; label: string; description?: string; kind: string; risk?: string; policy?: string };
const Icon = ({ name }: { name: string }) => <i aria-hidden="true" className={'mdi mdi-' + name} />;
async function request<T = any>(path: string, options?: any) { return (await window.webagent.request<T>(path, options)).data; }

function Empty({ icon = 'information-outline', children }: React.PropsWithChildren<{ icon?: string }>) {
  return <div className="feature-empty"><Icon name={icon} /><p>{children}</p></div>;
}

type QwenGatewayStatus = {
  installed: boolean; configured: boolean; running: boolean; starting: boolean;
  pid: number | null; url: string; upstream_model: string; revision: string;
  deepseek_enabled: boolean; browser_login_reuse: boolean; auth_source: string; error: string; logs: string[];
  models?: Array<{ id: string; name: string; upstream: string }>;
};

function AccountsView() {
  const [configs, setConfigs] = React.useState<any[]>([]);
  const [webProviders, setWebProviders] = React.useState<string[]>([]);
  const [form, setForm] = React.useState({ name: '', endpoint: 'http://127.0.0.1:8000/v1', apiKey: '', model: '', protocol: 'auto' });
  const [gateway, setGateway] = React.useState<QwenGatewayStatus | null>(null);
  const [gatewayForm, setGatewayForm] = React.useState({ username: '', password: '', area_code: '', model: 'qwen3-7-max' });
  const [gatewayBusy, setGatewayBusy] = React.useState('');
  const [message, setMessage] = React.useState('');
  const [deepseekAccounts, setDeepseekAccounts] = React.useState<{ active_account_id: string; failover_order: string[]; browser_visible: boolean; data: any[] }>({ active_account_id: 'default', failover_order: [], browser_visible: false, data: [] });
  const [newAccountName, setNewAccountName] = React.useState('');
  const load = () => Promise.all([request<{ data: any[] }>('/api/provider-configs'), request<{ data: any[] }>('/api/providers'), request<QwenGatewayStatus>('/api/qwen-gateway'), request<{ active_account_id: string; failover_order: string[]; browser_visible: boolean; data: any[] }>('/api/providers/deepseek/accounts')])
    .then(([configsValue, providersValue, gatewayValue, accountsValue]) => { setConfigs(configsValue.data); setWebProviders(providersValue.data.map((item) => item.id)); setGateway(gatewayValue); setDeepseekAccounts(accountsValue); setGatewayForm((value) => ({ ...value, model: gatewayValue.upstream_model || value.model })); })
    .catch(() => { setConfigs([]); setWebProviders([]); });
  React.useEffect(() => { void load(); }, []);
  const login = async (id: string) => {
    setMessage('正在打开 ' + id + ' 登录窗口…');
    try { await request('/api/providers/' + id + '/login', { method: 'POST' }); setMessage(id + ' 登录窗口已打开；完成登录后可手动关闭。'); }
    catch (error: any) {
      setMessage(error.code === 'provider_not_found'
        ? '当前连接的是不支持 ChatGPT 的旧 Runtime。请彻底退出所有 WebAgent 后重新启动。'
        : error.message);
    }
  };
  const accountAction = async (accountId: string, action: 'select' | 'login' | 'delete') => {
    setMessage(action === 'select' ? '正在切换 DeepSeek 账号…' : action === 'login' ? '正在打开此账号的独立登录窗口…' : '正在删除账号配置…');
    try {
      if (action === 'delete') await request('/api/providers/deepseek/accounts/' + encodeURIComponent(accountId), { method: 'DELETE' });
      else await request('/api/providers/deepseek/accounts/' + encodeURIComponent(accountId) + '/' + action, { method: 'POST', body: {} });
      setMessage(action === 'select' ? '已切换；新的 Run 将使用此账号并新建远端对话。' : action === 'login' ? '登录窗口已打开。' : '账号已删除。');
      await load();
    } catch (error: any) { setMessage(error.message); }
  };
  const addDeepseekAccount = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const account = await request<any>('/api/providers/deepseek/accounts', { method: 'POST', body: { name: newAccountName } });
      setNewAccountName('');
      await load();
      await accountAction(account.id, 'login');
    } catch (error: any) { setMessage(error.message); }
  };
  const moveDeepseekAccount = async (accountId: string, offset: number) => {
    const configuredOrder = deepseekAccounts.failover_order || [];
    const order = (configuredOrder.length ? configuredOrder : deepseekAccounts.data.map((account) => account.id)).slice();
    const index = order.indexOf(accountId); const target = index + offset;
    if (index < 0 || target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target], order[index]];
    try {
      setDeepseekAccounts(await request('/api/providers/deepseek/accounts/order', { method: 'PATCH', body: { order } }));
      setMessage('自动切换顺序已保存。');
    } catch (error: any) { setMessage(error.message); }
  };
  const toggleDeepseekBrowser = async () => {
    const visible = !deepseekAccounts.browser_visible;
    setMessage(visible ? '正在切换到可见调试浏览器…' : '正在恢复隐藏浏览器…');
    try {
      setDeepseekAccounts(await request('/api/providers/deepseek/browser-visibility', { method: 'PATCH', body: { visible } }));
      setMessage(visible ? '已开启；下一次 DeepSeek Run 会显示真实浏览器窗口。' : '已关闭；下一次 DeepSeek Run 将在后台运行。');
    } catch (error: any) { setMessage(error.code === 'session_busy' ? 'DeepSeek 正在运行，请在当前 Run 完成后切换。' : error.message); }
  };
  const add = async (event: React.FormEvent) => {
    event.preventDefault(); setMessage('正在保存…');
    try {
      await request('/api/provider-configs', { method: 'POST', body: { name: form.name || 'OpenAI 兼容服务', endpoint: form.endpoint, apiKey: form.apiKey, protocol: form.protocol, models: [{ id: form.model, apiName: form.model, displayName: form.model, capabilities: { multimodal: { input: ['text'], output: ['text'] } } }] } });
      setForm({ ...form, name: '', apiKey: '', model: '' }); setMessage('已保存并重新加载模型'); load();
    } catch (error: any) { setMessage(error.message); }
  };
  const gatewayAction = async (action: 'install' | 'login' | 'start' | 'stop') => {
    setGatewayBusy(action); setMessage(action === 'install' ? '正在安装固定版本的 Rogator 与 Python 依赖…' : action === 'login' ? '正在打开 chat.qwen.ai 独立登录窗口…' : '正在更新 Qianwen 网关状态…');
    try { setGateway(await request<QwenGatewayStatus>('/api/qwen-gateway/' + action, { method: 'POST', body: {} })); setMessage('Qianwen 网关已更新'); }
    catch (error: any) { setMessage(error.message); }
    finally { setGatewayBusy(''); }
  };
  const saveGateway = async (event: React.FormEvent) => {
    event.preventDefault(); setGatewayBusy('account');
    try {
      setGateway(await request<QwenGatewayStatus>('/api/qwen-gateway/account', { method: 'POST', body: gatewayForm }));
      setGatewayForm({ ...gatewayForm, password: '' }); setMessage('Qwen 账号已加密保存；明文只在网关运行期间临时提供给侧车。');
    } catch (error: any) { setMessage(error.message); } finally { setGatewayBusy(''); }
  };
  return <div className="feature-workbench"><header><div><h1>账户与模型服务</h1><p>网页账户与 API Provider 相互独立，密钥仅写入系统安全存储。</p></div></header>
    <section className="settings-section"><h2>网页账户</h2><div className="button-grid">{[
      ['deepseek', 'DeepSeek', 'alpha-d-circle-outline'], ['qwen', '千问', 'creation-outline'], ['chatgpt', 'ChatGPT（实验性）', 'chat-processing-outline']
    ].map(([id, label, icon]) => <button key={id} className={webProviders.length && !webProviders.includes(id) ? 'unsupported' : ''} onClick={() => void login(id)}><Icon name={icon} /><span><b>登录 {label}</b><small>{webProviders.length && !webProviders.includes(id) ? '当前 Runtime 不支持，需要完全重启' : '打开当前账号的独立登录窗口'}</small></span></button>)}</div>{message && <p className="form-message">{message}</p>}</section>
    <section className="settings-section"><h2>DeepSeek 多账号 <small>限速自动切换</small></h2><p>每个账号使用独立浏览器 Profile 与 Cookie。触发限速时按下列顺序切换到下一个已登录账号，并用完整本地历史继续同一 Run；原账号对话保留。</p><div className="button-row"><button className={deepseekAccounts.browser_visible ? 'primary' : ''} onClick={() => void toggleDeepseekBrowser()}><Icon name={deepseekAccounts.browser_visible ? 'eye' : 'eye-off-outline'} />{deepseekAccounts.browser_visible ? '调试浏览器：显示' : '调试浏览器：隐藏'}</button><small>切换时不会中断正在执行的 Run；开启后可直接观察 DeepSeek 原始页面。</small></div>
      <form className="settings-form provider-form" onSubmit={addDeepseekAccount}><label className="wide">账号名称<input required value={newAccountName} onChange={(event) => setNewAccountName(event.target.value)} placeholder="例如：备用账号" /></label><button className="primary" type="submit"><Icon name="account-plus-outline" />添加并登录</button></form>
      <div className="config-list">{deepseekAccounts.data.slice().sort((a, b) => (a.failover_index ?? 999) - (b.failover_index ?? 999)).map((account, index, ordered) => <div key={account.id}><Icon name={account.active ? 'account-check' : 'account-outline'} /><span><b>{index + 1}. {account.name}{account.active ? ' · 当前' : ''}</b><small>{account.id}{account.limited_until && new Date(account.limited_until).getTime() > Date.now() ? ' · 限速至 ' + new Date(account.limited_until).toLocaleTimeString() : account.last_login_at ? ' · 已登录' : ' · 尚未登录'}</small></span><button title="上移" disabled={index === 0} onClick={() => void moveDeepseekAccount(account.id, -1)}><Icon name="arrow-up" /></button><button title="下移" disabled={index === ordered.length - 1} onClick={() => void moveDeepseekAccount(account.id, 1)}><Icon name="arrow-down" /></button><button disabled={account.active} onClick={() => void accountAction(account.id, 'select')}>切换</button><button onClick={() => void accountAction(account.id, 'login')}>登录</button>{account.id !== 'default' && <button className="danger" onClick={() => void accountAction(account.id, 'delete')}>删除</button>}</div>)}</div>
    </section>
    <section className="settings-section"><h2>Qianwen 网关模型 <small>Rogator · 仅启用 Qwen</small></h2>
      <p>模型 ID <code>qwen.gateway</code>。WebAgent 管理消息、工具与 DSH；Rogator 只负责 Qwen 网页协议传输，不加载其 DeepSeek 逆向模块。</p>
      <div className="mobile-status"><span className={gateway?.running ? 'online-dot' : ''} />{gateway?.running ? <>运行于 <code>{gateway.url}</code> · PID {gateway.pid} · {gateway.auth_source === 'qwen_web_cookie' ? '复用 Qwen 网页登录' : '独立账号'}</> : gateway?.installed ? '已安装，尚未运行' : '尚未安装'} · DeepSeek {gateway?.deepseek_enabled ? '已启用' : '未启用'}</div>
      <form className="settings-form provider-form" onSubmit={saveGateway}>
        <label>Qwen 邮箱或手机号<input required value={gatewayForm.username} onChange={(e) => setGatewayForm({ ...gatewayForm, username: e.target.value })} /></label>
        <label>区号（手机号可选）<input value={gatewayForm.area_code} onChange={(e) => setGatewayForm({ ...gatewayForm, area_code: e.target.value })} placeholder="+86" /></label>
        <label>兼容别名默认模型<select value={gatewayForm.model} onChange={(e) => setGatewayForm({ ...gatewayForm, model: e.target.value })}>{(gateway?.models || []).map((model) => <option key={model.id} value={model.upstream}>{model.name}</option>)}</select></label>
        <label>密码<input required type="password" value={gatewayForm.password} onChange={(e) => setGatewayForm({ ...gatewayForm, password: e.target.value })} /></label>
        <button className="primary" disabled={!!gatewayBusy} type="submit"><Icon name="shield-key-outline" />{gateway?.configured ? '替换账号' : '保存账号'}</button>
      </form>
      <div className="button-row"><button disabled={!!gatewayBusy || !!gateway?.installed} onClick={() => void gatewayAction('install')}><Icon name="download" />{gatewayBusy === 'install' ? '安装中…' : '安装固定版本'}</button><button disabled={!!gatewayBusy || !gateway?.installed} onClick={() => void gatewayAction('login')}><Icon name="login" />{gatewayBusy === 'login' ? '等待登录…' : '登录 Qwen 网关'}</button><button className="primary" disabled={!!gatewayBusy || !gateway?.installed || (!gateway?.configured && !gateway?.browser_login_reuse) || !!gateway?.running} onClick={() => void gatewayAction('start')}><Icon name="play" />启动</button><button disabled={!!gatewayBusy || !gateway?.running} onClick={() => void gatewayAction('stop')}><Icon name="stop" />停止</button></div>
      {gateway?.error && <p className="form-message error">{gateway.error}</p>}{!!gateway?.logs?.length && <details><summary>网关日志</summary><pre className="harness-logs">{gateway.logs.slice(-30).join('\n')}</pre></details>}
    </section>
    <section className="settings-section"><h2>OpenAI 兼容 API</h2><form className="settings-form provider-form" onSubmit={add}>
      <label>名称<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="本地 DeepSeek" /></label>
      <label>Endpoint<input value={form.endpoint} onChange={(e) => setForm({ ...form, endpoint: e.target.value })} /></label>
      <label>模型 ID<input required value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="deepseek-v4-0731" /></label>
      <label>协议<select value={form.protocol} onChange={(e) => setForm({ ...form, protocol: e.target.value })}><option value="auto">自动 / Chat Completions</option><option value="responses">Responses API</option><option value="chat_completions">Chat Completions</option></select></label>
      <label className="wide">API Key<input required type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} /></label>
      <button className="primary" type="submit"><Icon name="plus" />添加服务</button>
    </form>
    <div className="config-list">{configs.map((config) => <div key={config.id}><Icon name="server-network-outline" /><span><b>{config.name}</b><small>{config.endpoint} · {config.models?.length || 0} 个模型</small></span><button onClick={async () => { await request('/api/provider-configs/' + config.id + '/test', { method: 'POST' }); setMessage('连接验证成功'); }}>测试</button><button className="danger" onClick={async () => { await request('/api/provider-configs/' + config.id, { method: 'DELETE' }); load(); }}>删除</button></div>)}</div></section>
  </div>;
}

type HarnessStatus = {
  installed: boolean;
  running: boolean;
  starting: boolean;
  version: string;
  pid: number | null;
  url: string;
  browser_url?: string;
  workspace: string;
  default_workspace?: string;
  workspace_recovery?: { code: string; requested: string; fallback: string } | null;
  error: string;
  logs: string[];
};

type HarnessWorkspace = {
  available: boolean;
  session_id: string;
  workspace_id?: string;
  path: string;
  title: string;
  reason: string;
};

function HarnessView() {
  const state = useAppStore();
  const [status, setStatus] = React.useState<HarnessStatus | null>(null);
  const [conversationWorkspace, setConversationWorkspace] = React.useState<HarnessWorkspace | null>(null);
  const [selectedWorkspace, setSelectedWorkspace] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const load = React.useCallback(async () => {
    try { setStatus(await request<HarnessStatus>('/api/harness')); }
    catch (error: any) { setStatus({ installed: false, running: false, starting: false, version: '', pid: null, url: '', workspace: '', error: error.message, logs: [] }); }
    finally { setLoading(false); }
  }, []);
  const start = React.useCallback(async () => {
    setLoading(true);
    try {
      const workspace = selectedWorkspace || state.current?.workspace || '';
      setStatus(await request<HarnessStatus>('/api/harness/start', { method: 'POST', body: { workspace: workspace || undefined } }));
    } catch (error: any) {
      setStatus((current) => ({ ...(current || { installed: false, running: false, starting: false, version: '', pid: null, url: '', workspace: '', logs: [] }), error: error.message }));
    } finally { setLoading(false); }
  }, [selectedWorkspace, state.current?.workspace]);
  React.useEffect(() => { void load(); }, [load]);
  React.useEffect(() => {
    const timer = window.setInterval(() => { void load(); }, 1500);
    return () => window.clearInterval(timer);
  }, [load]);
  React.useEffect(() => {
    if (status && status.installed && !status.running && !status.starting && !status.error && !loading) void start();
  }, [status?.installed, status?.running, status?.starting, status?.error, loading, start]);
  const refreshConversationWorkspace = React.useCallback(async () => {
    if (!status?.running || !status.url) return;
    try {
      const next = await window.webagent.harnessCurrentWorkspace();
      setConversationWorkspace((current) => current && current.available === next.available && current.session_id === next.session_id && current.path === next.path && current.reason === next.reason ? current : next);
    } catch (error: any) {
      setConversationWorkspace({ available: false, session_id: '', path: '', title: '', reason: error.message || 'harness_workspace_unavailable' });
    }
  }, [status?.running, status?.url]);
  React.useEffect(() => {
    if (!status?.running || !status.url) { setConversationWorkspace(null); return; }
    void refreshConversationWorkspace();
    const timer = window.setInterval(() => { void refreshConversationWorkspace(); }, 1000);
    return () => window.clearInterval(timer);
  }, [status?.running, status?.url, refreshConversationWorkspace]);
  React.useEffect(() => {
    const frame = document.querySelector<HTMLIFrameElement>('.harness-frame');
    if (!frame || !status?.url) return;
    const origin = new URL(status.url).origin;
    const sendTheme = () => frame.contentWindow?.postMessage({ type: 'webagent:dsh-theme', theme: state.theme }, origin);
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.origin !== origin) return;
      if (event.data?.type === 'webagent:dsh-ready') sendTheme();
      if (event.data?.type === 'webagent:dsh-open-host') state.set({ activity: 'sessions' });
      if (event.data?.type === 'webagent:dsh-session-archived' && event.data.sessionId) {
        void request('/api/harness/sessions/' + encodeURIComponent(String(event.data.sessionId)) + '/archive', { method: 'POST' })
          .catch((error: any) => state.set({ error: 'DSH 归档后的网页会话清理失败：' + error.message }));
      }
    };
    window.addEventListener('message', onMessage);
    sendTheme();
    return () => window.removeEventListener('message', onMessage);
  }, [status?.url, state.theme]);
  if (loading && !status) return <Empty icon="loading">正在启动 DeepSeek Harness WebUI…</Empty>;
  if (!status?.running || !status.url) {
    const launchWorkspace = selectedWorkspace || state.current?.workspace || status?.default_workspace || '';
    const friendlyError = status?.error?.includes('workspace is not a directory')
      ? '上次使用的工作区已经不存在。请选择新目录，或直接使用默认工作区。'
      : status?.error;
    return <div className="feature-workbench harness-launcher">
      <div className="harness-launch-card">
        <div className="harness-launch-mark"><Icon name="horse-variant" /></div>
        <div className="harness-launch-copy"><span className="harness-kicker">WEBAGENT WORKBENCH</span><h1>DeepSeek Harness</h1><p>原版 DSH WebUI，由 WebAgent 提供本地模型网关与工作区连接。</p></div>
        <span className={status?.installed ? 'harness-ready-badge' : 'harness-missing-badge'}>{status?.installed ? `DSH ${status.version} · 就绪` : '依赖未安装'}</span>
        <div className="harness-workspace-picker"><Icon name="folder-outline" /><span><small>启动工作区</small><b title={launchWorkspace}>{launchWorkspace || '尚未选择'}</b></span><button onClick={async () => { const chosen = await window.webagent.chooseWorkspace(); if (chosen) setSelectedWorkspace(chosen); }}>选择目录</button></div>
        {status?.workspace_recovery && <div className="harness-recovery"><Icon name="information-outline" /><span>上次的临时工作区已被删除，已安全切换到 <b>{status.workspace_recovery.fallback}</b></span></div>}
        {friendlyError && <div className="harness-launch-error"><Icon name="alert-circle-outline" /><span>{friendlyError}</span></div>}
        <div className="harness-launch-actions"><button className="primary" disabled={loading || !status?.installed} onClick={() => void start()}><Icon name={loading ? 'loading' : 'play'} />{loading ? '正在连接 DSH…' : '打开 Harness'}</button><button disabled={!launchWorkspace} onClick={() => void window.webagent.revealWorkspace(launchWorkspace)}><Icon name="folder-open-outline" />打开目录</button><button disabled={!launchWorkspace} onClick={() => void window.webagent.writeClipboard(launchWorkspace)}><Icon name="content-copy" />复制路径</button></div>
        {!!status?.logs?.length && <details className="harness-diagnostics"><summary>启动诊断</summary><pre className="harness-logs">{status.logs.slice(-30).join('\n')}</pre></details>}
      </div>
    </div>;
  }
  const workspacePath = conversationWorkspace?.available ? conversationWorkspace.path : '';
  const unresolvedWorkspaceLabels: Record<string, string> = {
    harness_session_not_selected: '请先在 DSH 中选择一个对话',
    harness_workspace_not_found: '当前 DSH 对话尚未绑定工作区',
    harness_frame_loading: '正在加载 DSH 对话…',
    harness_selection_unavailable: '暂时无法读取当前 DSH 对话',
    harness_workspace_unavailable: 'DSH 工作区列表暂不可用'
  };
  const workspaceLabel = workspacePath || unresolvedWorkspaceLabels[conversationWorkspace?.reason || ''] || '正在解析当前对话工作区…';
  const workspaceTitle = workspacePath ? `当前 DSH 对话工作区：${workspacePath}` : workspaceLabel;
  const reportWorkspaceError = (error: any) => state.set({ error: '无法打开当前 DSH 对话的文件夹：' + error.message });
  const browserUrl = status.browser_url || status.url;
  const harnessGeneration = String(status.pid || 'stopped') + ':' + browserUrl;
  return <div className="harness-workbench"><div className="harness-toolbar"><span className="online-dot" /><b>DSH {status.version}</b><span title={workspaceTitle}>{workspaceLabel}</span><button title="打开当前对话的项目文件夹" disabled={!workspacePath} onClick={() => void window.webagent.revealWorkspace(workspacePath).catch(reportWorkspaceError)}><Icon name="folder-open-outline" /></button><button title="复制当前对话的项目文件夹地址" disabled={!workspacePath} onClick={() => void window.webagent.writeClipboard(workspacePath)}><Icon name="content-copy" /></button><code>{status.url}</code><button title="用默认浏览器打开 Harness" onClick={() => void window.webagent.openExternal(browserUrl)}><Icon name="open-in-new" /></button><button title="刷新 Harness" onClick={() => { const frame = document.querySelector<HTMLIFrameElement>('.harness-frame'); if (frame) frame.src = browserUrl; }}><Icon name="refresh" /></button><button title="停止 Harness" onClick={async () => { setStatus(await request<HarnessStatus>('/api/harness/stop', { method: 'POST' })); }}><Icon name="stop" /></button></div><iframe key={harnessGeneration} className="harness-frame" title="DeepSeek Harness WebUI" src={browserUrl} allow="clipboard-read; clipboard-write" onLoad={() => void refreshConversationWorkspace()} /></div>;
}

function SettingsView() {
  const state = useAppStore();
  const [scope, setScope] = React.useState<'user' | 'project'>('user');
  const [settings, setSettings] = React.useState<any>(null);
  const [raw, setRaw] = React.useState('');
  const [message, setMessage] = React.useState('');
  React.useEffect(() => { const query = scope === 'project' && state.current?.project_id ? '?project_id=' + encodeURIComponent(state.current.project_id) : ''; request('/api/settings' + query).then((value) => { setSettings(value); setRaw(JSON.stringify(value, null, 2)); }); }, [scope, state.current?.project_id]);
  const save = async (value = settings) => { try { const next = await request('/api/settings', { method: 'PATCH', body: { scope, project_id: scope === 'project' ? state.current?.project_id : null, settings: value } }); setSettings(next); setRaw(JSON.stringify(next, null, 2)); setMessage('设置已保存'); } catch (error: any) { setMessage(error.message); } };
  if (!settings) return <Empty>正在加载设置…</Empty>;
  return <div className="feature-workbench"><header><div><h1>设置</h1><p>用户设置作为默认值，项目设置只覆盖当前项目。</p></div><div className="settings-header-actions"><div className="segmented"><button className={scope === 'user' ? 'active' : ''} onClick={() => setScope('user')}>用户</button><button disabled={!state.current?.project_id} className={scope === 'project' ? 'active' : ''} onClick={() => setScope('project')}>项目</button></div><label className="workbench-search"><Icon name="magnify" /><input placeholder="搜索设置" /></label></div></header>
    <section className="settings-section"><h2>外观</h2><div className="setting-row"><span><b>颜色主题</b><small>影响整个 Workbench，而不仅是聊天区域</small></span><select aria-label="颜色主题" value={state.theme} onChange={(e) => { const theme = e.target.value as 'dark' | 'light'; state.set({ theme }); const next = { ...settings, appearance: { ...settings.appearance, theme } }; setSettings(next); setRaw(JSON.stringify(next, null, 2)); }}><option value="dark">深色</option><option value="light">浅色</option></select></div></section>
    <section className="settings-section"><h2>Runtime 与安全</h2>{[
      ['千问最大 Worker', 'qwen_max_workers', 1, 16], ['ChatGPT 最大 Worker', 'chatgpt_max_workers', 1, 4], ['最大工具轮次', 'max_tool_rounds', 1, 50]
    ].map(([label, key, min, max]) => <div className="setting-row" key={String(key)}><span><b>{label}</b></span><input type="number" min={Number(min)} max={Number(max)} value={settings.runtime[key as string]} onChange={(e) => setSettings({ ...settings, runtime: { ...settings.runtime, [key as string]: Number(e.target.value) } })} /></div>)}
      <div className="setting-row"><span><b>工具审批策略</b><small>读取自动，其余按风险请求批准</small></span><select value={settings.tools.policy}><option value="risk_based">风险分级</option></select></div><button className="primary" onClick={() => save()}>保存设置</button></section>
    <section className="settings-section"><h2>settings.json</h2><textarea className="json-editor" value={raw} onChange={(e) => setRaw(e.target.value)} spellCheck={false} /><button onClick={() => { try { void save(JSON.parse(raw)); } catch { setMessage('JSON 格式错误'); } }}>应用 JSON</button>{message && <p className="form-message">{message}</p>}</section>
  </div>;
}

function AgentView({ selected }: { selected: Capability | null }) {
  const [clusters, setClusters] = React.useState<any[]>([]); const [active, setActive] = React.useState<any>(null); const [raw, setRaw] = React.useState('');
  const load = () => request<{ data: any[] }>('/api/clusters').then((value) => { setClusters(value.data); const next = value.data.find((item) => item.id === selected?.id) || value.data[0]; setActive(next); setRaw(JSON.stringify(next || {}, null, 2)); });
  React.useEffect(() => { void load(); }, [selected?.id]);
  const save = async () => { const value = JSON.parse(raw); const next = active ? await request('/api/clusters/' + active.id, { method: 'PATCH', body: value }) : await request('/api/clusters', { method: 'POST', body: value }); setActive(next); load(); };
  return <div className="feature-workbench"><header><div><h1>Agent 配置</h1><p>配置角色、模型、工具权限、并发、深度、回退和聚合策略。</p></div><button onClick={() => { setActive(null); setRaw(JSON.stringify({ name: '自定义集群', strategy: 'parallel', max_parallel: 3, max_depth: 2, timeout_ms: 300000, roles: [] }, null, 2)); }}><Icon name="plus" />新建集群</button></header>
    <div className="cluster-layout"><nav>{clusters.map((cluster) => <button className={active?.id === cluster.id ? 'active' : ''} key={cluster.id} onClick={() => { setActive(cluster); setRaw(JSON.stringify(cluster, null, 2)); }}><b>{cluster.name}</b><small>{cluster.description}</small></button>)}</nav><section><label>集群定义<textarea className="json-editor tall" value={raw} onChange={(e) => setRaw(e.target.value)} /></label><button className="primary" onClick={() => void save()}>保存集群</button></section></div>
  </div>;
}

function ToolView({ selected }: { selected: Capability | null }) {
  const [tools, setTools] = React.useState<any[]>([]); React.useEffect(() => { request<{ data: any[] }>('/api/tools').then((value) => setTools(value.data)); }, []);
  const tool = tools.find((item) => item.id === selected?.id.replace(/^local\//, '')) || tools[0];
  return <div className="feature-workbench"><header><div><h1>工具与 MCP</h1><p>所有调用都通过统一 Manifest、JSON Schema 和风险策略。</p></div></header>{tool ? <section className="tool-detail"><div className={'risk-badge ' + tool.risk}>{tool.risk}</div><h2>{tool.label}</h2><dl><dt>ID</dt><dd>{tool.id}</dd><dt>类别</dt><dd>{tool.category}</dd><dt>当前策略</dt><dd>{tool.policy}</dd><dt>来源</dt><dd>{tool.source}</dd></dl><h3>输入 Schema</h3><pre>{JSON.stringify(tool.input_schema, null, 2)}</pre></section> : <Empty>没有可用工具</Empty>}</div>;
}

function ExtensionsView() {
  const state = useAppStore(); const workspace = state.current?.workspace || '';
  const [skills, setSkills] = React.useState<any[]>([]); const [plugins, setPlugins] = React.useState<any[]>([]); const [tab, setTab] = React.useState<'skills' | 'plugins'>('skills');
  const [skill, setSkill] = React.useState({ name: '', description: '', content: '' }); const [pluginUrl, setPluginUrl] = React.useState('');
  const load = () => Promise.all([request<{ data: any[] }>('/api/skills?workspace=' + encodeURIComponent(workspace)), request<{ data: any[] }>('/api/plugins')]).then(([a, b]) => { setSkills(a.data); setPlugins(b.data); });
  React.useEffect(() => { void load(); }, [workspace]);
  return <div className="feature-workbench"><header><div><h1>Skills 与 Plugins</h1><p>支持用户级或项目级能力、本地目录、Git URL 和 Marketplace。</p></div><div className="segmented"><button className={tab === 'skills' ? 'active' : ''} onClick={() => setTab('skills')}>Skills</button><button className={tab === 'plugins' ? 'active' : ''} onClick={() => setTab('plugins')}>Plugins</button></div></header>
    {tab === 'skills' ? <section className="settings-section"><h2>添加 Skill</h2><form className="settings-form" onSubmit={async (e) => { e.preventDefault(); await request('/api/skills', { method: 'POST', body: { ...skill, scope: workspace ? 'project' : 'user', workspace } }); setSkill({ name: '', description: '', content: '' }); load(); }}><label>名称<input required value={skill.name} onChange={(e) => setSkill({ ...skill, name: e.target.value })} /></label><label>说明<input value={skill.description} onChange={(e) => setSkill({ ...skill, description: e.target.value })} /></label><label className="wide">SKILL.md 内容<textarea value={skill.content} onChange={(e) => setSkill({ ...skill, content: e.target.value })} /></label><button className="primary">添加</button></form><div className="config-list">{skills.map((item) => <div key={item.name}><Icon name="lightning-bolt-outline" /><span><b>{item.name}</b><small>{item.description || item.source_path}</small></span></div>)}</div></section> : <section className="settings-section"><h2>从 Git 安装</h2><form className="inline-form" onSubmit={async (e) => { e.preventDefault(); const name = pluginUrl.split('/').pop()?.replace(/\.git$/, '') || 'plugin'; await request('/api/plugins', { method: 'POST', body: { name, source: { type: 'git', url: pluginUrl } } }); setPluginUrl(''); load(); }}><input required value={pluginUrl} onChange={(e) => setPluginUrl(e.target.value)} placeholder="https://github.com/org/plugin.git" /><button className="primary">安装</button></form><div className="config-list">{plugins.map((item) => <div key={item.name}><Icon name="puzzle-outline" /><span><b>{item.name}</b><small>{item.installed ? '已安装' : item.description}</small></span>{item.installed && <button className="danger" onClick={async () => { await request('/api/plugins/' + item.name, { method: 'DELETE' }); load(); }}>卸载</button>}</div>)}</div></section>}
  </div>;
}

function BotsView() {
  const [platforms, setPlatforms] = React.useState<any[]>([]); const [mobile, setMobile] = React.useState<any>(null); const [pair, setPair] = React.useState<any>(null);
  const [selectedPlatform, setSelectedPlatform] = React.useState<any>(null); const [credentials, setCredentials] = React.useState('{}'); const [botMessage, setBotMessage] = React.useState('');
  const load = () => Promise.all([request<{ data: any[] }>('/api/bots/platforms'), request('/api/mobile')]).then(([a, b]) => { setPlatforms(a.data); setMobile(b); }); React.useEffect(() => { void load(); }, []);
  const start = async (tunnel = false) => { await request('/api/mobile', { method: 'POST', body: { enabled: true, port: 5860, tunnel } }); load(); };
  return <div className="feature-workbench"><header><div><h1>Bots 与移动端</h1><p>聊天平台采用任务委派模式；移动端提供完整多会话管理。</p></div></header><section className="settings-section"><h2>Bot 平台</h2><div className="platform-grid">{platforms.map((item) => <button key={item.id} onClick={() => { setSelectedPlatform(item); setCredentials('{}'); }}><Icon name="robot-outline" /><span><b>{item.name}</b><small>{item.auth === 'qrcode' ? '扫码登录' : '凭据配置'} · {item.configured ? '已配置' : '未配置'}</small></span></button>)}</div>{selectedPlatform && <form className="settings-form bot-form" onSubmit={async (e) => { e.preventDefault(); try { await request('/api/bots', { method: 'POST', body: { platform: selectedPlatform.id, name: selectedPlatform.name, enabled: true, credentials: JSON.parse(credentials), mode: 'task_delegate' } }); setBotMessage(selectedPlatform.name + ' 已保存'); setSelectedPlatform(null); load(); } catch (error: any) { setBotMessage(error.message); } }}><label className="wide">{selectedPlatform.name} 配置 JSON<textarea value={credentials} onChange={(e) => setCredentials(e.target.value)} placeholder="按平台填写 App ID、Secret 或 Token" /></label><button className="primary">保存并启用任务模式</button></form>}{botMessage && <p className="form-message">{botMessage}</p>}</section>
    <section className="settings-section"><h2>移动 Gateway</h2>{mobile?.running ? <div className="mobile-status"><span className="online-dot" />运行于 <code>{mobile.lan_url}</code>{mobile.tunnel_url && <> · <code>{mobile.tunnel_url}</code></>}</div> : <Empty icon="cellphone-link">尚未启动移动 Gateway</Empty>}<div className="button-row"><button className="primary" onClick={() => start(false)}>启动局域网</button><button onClick={() => start(true)}>启动并创建隧道</button>{mobile?.running && <button onClick={async () => setPair(await request('/api/mobile/pair', { method: 'POST', body: { tunnel: !!mobile.tunnel_url } }))}>生成配对二维码</button>}</div>{pair && <div className="pair-card"><img src={pair.qr} alt="移动端配对二维码" /><div><b>管理员设备配对</b><code>{pair.url}</code><small>二维码五分钟内、仅可使用一次</small></div></div>}</section>
  </div>;
}

type ModelApiStatus = {
  enabled: boolean; running: boolean; host: string; port: number; base_url: string;
  model: string; exposed_model: string; display_name: string; api_key: string;
};

function modelProvider(model: any) {
  const id = model.owned_by || model.provider || 'other';
  const labels: Record<string, string> = { deepseek: 'DeepSeek 网页', qwen: '千问网页版', rogator: 'Qianwen 网关', chatgpt: 'ChatGPT 网页', openai: 'OpenAI 兼容 API', anthropic: 'Anthropic API' };
  return { id, label: model.providerDisplayName || labels[id] || id };
}

function ApiView() {
  const state = useAppStore();
  const [status, setStatus] = React.useState<ModelApiStatus | null>(null);
  const [provider, setProvider] = React.useState('');
  const [form, setForm] = React.useState({ model: '', alias: 'webagent-model', port: 5861 });
  const [message, setMessage] = React.useState('');
  const providers = React.useMemo(() => {
    const groups: Array<{ id: string; label: string; models: any[] }> = [];
    for (const model of state.models) {
      const item = modelProvider(model);
      let group = groups.find((entry) => entry.id === item.id);
      if (!group) { group = { ...item, models: [] }; groups.push(group); }
      group.models.push(model);
    }
    return groups;
  }, [state.models]);
  const load = React.useCallback(async () => {
    try {
      const value = await request<ModelApiStatus>('/api/model-api');
      setStatus(value);
      const selected = state.models.find((model) => model.id === value.model) || state.models[0];
      const selectedProvider = selected ? modelProvider(selected).id : providers[0]?.id || '';
      setProvider(selectedProvider);
      setForm({ model: selected?.id || '', alias: value.exposed_model && value.exposed_model !== value.model ? value.exposed_model : 'webagent-model', port: value.port || 5861 });
    } catch (error: any) { setMessage(error.message); }
  }, [state.models]);
  React.useEffect(() => { void load(); }, [load]);
  const active = providers.find((item) => item.id === provider) || providers[0];
  const start = async () => {
    try { setMessage('正在启动本地 API…'); setStatus(await request<ModelApiStatus>('/api/model-api/start', { method: 'POST', body: form })); setMessage('本地 OpenAI 兼容 API 已启动'); }
    catch (error: any) { setMessage(error.message); }
  };
  const stop = async () => { try { setStatus(await request<ModelApiStatus>('/api/model-api/stop', { method: 'POST' })); setMessage('本地 API 已停止'); } catch (error: any) { setMessage(error.message); } };
  const endpoint = status?.base_url || `http://127.0.0.1:${form.port}/v1`;
  const curl = `curl ${endpoint}/chat/completions -H "Authorization: Bearer ${status?.api_key || '<API_KEY>'}" -H "Content-Type: application/json" -d '{"model":"${form.alias || form.model}","messages":[{"role":"user","content":"你好"}]}'`;
  return <div className="feature-workbench"><header><div><h1>本地模型 API</h1><p>把一个 WebAgent 模型发布为独立、仅限本机访问的 OpenAI 兼容服务。</p></div><div className="api-state"><span className={status?.running ? 'online-dot' : ''} />{status?.running ? '运行中' : '已停止'}</div></header>
    <section className="settings-section"><h2>发布模型</h2><div className="settings-form provider-form">
      <label>提供商<select value={provider} onChange={(event) => { const id = event.target.value; const group = providers.find((item) => item.id === id); setProvider(id); setForm((value) => ({ ...value, model: group?.models[0]?.id || '' })); }}>{providers.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <label>模型<select value={form.model} onChange={(event) => setForm({ ...form, model: event.target.value })}>{active?.models.map((model) => <option key={model.id} value={model.id}>{model.displayName || model.id}</option>)}</select></label>
      <label>对外模型 ID<input value={form.alias} onChange={(event) => setForm({ ...form, alias: event.target.value })} placeholder={form.model} /></label>
      <label>本地端口<input type="number" min={1024} max={65535} value={form.port} disabled={!!status?.running} onChange={(event) => setForm({ ...form, port: Number(event.target.value) })} /></label>
      <div className="wide button-row"><button className="primary" disabled={!form.model || !!status?.running} onClick={() => void start()}><Icon name="play" />启动 API</button><button disabled={!status?.running} onClick={() => void stop()}><Icon name="stop" />停止</button></div>
    </div>{message && <p className="form-message">{message}</p>}</section>
    <section className="settings-section"><h2>连接信息</h2><div className="api-connection"><label>Base URL<code>{endpoint}</code><button onClick={() => void window.webagent.writeClipboard(endpoint)}><Icon name="content-copy" />复制</button></label><label>API Key<code>{status?.api_key || '启动后生成'}</code><button disabled={!status?.api_key} onClick={() => void window.webagent.writeClipboard(status?.api_key || '')}><Icon name="content-copy" />复制</button><button disabled={!status?.api_key} onClick={async () => { if (!window.confirm('重置后，正在使用旧 Token 的客户端将立即失效。继续吗？')) return; setStatus(await request<ModelApiStatus>('/api/model-api/token', { method: 'POST' })); }}><Icon name="refresh" />重置</button></label><label>公开模型<code>{status?.exposed_model || form.alias || form.model}</code></label></div>
      <h3>Chat Completions 示例</h3><pre className="api-example">{curl}</pre><div className="button-row"><button onClick={() => void window.webagent.writeClipboard(curl)}><Icon name="content-copy" />复制命令</button></div>
      <p className="api-security"><Icon name="shield-lock-outline" />服务只绑定 127.0.0.1；这里的 Token 与 Runtime 内部 Token 相互独立。</p>
    </section>
  </div>;
}

export function FeatureWorkbench({ activity, selected }: { activity: string; selected: Capability | null }) {
  if (activity === 'api') return <ApiView />;
  if (activity === 'harness') return <HarnessView />;
  if (activity === 'accounts') return <AccountsView />;
  if (activity === 'settings') return <SettingsView />;
  if (activity === 'agents') return <AgentView selected={selected} />;
  if (activity === 'tools') return <ToolView selected={selected} />;
  if (activity === 'plugins') return <ExtensionsView />;
  if (activity === 'bots') return <BotsView />;
  return <Empty>选择一项以查看配置</Empty>;
}
