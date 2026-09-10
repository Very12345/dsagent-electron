import type { PendingImage, RuntimeEvent, RuntimeSdk } from './types';

type BootstrapPayload = {
  csrf_token: string;
  native_capabilities?: Record<string, boolean>;
};

type RequestOptions = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
};

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
let bootstrapPromise: Promise<BootstrapPayload> | null = null;

function localPath(value: string) {
  const path = String(value || '');
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Browser Runtime SDK only accepts same-origin paths');
  return path;
}

async function responsePayload(response: Response) {
  const contentType = response.headers.get('content-type') || '';
  if (response.status === 204) return null;
  if (contentType.includes('application/json')) return response.json();
  return response.text();
}

function requestError(response: Response, payload: any) {
  const detail = payload?.error;
  const error = new Error(
    (typeof detail === 'object' && detail?.message)
    || (typeof detail === 'string' && detail)
    || payload?.message
    || `Runtime request failed: ${response.status}`
  ) as Error & { status?: number; code?: string };
  error.status = response.status;
  error.code = (typeof detail === 'object' && detail?.code) || payload?.code;
  return error;
}

async function bootstrap(force = false) {
  if (force) bootstrapPromise = null;
  if (!bootstrapPromise) {
    bootstrapPromise = fetch('/webapp/api/bootstrap', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      cache: 'no-store'
    }).then(async (response) => {
      const payload = await responsePayload(response);
      if (!response.ok) throw requestError(response, payload);
      return payload as BootstrapPayload;
    }).catch((error) => {
      bootstrapPromise = null;
      throw error;
    });
  }
  return bootstrapPromise;
}

async function request<T = any>(path: string, options: RequestOptions = {}) {
  const method = String(options.method || (options.body == null ? 'GET' : 'POST')).toUpperCase();
  const headers: Record<string, string> = { Accept: 'application/json', ...(options.headers || {}) };
  let body: BodyInit | undefined;
  if (options.body != null) {
    body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    if (!Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
  }
  if (UNSAFE_METHODS.has(method)) headers['X-WebAgent-CSRF'] = (await bootstrap()).csrf_token;
  const response = await fetch(localPath(path), { method, headers, body, credentials: 'same-origin', cache: 'no-store' });
  const payload = await responsePayload(response);
  if (!response.ok) {
    if (response.status === 401) bootstrapPromise = null;
    throw requestError(response, payload);
  }
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, name) => { responseHeaders[name] = value; });
  return { status: response.status, headers: responseHeaders, data: payload as T };
}

function wait(delay: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = window.setTimeout(done, delay);
    function done() { signal.removeEventListener('abort', done); window.clearTimeout(timer); resolve(); }
    signal.addEventListener('abort', done, { once: true });
  });
}

