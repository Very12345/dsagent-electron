// plugin-installer.js — CC 插件安装器
// 兼容 Claude Code 插件格式：git clone / npm install / 本地路径
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const { brandHome } = require('./lib/paths.js');

// 检查 git 是否可用
function isGitAvailable() {
    try {
        execSync('git --version', { timeout: 3000, windowsHide: true, stdio: 'pipe' });
        return true;
    } catch(e) { return false; }
}

const PLUGINS_ROOT = 'plugins';
const INSTALLED_DIR = 'installed';

function getInstalledDir(rootDir) {
    var base = rootDir ? path.join(rootDir, PLUGINS_ROOT) : path.join(brandHome(), PLUGINS_ROOT);
    return path.join(base, INSTALLED_DIR);
}

function ensureDir(dir) {
    try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); return true; } catch(e) { return false; }
}

// 安装插件
async function install(params) {
    // params: { source: {type, url, path, repo, ref, pkg}, name?, marketplace? }
    var source = params.source;
    if (!source || !source.type) return { success: false, error: '缺少插件来源' };

    var name = params.name || 'plugin-' + Date.now();
    var installedDir = getInstalledDir();
    var targetDir = path.join(installedDir, name);

    // 如果已安装，先卸载
    if (fs.existsSync(targetDir)) {
        try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch(e) {}
    }
    ensureDir(targetDir);

    try {
        switch (source.type) {
            case 'git': {
                // git clone
                var url = source.url;
                var ref = source.ref || 'main';
                console.log('[PluginInstall] Cloning', url, 'to', targetDir);
                execSync('git clone ' + JSON.stringify(url) + ' ' + JSON.stringify(targetDir), {
                    timeout: 120000, windowsHide: true, stdio: 'pipe'
                });
                if (ref && ref !== 'main') {
                    execSync('git checkout ' + JSON.stringify(ref), {
                        cwd: targetDir, timeout: 30000, windowsHide: true, stdio: 'pipe'
                    });
                }
                break;
            }
            case 'github': {
                // GitHub shorthand: owner/repo
                var repo = source.repo;
                var gitUrl = 'https://github.com/' + repo + '.git';
                var ref2 = source.ref || 'main';
                console.log('[PluginInstall] Cloning github', gitUrl, 'to', targetDir);
                execSync('git clone ' + JSON.stringify(gitUrl) + ' ' + JSON.stringify(targetDir), {
                    timeout: 120000, windowsHide: true, stdio: 'pipe'
                });
                if (ref2 && ref2 !== 'main') {
                    execSync('git checkout ' + JSON.stringify(ref2), {
                        cwd: targetDir, timeout: 30000, windowsHide: true, stdio: 'pipe'
                    });
                }
                // 如果是 git-subdir，只保留子目录
                if (source.subdir) {
                    var subPath = path.join(targetDir, source.subdir);
                    if (fs.existsSync(subPath)) {
                        // 先复制子目录到临时位置
                        var tmpDir = targetDir + '_tmp';
                        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
                        fs.renameSync(subPath, tmpDir);
                        // 删除其他文件
                        var items = fs.readdirSync(targetDir);
                        items.forEach(function(item) {
                            var itemPath = path.join(targetDir, item);
                            if (itemPath !== tmpDir) {
                                try { fs.rmSync(itemPath, { recursive: true, force: true }); } catch(e) {}
                            }
                        });
                        // 移回
                        var items2 = fs.readdirSync(tmpDir);
                        items2.forEach(function(item) {
                            fs.renameSync(path.join(tmpDir, item), path.join(targetDir, item));
                        });
                        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {}
                    }
                }
                break;
            }
            case 'git-subdir': {
                // git-subdir: sparse clone 指定子目录
                var gitUrl2 = source.url;
                var subPath2 = source.path || '';
                var ref3 = source.ref || 'main';
                console.log('[PluginInstall] Sparse cloning', gitUrl2, 'subdir=' + subPath2);
                ensureDir(targetDir);
                execSync('git init', { cwd: targetDir, timeout: 10000, windowsHide: true, stdio: 'pipe' });
                execSync('git remote add origin ' + JSON.stringify(gitUrl2), {
                    cwd: targetDir, timeout: 10000, windowsHide: true, stdio: 'pipe'
                });
                execSync('git sparse-checkout init --cone', {
                    cwd: targetDir, timeout: 10000, windowsHide: true, stdio: 'pipe'
                });
                execSync('git sparse-checkout set ' + JSON.stringify(subPath2), {
                    cwd: targetDir, timeout: 10000, windowsHide: true, stdio: 'pipe'
                });
                execSync('git pull origin ' + JSON.stringify(ref3), {
                    cwd: targetDir, timeout: 120000, windowsHide: true, stdio: 'pipe'
                });
                break;
            }
            case 'local': {
                // 本地路径：复制
                var localPath = source.path;
                if (!localPath || !fs.existsSync(localPath)) {
                    return { success: false, error: '本地路径不存在: ' + localPath };
                }
                console.log('[PluginInstall] Copying from', localPath, 'to', targetDir);
                copyRecursive(localPath, targetDir);
                break;
            }
            case 'npm': {
                // npm 包
                var pkg = source.pkg;
                console.log('[PluginInstall] Installing npm package', pkg, 'to', targetDir);
                ensureDir(targetDir);
                // 先初始化 package.json
                fs.writeFileSync(path.join(targetDir, 'package.json'), JSON.stringify({
                    name: name, private: true, dependencies: {}
                }));
                execSync('npm install ' + JSON.stringify(pkg), {
                    cwd: targetDir, timeout: 120000, windowsHide: true, stdio: 'pipe'
                });
                break;
            }
            default:
                return { success: false, error: '不支持的来源类型: ' + source.type };
        }

        return { success: true, name: name, dir: targetDir };
    } catch (e) {
        // 清理失败的安装
        try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch(ign) {}
        return { success: false, error: e.message || '安装失败' };
    }
}

// 卸载插件
function uninstall(name) {
    var installedDir = getInstalledDir();
    var targetDir = path.join(installedDir, name);
    if (!fs.existsSync(targetDir)) return { success: false, error: '插件未安装: ' + name };
    try {
        fs.rmSync(targetDir, { recursive: true, force: true });
        return { success: true };
    } catch(e) {
        return { success: false, error: e.message };
    }
}

// 列出已安装插件
function listInstalled() {
    var installedDir = getInstalledDir();
    if (!fs.existsSync(installedDir)) return [];
    try {
        return fs.readdirSync(installedDir).filter(function(f) {
            return fs.statSync(path.join(installedDir, f)).isDirectory();
        });
    } catch(e) { return []; }
}

// 递归复制目录
function copyRecursive(src, dest) {
    ensureDir(dest);
    var items = fs.readdirSync(src);
    items.forEach(function(item) {
        var s = path.join(src, item);
        var d = path.join(dest, item);
        if (fs.statSync(s).isDirectory()) {
            copyRecursive(s, d);
        } else {
            fs.copyFileSync(s, d);
        }
    });
}

// 获取已安装插件的目录
function getPluginDir(name) {
    var installedDir = getInstalledDir();
    var d = path.join(installedDir, name);
    return fs.existsSync(d) ? d : null;
}

module.exports = {
    install,
    uninstall,
    listInstalled,
    getPluginDir,
    getInstalledDir,
    isGitAvailable
};
