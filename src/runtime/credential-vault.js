'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const path = require('path');

const ENVELOPE_PREFIX = 'webagent:v1:';
const DPAPI_ENTROPY = 'WebAgent CredentialVault v1';

class CredentialVaultError extends Error {
  constructor(message, code, cause) {
    super(message);
    this.name = 'CredentialVaultError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function vaultError(message, code, cause) {
  return new CredentialVaultError(message, code, cause);
}

function decodeEnvelope(value) {
  const text = String(value || '');
  if (!text.startsWith(ENVELOPE_PREFIX)) return null;
  const separator = text.indexOf(':', ENVELOPE_PREFIX.length);
  if (separator < 0) throw vaultError('Credential envelope is malformed', 'credential_envelope_invalid');
  return {
    backend: text.slice(ENVELOPE_PREFIX.length, separator),
    payload: text.slice(separator + 1)
  };
}

function encodeEnvelope(backend, payload) {
  return ENVELOPE_PREFIX + backend + ':' + String(payload || '');
}

class CredentialVault {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.safeStorage = options.safeStorage || options.electronSafeStorage || null;
    this.backend = options.backend || null;
    this.legacyDecrypt = typeof options.legacyDecrypt === 'function' ? options.legacyDecrypt : null;
    this.onLegacyDecrypted = typeof options.onLegacyDecrypted === 'function' ? options.onLegacyDecrypted : null;
    this.spawnSync = options.spawnSync || childProcess.spawnSync;
    this.randomBytes = options.randomBytes || crypto.randomBytes;
    this.serviceName = options.serviceName || 'WebAgent';
    this.powershellPath = options.powershellPath || this._defaultPowerShellPath(options.env || process.env);
  }

  isAvailable() {
    if (this.backend) return typeof this.backend.isAvailable !== 'function' || !!this.backend.isAvailable();
    if (this.safeStorage) {
      return typeof this.safeStorage.isEncryptionAvailable !== 'function' || !!this.safeStorage.isEncryptionAvailable();
    }
    return this.platform === 'win32' || this.platform === 'linux';
  }

  encrypt(value) {
    const plaintext = String(value == null ? '' : value);
    if (!plaintext) return '';

    if (this.backend) {
      this._assertCustomBackend();
      return encodeEnvelope('custom', this.backend.encrypt(plaintext));
    }
    if (this.safeStorage) {
      this._assertSafeStorage();
      const encrypted = this.safeStorage.encryptString(plaintext);
      return encodeEnvelope('safe-storage', Buffer.from(encrypted).toString('base64'));
    }
    if (this.platform === 'win32') return encodeEnvelope('dpapi', this._protectWithDpapi(plaintext, true));
    if (this.platform === 'linux') return this._storeWithSecretService(plaintext);
    if (this.platform === 'darwin') {
      throw vaultError(
        'macOS Keychain encryption is unavailable without a native keychain adapter; inject a CredentialVault backend or Electron safeStorage',
        'credential_vault_unavailable'
      );
    }
    throw vaultError('No operating-system credential vault is available on ' + this.platform, 'credential_vault_unavailable');
  }

  decrypt(value) {
    const ciphertext = String(value || '');
    if (!ciphertext) return '';
    const envelope = decodeEnvelope(ciphertext);
    if (!envelope) return this.decryptLegacy(ciphertext);

    if (envelope.backend === 'safe-storage') {
      this._assertSafeStorage();
      return this.safeStorage.decryptString(Buffer.from(envelope.payload, 'base64'));
    }
    if (envelope.backend === 'dpapi') {
      if (this.platform !== 'win32') {
        throw vaultError('A Windows DPAPI credential cannot be decrypted on ' + this.platform, 'credential_backend_mismatch');
      }
      return this._unprotectWithDpapi(envelope.payload, true);
    }
    if (envelope.backend === 'secret-service') {
      if (this.platform !== 'linux') {
        throw vaultError('A Secret Service credential cannot be decrypted on ' + this.platform, 'credential_backend_mismatch');
      }
      return this._lookupSecretService(envelope.payload);
    }
    if (envelope.backend === 'custom') {
      this._assertCustomBackend();
      return this.backend.decrypt(envelope.payload);
    }
    throw vaultError('Unsupported credential backend: ' + envelope.backend, 'credential_backend_unsupported');
  }

  decryptLegacy(value) {
    const ciphertext = String(value || '');
    if (!ciphertext) return '';
    let plaintext;
    let backendName = '';

    if (this.legacyDecrypt) {
      plaintext = this.legacyDecrypt(ciphertext);
      if (plaintext !== undefined && plaintext !== null) backendName = 'legacy-hook';
    }
    if (plaintext === undefined && this.safeStorage) {
      this._assertSafeStorage();
      plaintext = this.safeStorage.decryptString(Buffer.from(ciphertext, 'base64'));
      backendName = 'electron-safe-storage';
    }
    if (plaintext === undefined && this.platform === 'win32') {
      plaintext = this._unprotectWithDpapi(ciphertext, false);
      backendName = 'electron-safe-storage-dpapi';
    }
    if (plaintext === undefined) {
      throw vaultError(
        'Legacy credential cannot be decrypted; provide legacyDecrypt or Electron safeStorage during migration',
        'credential_legacy_decrypt_unavailable'
      );
    }
    if (this.onLegacyDecrypted) this.onLegacyDecrypted({ backend: backendName, ciphertext });
    return String(plaintext);
  }

