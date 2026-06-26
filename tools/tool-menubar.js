// menubar - 菜单栏配置管理工具
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._menubar_registered) return;

    var CONFIG_FILE = 'menubar-config.json';

    window.__dsagent_tools.register({
        name: 'menubar',
        scope: '查看和操作自定义标题栏菜单配置',
        description: '管理 menubar-config.json 配置文件，支持查看菜单树、添加菜单项、删除菜单项、修改标签。\n所有更改即时生效，标题栏会自动重新加载配置。',
        params: [
            { name: 'action', type: '字符串', default: 'list', required: false, description: '操作类型：list（列出现有菜单）/ add-menu（添加顶级菜单）/ add-item（添加子项）/ remove（删除）/ modify（修改）' },
            { name: 'menuId', type: '字符串', default: '—', required: false, description: '菜单 ID，如 file、edit 等' },
            { name: 'id', type: '字符串', default: '—', required: false, description: '菜单项 ID，用于 remove/modify' },
            { name: 'label', type: '字符串', default: '—', required: false, description: '显示标签（添加/修改时使用）' },
            { name: 'actionType', type: '字符串', default: '—', required: false, description: '动作类型：open-folder / close-folder / quit / role / reload-deepseek / theme / devtools / about 等' },
            { name: 'role', type: '字符串', default: '—', required: false, description: '角色操作类型（action=role 时使用）：undo / redo / cut / copy / paste / selectAll' },
            { name: 'accelerator', type: '字符串', default: '—', required: false, description: '快捷键显示文本，如 Ctrl+O、Ctrl+Z' }
        ],
        usage: '# 列出现有菜单\n<tool:menubar>{"action": "list"}</tool:menubar>\n\n# 添加顶级菜单\n<tool:menubar>{"action": "add-menu", "menuId": "format", "label": "格式"}</tool:menubar>\n\n# 添加子项\n<tool:menubar>{"action": "add-item", "menuId": "file", "id": "save", "label": "保存", "actionType": "role", "role": "save", "accelerator": "Ctrl+S"}</tool:menubar>\n\n# 删除菜单项\n<tool:menubar>{"action": "remove", "id": "devtools"}</tool:menubar>\n\n# 修改菜单项\n<tool:menubar>{"action": "modify", "id": "about", "label": "关于 DS Agent Desktop"}</tool:menubar>',
        notes: '删除操作会从所有菜单中查找并删除匹配 id 的项。添加顶级菜单时只需 menuId 和 label。修改操作支持修改 label、accelerator、actionType、role。',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;
            var kv;

            // Check if new params format is being used
            var hasNewParams = params.action || params.menuId || params.id || params.label || params.actionType || params.role || params.accelerator;
            if (hasNewParams) {
                kv = params;
            } else {
                // Old format: parse body content as key=value pairs
                var content = body || '';
                kv = (typeof window.__dsagent_parseKeyValuePairs === 'function')
                    ? window.__dsagent_parseKeyValuePairs(content)
                    : {};
            }

            var action = (kv.action || 'list').trim();

            // 读取配置文件
            try {
                var readRes = await window.electronAPI.agentRead(CONFIG_FILE);
                if (!readRes || !readRes.success) {
                    return makeResult(false, null, '无法读取菜单配置文件 "' + CONFIG_FILE + '": ' + (readRes ? readRes.error : '文件不存在'));
                }
                var config;
                try {
                    config = JSON.parse(readRes.content);
                } catch (e) {
                    return makeResult(false, null, '配置文件格式错误: ' + e.message);
                }

                switch (action) {
                    case 'list': {
                        var output = '# 当前菜单栏配置\n\n';
                        output += '标题: ' + config.title + '\n';
                        output += '高度: ' + config.height + 'px\n\n';
                        (config.menu || []).forEach(function(m) {
                            output += '## ' + m.label + ' (' + m.id + ')\n';
                            (m.items || []).forEach(function(item) {
                                if (item.type === 'separator') {
                                    output += '  ---\n';
                                } else {
                                    var accel = item.accelerator ? ' [' + item.accelerator + ']' : '';
                                    var typeTag = item.type === 'radio' ? ' (radio)' : '';
                                    output += '  - ' + item.label + typeTag + accel + ' → ' + item.action + (item.role ? '(' + item.role + ')' : '') + (item.theme ? '=' + item.theme : '') + '\n';
                                }
                            });
                            output += '\n';
                        });
                        return makeResult(true, output);
                    }

                    case 'add-menu': {
                        var newMenuId = (kv.menuId || '').trim();
                        var newLabel = (kv.label || '').trim();
                        if (!newMenuId || !newLabel) return makeResult(false, null, '添加菜单需要 menuId 和 label 参数');
                        if (config.menu.some(function(m) { return m.id === newMenuId; })) {
                            return makeResult(false, null, '菜单 ID "' + newMenuId + '" 已存在');
                        }
                        config.menu.push({ id: newMenuId, label: newLabel, items: [] });
                        return makeResult(true, await saveConfig(config, '已添加菜单: ' + newLabel + ' (' + newMenuId + ')'));
                    }

                    case 'add-item': {
                        var parentMenuId = (kv.menuId || '').trim();
                        var newId = (kv.id || '').trim();
                        var itemLabel = (kv.label || '').trim();
                        if (!parentMenuId || !newId || !itemLabel) return makeResult(false, null, '添加菜单项需要 menuId、id 和 label 参数');
                        var parent = config.menu.find(function(m) { return m.id === parentMenuId; });
                        if (!parent) return makeResult(false, null, '未找到菜单 "' + parentMenuId + '"');
                        var allItems = [];
                        config.menu.forEach(function(m) { m.items.forEach(function(i) { allItems.push(i); }); });
                        if (allItems.some(function(i) { return i.id === newId; })) {
                            return makeResult(false, null, '菜单项 ID "' + newId + '" 已存在');
                        }
                        var newItem = {
                            id: newId,
                            label: itemLabel,
                            action: kv.actionType || 'role',
                        };
                        if (kv.role) newItem.role = kv.role;
                        if (kv.accelerator) newItem.accelerator = kv.accelerator;
                        if (kv.actionType === 'theme') newItem.theme = kv.theme || 'dark';
                        parent.items.push(newItem);
                        return makeResult(true, await saveConfig(config, '已添加菜单项: ' + itemLabel + ' → ' + parent.label));
                    }

                    case 'remove': {
                        var removeId = (kv.id || '').trim();
                        if (!removeId) return makeResult(false, null, '删除需要 id 参数');
                        var removed = null;
                        config.menu.forEach(function(m) {
                            var idx = m.items.findIndex(function(i) { return i.id === removeId; });
                            if (idx !== -1) {
                                removed = m.items[idx].label;
                                m.items.splice(idx, 1);
                            }
                        });
                        if (!removed) return makeResult(false, null, '未找到 ID 为 "' + removeId + '" 的菜单项');
                        return makeResult(true, await saveConfig(config, '已删除菜单项: ' + removed));
                    }

                    case 'modify': {
                        var modId = (kv.id || '').trim();
                        if (!modId) return makeResult(false, null, '修改需要 id 参数');
                        var found = null;
                        config.menu.forEach(function(m) {
                            m.items.forEach(function(i) {
                                if (i.id === modId) found = i;
                            });
                        });
                        if (!found) return makeResult(false, null, '未找到 ID 为 "' + modId + '" 的菜单项');
                        if (kv.label) found.label = kv.label;
                        if (kv.accelerator !== undefined) found.accelerator = kv.accelerator || '';
                        if (kv.actionType) found.action = kv.actionType;
                        if (kv.role) found.role = kv.role;
                        if (kv.theme) found.theme = kv.theme;
                        return makeResult(true, await saveConfig(config, '已修改菜单项: ' + modId));
                    }

                    default:
                        return makeResult(false, null, '未知操作 "' + action + '"，支持: list / add-menu / add-item / remove / modify');
                }
            } catch(e) {
                return makeResult(false, null, e.message || 'menubar 操作异常');
            }
        }
    });

    async function saveConfig(config, successMsg) {
        try {
            var saveContent = JSON.stringify(config, null, 2);
            var saveRes = await window.electronAPI.agentSave(CONFIG_FILE, saveContent);
            if (!saveRes || !saveRes.success) {
                return '保存配置文件失败: ' + (saveRes ? saveRes.error : '未知错误');
            }
            return '✓ ' + successMsg + '\n\n提示: 标题栏会在下次点击菜单时自动加载更新后的配置。';
        } catch (e) {
            return '错误: ' + e.message;
        }
    }

    window.__dsagent_tools._menubar_registered = true;
})();