window.__ModuleLoader__.load({
  id: '@webagent/dsh-integration',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const jsx = require('react/jsx-runtime');

    const namespace = 'webagent-search';
    const css = `
      .webagent-search-card{border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);border-radius:12px;padding:18px;display:grid;gap:14px}
      .webagent-search-card h3{color:var(--dsw-alias-label-primary);font-size:16px;margin:0}
      .webagent-search-card p{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.6;margin:0}
      .webagent-search-field{display:grid;gap:7px}
      .webagent-search-field label{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500}
      .webagent-search-field select{border:1px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;height:36px;padding:0 10px;font:inherit}
      .webagent-search-actions{display:flex;justify-content:flex-end;gap:8px}
      .webagent-search-actions button{border:1px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:7px 14px;cursor:pointer}
      .webagent-search-actions button[data-primary=true]{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:white}
      .webagent-search-actions button:disabled{cursor:default;opacity:.5}
      .webagent-search-error{color:var(--dsw-alias-label-error)!important}
    `;
    if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css="webagent-search"]')) {
      const style = document.createElement('style');
      style.dataset.plugin = '@webagent/dsh-integration';
      style.dataset.pluginCss = 'webagent-search';
      style.textContent = css;
      document.head.appendChild(style);
    }

    function SearchSettingsCard(props) {
      const snapshot = React.useSyncExternalStore(props.subscribe, props.getSnapshot, props.getSnapshot);
      const current = snapshot && snapshot.value && snapshot.value.provider === 'qianwen' ? 'qianwen' : 'deepseek';
      const [draft, setDraft] = React.useState(null);
      const [saving, setSaving] = React.useState(false);
      const [failed, setFailed] = React.useState(false);
      const selected = draft || current;
      const writable = snapshot && snapshot.status === 'ready' && snapshot.writable;
      const dirty = selected !== current;
      const save = async () => {
        setSaving(true);
        setFailed(false);
        try {
          await props.setProvider(selected);
          setDraft(null);
        } catch (_) {
          setFailed(true);
        } finally {
          setSaving(false);
        }
      };
      return jsx.jsxs('section', {
        className: 'webagent-search-card',
        children: [
          jsx.jsx('h3', { children: '网页搜索' }),
          jsx.jsx('p', { children: '选择 DSH 原生 web_search 工具使用的网页账号。不会调用付费搜索 API；修改后立即作用于后续搜索。' }),
          jsx.jsxs('div', {
            className: 'webagent-search-field',
            children: [
              jsx.jsx('label', { htmlFor: 'webagent-search-provider', children: '搜索提供方' }),
              jsx.jsxs('select', {
                id: 'webagent-search-provider',
                value: selected,
                disabled: !writable || saving,
                onChange: (event) => setDraft(event.target.value),
                children: [
                  jsx.jsx('option', { value: 'deepseek', children: 'DeepSeek 网页搜索（默认）' }),
                  jsx.jsx('option', { value: 'qianwen', children: 'Qwen 网页搜索' })
                ]
              })
            ]
          }),
          jsx.jsx('p', { children: selected === 'qianwen' ? '需要当前 Qwen 浏览器 Profile 已登录。' : '使用当前 DeepSeek 浏览器 Profile，并按需开启原生联网搜索。' }),
          failed ? jsx.jsx('p', { className: 'webagent-search-error', role: 'alert', children: '保存失败，请刷新后重试。' }) : null,
          jsx.jsxs('div', {
            className: 'webagent-search-actions',
            children: [
              jsx.jsx('button', { type: 'button', disabled: !dirty || saving, onClick: () => { setDraft(null); setFailed(false); }, children: '放弃修改' }),
              jsx.jsx('button', { type: 'button', 'data-primary': true, disabled: !writable || !dirty || saving, onClick: save, children: saving ? '保存中…' : '保存' })
            ]
          })
        ]
      });
    }

    const inject = ['slots', 'settingsScope'];
    function apply(ctx) {
      const scope = ctx.settingsScope.bind({ namespace });
      const face = {
        getSnapshot: () => scope.getSnapshot(),
        subscribe: (listener) => scope.subscribe(listener),
        setProvider: (provider) => scope.set('provider', provider)
      };
      ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
        name: 'settings.plugin.item',
        key: namespace,
        inject: () => face
      }, SearchSettingsCard));
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
