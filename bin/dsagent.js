#!/usr/bin/env node
/**
 * DS Agent CLI — 通过 npm 全局安装后可用 `dsagent` 命令启动
 */
const { spawn } = require('child_process');
const path = require('path');

// electron 作为 dependencies 安装，require 返回 electron 的可执行文件路径
const electronPath = require('electron');
const appDir = path.join(__dirname, '..');

const proc = spawn(electronPath, [appDir, '--no-sandbox'], {
    stdio: 'inherit',
    windowsHide: false
});

proc.on('close', (code) => process.exit(code));
proc.on('error', (err) => {
    console.error('启动 DS Agent 失败:', err.message);
    process.exit(1);
});