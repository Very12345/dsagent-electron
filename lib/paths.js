'use strict';

// 统一的品牌路径解析。
// 新架构一律写 ~/.webagent（可用 WEBAGENT_HOME 覆盖）；
// 旧的 ~/.dsa 只作为读取回退，避免老用户数据丢失。

const os = require('os');
const path = require('path');

const BRAND_DIR = '.webagent';
const LEGACY_BRAND_DIR = '.dsa';

function userHome() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function brandHome() {
  return path.resolve(process.env.WEBAGENT_HOME || path.join(userHome(), BRAND_DIR));
}

function legacyBrandHome() {
  return path.join(userHome(), LEGACY_BRAND_DIR);
}

// 返回第一个真实存在的候选目录；都不存在时返回 preferred。
function firstExisting(preferred, legacy) {
  const fs = require('fs');
  try {
    if (preferred && fs.existsSync(preferred)) return preferred;
    if (legacy && fs.existsSync(legacy)) return legacy;
  } catch (_) {}
  return preferred;
}

module.exports = { BRAND_DIR, LEGACY_BRAND_DIR, userHome, brandHome, legacyBrandHome, firstExisting };