  isLegacy(value) {
    return !!value && !String(value).startsWith(ENVELOPE_PREFIX);
  }

  migrateLegacy(value) {
    return this.encrypt(this.decryptLegacy(value));
  }

  _assertCustomBackend() {
    if (!this.backend || typeof this.backend.encrypt !== 'function' || typeof this.backend.decrypt !== 'function') {
      throw vaultError('Injected credential backend must provide encrypt and decrypt', 'credential_backend_invalid');
    }
    if (typeof this.backend.isAvailable === 'function' && !this.backend.isAvailable()) {
      throw vaultError('Injected credential backend is unavailable', 'credential_vault_unavailable');
    }
  }

  _assertSafeStorage() {
    if (!this.safeStorage || typeof this.safeStorage.encryptString !== 'function' || typeof this.safeStorage.decryptString !== 'function') {
      throw vaultError('Electron safeStorage adapter is invalid', 'credential_backend_invalid');
    }
    if (typeof this.safeStorage.isEncryptionAvailable === 'function' && !this.safeStorage.isEncryptionAvailable()) {
      throw vaultError('Electron safeStorage encryption is unavailable', 'credential_vault_unavailable');
    }
  }

  _defaultPowerShellPath(env) {
    const systemRoot = env.SystemRoot || env.SYSTEMROOT;
    return systemRoot
      ? path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe';
  }

  _powershell(script, input, operation) {
    const result = this.spawnSync(this.powershellPath, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command', script
    ], {
      input,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024
    });
    return this._commandOutput(result, 'Windows DPAPI ' + operation);
  }

  _protectWithDpapi(plaintext, useEntropy) {
    const entropy = useEntropy
      ? `[Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}')`
      : '$null';
    const script = [
      '$ErrorActionPreference = "Stop"',
      'Add-Type -AssemblyName System.Security',
      '$plain = [Console]::In.ReadToEnd()',
      '$bytes = [Text.Encoding]::UTF8.GetBytes($plain)',
      `$entropy = ${entropy}`,
      '$cipher = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)',
      '[Console]::Out.Write([Convert]::ToBase64String($cipher))'
    ].join('; ');
    return this._powershell(script, plaintext, 'encryption').trim();
  }

  _unprotectWithDpapi(payload, useEntropy) {
    const entropy = useEntropy
      ? `[Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}')`
      : '$null';
    const script = [
      '$ErrorActionPreference = "Stop"',
      'Add-Type -AssemblyName System.Security',
      '$cipherText = [Console]::In.ReadToEnd().Trim()',
      '$cipher = [Convert]::FromBase64String($cipherText)',
      `$entropy = ${entropy}`,
      '$plain = [Security.Cryptography.ProtectedData]::Unprotect($cipher, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)',
      '[Console]::Out.Write([Convert]::ToBase64String($plain))'
    ].join('; ');
    const encodedPlaintext = this._powershell(script, payload, 'decryption').trim();
    try {
      return Buffer.from(encodedPlaintext, 'base64').toString('utf8');
    } catch (error) {
      throw vaultError('Windows DPAPI returned invalid plaintext', 'credential_decryption_failed', error);
    }
  }

  _storeWithSecretService(plaintext) {
    const id = this.randomBytes(18).toString('hex');
    const encoded = Buffer.from(plaintext, 'utf8').toString('base64');
    const result = this.spawnSync('secret-tool', [
      'store',
      '--label=' + this.serviceName + ' API credential',
      'application', 'webagent',
      'service', this.serviceName,
      'credential', id
    ], {
      input: encoded,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024
    });
    this._commandOutput(result, 'Secret Service storage');
    return encodeEnvelope('secret-service', id);
  }

  _lookupSecretService(id) {
    const result = this.spawnSync('secret-tool', [
      'lookup',
      'application', 'webagent',
      'service', this.serviceName,
      'credential', id
    ], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    const encoded = this._commandOutput(result, 'Secret Service lookup').trim();
    if (!encoded) throw vaultError('Credential was not found in Secret Service', 'credential_not_found');
    try {
      return Buffer.from(encoded, 'base64').toString('utf8');
    } catch (error) {
      throw vaultError('Secret Service returned an invalid credential', 'credential_decryption_failed', error);
    }
  }

  _commandOutput(result, operation) {
    if (!result || result.error) {
      throw vaultError(operation + ' is unavailable', 'credential_vault_unavailable', result && result.error);
    }
    if (result.status !== 0) {
      const detail = String(result.stderr || '').trim().replace(/\s+/g, ' ').slice(0, 300);
      throw vaultError(operation + ' failed' + (detail ? ': ' + detail : ''), 'credential_vault_operation_failed');
    }
    return String(result.stdout || '');
  }
}

function createCredentialVault(options) {
  return new CredentialVault(options);
}

module.exports = {
  CredentialVault,
  CredentialVaultError,
  createCredentialVault,
  decodeEnvelope,
  ENVELOPE_PREFIX
};
