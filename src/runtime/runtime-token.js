'use strict';

/**
 * The Runtime's bearer token, and how it outlives a restart.
 *
 * The token used to be minted fresh on every boot, which made every client that
 * had stored it fail with 401 as soon as the service restarted: the desktop DSH
 * profile's `webagent` provider resolves the `WEBAGENT_DSH_TOKEN` credential,
 * and only the Runtime knows the value.
 *
 * The provider runtime resolves its token here and reuses the persisted value
 * across launches. Official DSH resolves the matching credential separately.
 *
 * @module webagent-dsh-core/runtime-token
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Resolve the token, preferring an explicit operator override, then the
 * persisted file, then a newly minted value written back for the next boot.
 *
 * A blank or unreadable file falls through to minting rather than booting with
 * no usable token, which would lock every client out silently. Persisting is
 * best-effort: a read-only home still boots with a working in-process token,
 * because refusing to start would be worse than a token that fails to outlive
 * the process.
 *
 * @param {string} file - absolute path of the persisted token file.
 * @returns {string} the token to authenticate clients with.
 */
function resolveRuntimeToken(file) {
  const fromEnv = String(process.env.WEBAGENT_RUNTIME_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  const persisted = readTokenFile(file);
  if (persisted) return persisted;
  const token = crypto.randomBytes(24).toString('hex');
  try {
    writeTokenFile(file, token);
  } catch (error) {
    console.warn('[runtime] could not persist the bearer token to ' + file + ': ' + error.message);
  }
  return token;
}

/**
 * Read a previously persisted token.
 * @param {string} file - absolute path of the token file.
 * @returns {string} the trimmed token, or an empty string when absent/unreadable.
 */
function readTokenFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_error) {
    return '';
  }
  return text.trim();
}

/**
 * Persist a token atomically, owner-only where the filesystem supports modes.
 * @param {string} file - absolute path of the token file.
 * @param {string} token - the value to write.
 * @returns {void}
 */
function writeTokenFile(file, token) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(temporary, token + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
  // rename() keeps the temporary file's mode, but an existing target on some
  // platforms is replaced with it; re-assert so the secret stays owner-only.
  try { fs.chmodSync(file, 0o600); } catch (_error) { /* non-POSIX filesystem */ }
}

/**
 * The token file's location for a runtime home, unless an operator redirects it.
 * @param {string} home - the resolved runtime home.
 * @returns {string} absolute path of the token file.
 */
function tokenFileFor(home) {
  return path.resolve(process.env.WEBAGENT_RUNTIME_TOKEN_FILE || path.join(home, 'runtime-token'));
}

module.exports = { resolveRuntimeToken, readTokenFile, writeTokenFile, tokenFileFor };