async function subscribe(sessionId: string, after: number, callback: (event: RuntimeEvent) => void) {
  const controller = new AbortController();
  let cursor = Math.max(0, Number(after) || 0);
  void (async () => {
    let failures = 0;
    while (!controller.signal.aborted) {
      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/events?after=${cursor}`, {
          credentials: 'same-origin',
          headers: { Accept: 'text/event-stream' },
          cache: 'no-store',
          signal: controller.signal
        });
        if (!response.ok || !response.body) {
          const payload = await responsePayload(response);
          throw requestError(response, payload);
        }
        failures = 0;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!controller.signal.aborted) {
          const chunk = await reader.read();
          buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
          let match: RegExpExecArray | null;
          while ((match = /\r?\n\r?\n/.exec(buffer))) {
            const block = buffer.slice(0, match.index);
            buffer = buffer.slice(match.index + match[0].length);
            const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
            if (!data || data === '[DONE]') continue;
            try {
              const event = JSON.parse(data) as RuntimeEvent;
              if (Number(event.seq) > cursor) cursor = Number(event.seq);
              callback(event);
            } catch (_) {}
          }
          if (chunk.done) break;
        }
      } catch (error) {
        if (controller.signal.aborted) break;
        failures += 1;
        if (failures === 1 || failures % 5 === 0) {
          callback({
            id: `browser_connection_${Date.now()}`,
            seq: cursor,
            created_at: new Date().toISOString(),
            type: 'runtime.connection_error',
            session_id: sessionId,
            run_id: '',
            parent_run_id: null,
            call_id: null,
            data: { error: error instanceof Error ? error.message : String(error) }
          });
        }
      }
      await wait(Math.min(5000, 250 * 2 ** Math.min(failures, 4)), controller.signal);
    }
  })();
  return () => controller.abort();
}

function browserPlatform() {
  const value = String(navigator.platform || navigator.userAgent || '').toLowerCase();
  if (value.includes('win')) return 'win32';
  if (value.includes('mac')) return 'darwin';
  if (value.includes('linux')) return 'linux';
  return 'browser';
}

function selectFiles(accept = '', multiple = true) {
  return new Promise<File[]>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    input.accept = accept;
    input.hidden = true;
    document.body.appendChild(input);
    let settled = false;
    const finish = (files: File[]) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('focus', onFocus);
      input.remove();
      resolve(files);
    };
    const onFocus = () => window.setTimeout(() => finish(Array.from(input.files || [])), 250);
    input.addEventListener('change', () => finish(Array.from(input.files || [])), { once: true });
    window.addEventListener('focus', onFocus, { once: true });
    input.click();
  });
}

function fileData(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error(`Unable to read ${file.name}`));
    reader.onload = () => resolve(String(reader.result || '').replace(/^data:[^,]*,/, ''));
    reader.readAsDataURL(file);
  });
}

async function chooseImages(): Promise<PendingImage[]> {
  const files = await selectFiles('image/png,image/jpeg,image/gif,image/bmp,image/webp', true);
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > 20 * 1024 * 1024) throw new Error('Selected images exceed the 20 MB total limit');
  return Promise.all(files.map(async (file) => ({ name: file.name, mimeType: file.type || 'image/png', data: await fileData(file) })));
}

async function chooseFiles() {
  const files = await selectFiles('', true);
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > 20 * 1024 * 1024) throw new Error('Selected files exceed the 20 MB total limit');
  if (!files.length) return [];
  const uploads = await Promise.all(files.map(async (file) => ({ name: file.name, mimeType: file.type || 'application/octet-stream', data: await fileData(file) })));
  const response = await request<{ paths: string[] }>('/system/upload', { method: 'POST', body: { files: uploads } });
  return response.data.paths || [];
}

async function chooseWorkspace() {
  const capabilities = await bootstrap().catch(() => null);
  if (capabilities?.native_capabilities?.select_directory) {
    const response = await request<{ path: string | null; cancelled?: boolean }>('/system/select-directory', { method: 'POST', body: {} });
    return response.data.path || null;
  }
  const requested = window.prompt('输入已在 WebAgent 中注册的工作区绝对路径。路径会由本地 Runtime 验证：', '');
  if (!requested?.trim()) return null;
  const response = await request<{ path: string }>('/system/select-directory', { method: 'POST', body: { path: requested.trim() } });
  return response.data.path || null;
}

function validExternalUrl(value: string) {
  const target = new URL(String(value || ''));
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('Only HTTP(S) URLs can be opened externally');
  return target.toString();
}

const browserSdk: RuntimeSdk = {
  request,
  subscribe,
  runtimeInfo: async () => (await request<any>('/runtime-info')).data,
  chooseWorkspace,
  chooseFiles,
  chooseImages,
  readClipboard: async () => navigator.clipboard.readText(),
  writeClipboard: async (text) => { await navigator.clipboard.writeText(String(text || '')); return true; },
  revealWorkspace: async (workspace) => {
    try { return !!(await request<{ opened: boolean }>('/system/reveal', { method: 'POST', body: { workspace } })).data.opened; }
    catch (_) { return false; }
  },
  harnessCurrentWorkspace: async () => {
    try { return (await request<any>('/system/harness-current-workspace')).data; }
    catch (_) { return { available: false, session_id: '', path: '', title: '', reason: 'native_bridge_unavailable' }; }
  },
  openExternal: async (value) => {
    const url = validExternalUrl(value);
    const cached = await bootstrap().catch(() => null);
    if (cached?.native_capabilities?.open_external) {
      return !!(await request<{ opened: boolean }>('/system/open-external', { method: 'POST', body: { url } })).data.opened;
    }
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.click();
    return true;
  },
  platform: browserPlatform()
};

export function installBrowserSdk() {
  if (window.webagent) return window.webagent;
  if (window.dsagent) {
    window.webagent = window.dsagent;
    return window.webagent;
  }
  window.webagent = browserSdk;
  if (!window.dsagent) window.dsagent = browserSdk;
  void bootstrap().catch(() => {});
  return browserSdk;
}

export { browserSdk };
