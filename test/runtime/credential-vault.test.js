'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  CredentialVault,
  CredentialVaultError,
  decodeEnvelope
} = require('../../src/runtime/credential-vault');

test('Windows DPAPI receives plaintext only through stdin', () => {
  const calls = [];
  const secret = 'sk-private command line sentinel';
  const vault = new CredentialVault({
    platform: 'win32',
    powershellPath: 'powershell.exe',
    spawnSync(command, args, options) {
      calls.push({ command, args, options });
      const script = args[args.length - 1];
      if (script.includes('::Protect(')) {
        return { status: 0, stdout: Buffer.from('protected-bytes').toString('base64'), stderr: '' };
      }
      return { status: 0, stdout: Buffer.from(secret, 'utf8').toString('base64'), stderr: '' };
    }
  });

  const encrypted = vault.encrypt(secret);
  assert.match(encrypted, /^webagent:v1:dpapi:/);
  assert.equal(vault.decrypt(encrypted), secret);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.input, secret);
  assert.equal(calls[0].args.join(' ').includes(secret), false);
  assert.equal(calls[1].args.join(' ').includes(secret), false);
  assert.equal(calls[0].options.windowsHide, true);
});

test('Windows legacy Electron DPAPI ciphertext is decrypted without application entropy', () => {
  let decryptScript = '';
  const vault = new CredentialVault({
    platform: 'win32',
    spawnSync(_command, args) {
      decryptScript = args[args.length - 1];
      return { status: 0, stdout: Buffer.from('legacy-key', 'utf8').toString('base64'), stderr: '' };
    }
  });
  assert.equal(vault.decrypt('bGVnYWN5LWRwYXBpLWJsb2I='), 'legacy-key');
  assert.match(decryptScript, /\$entropy = \$null/);
});

test('Electron safeStorage remains an injectable backend and reads raw legacy ciphertext', () => {
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from('safe:' + value, 'utf8'),
    decryptString: (value) => String(value).replace(/^safe:/, '')
  };
  const vault = new CredentialVault({ platform: 'freebsd', safeStorage });
  const encrypted = vault.encrypt('adapter-secret');
  assert.equal(decodeEnvelope(encrypted).backend, 'safe-storage');
  assert.equal(vault.decrypt(encrypted), 'adapter-secret');
  assert.equal(vault.decrypt(Buffer.from('safe:legacy-secret').toString('base64')), 'legacy-secret');
});

test('legacy decrypt and notification hooks support one-time migration', () => {
  const notifications = [];
  const vault = new CredentialVault({
    platform: 'freebsd',
    backend: {
      encrypt: (value) => Buffer.from(value).toString('base64'),
      decrypt: (value) => Buffer.from(value, 'base64').toString('utf8')
    },
    legacyDecrypt: (value) => value === 'old-ciphertext' ? 'old-secret' : undefined,
    onLegacyDecrypted: (metadata) => notifications.push(metadata)
  });
  const migrated = vault.migrateLegacy('old-ciphertext');
  assert.equal(vault.decrypt(migrated), 'old-secret');
  assert.deepEqual(notifications, [{ backend: 'legacy-hook', ciphertext: 'old-ciphertext' }]);
});

test('Linux Secret Service stores base64 through stdin and only persists an opaque reference', () => {
  const calls = [];
  const secret = 'linux-key';
  const id = 'ab'.repeat(18);
  const vault = new CredentialVault({
    platform: 'linux',
    randomBytes: () => Buffer.from(id, 'hex'),
    spawnSync(command, args, options) {
      calls.push({ command, args, options });
      if (args[0] === 'store') return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: Buffer.from(secret).toString('base64') + '\n', stderr: '' };
    }
  });
  const encrypted = vault.encrypt(secret);
  assert.equal(encrypted, 'webagent:v1:secret-service:' + id);
  assert.equal(vault.decrypt(encrypted), secret);
  assert.equal(calls[0].command, 'secret-tool');
  assert.equal(calls[0].args.join(' ').includes(secret), false);
  assert.equal(calls[0].options.input, Buffer.from(secret).toString('base64'));
});

test('missing vault commands and unsupported macOS backend fail closed', () => {
  const missing = new CredentialVault({
    platform: 'linux',
    spawnSync: () => ({ error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) })
  });
  assert.throws(() => missing.encrypt('secret'), (error) => {
    assert.ok(error instanceof CredentialVaultError);
    assert.equal(error.code, 'credential_vault_unavailable');
    return true;
  });

  const mac = new CredentialVault({ platform: 'darwin' });
  assert.throws(() => mac.encrypt('secret'), (error) => {
    assert.equal(error.code, 'credential_vault_unavailable');
    assert.match(error.message, /Keychain/);
    return true;
  });
});

test('apikey-store is Electron-free, accepts vault injection, and never writes a plaintext API key', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webagent-credential-store-'));
  const storeFile = path.join(directory, 'providers.json');
  const store = require('../../apikey-store');
  const vault = {
    encrypt(value) { return 'test:v1:' + Buffer.from(value).toString('base64'); },
    decrypt(value) { return Buffer.from(String(value).replace(/^test:v1:/, ''), 'base64').toString('utf8'); }
  };

  try {
    store.resetConfiguration();
    store.configure({ storeFile, vault });
    const result = store.addService({
      id: 'svc-test',
      provider: 'openai',
      name: 'Test',
      endpoint: 'http://127.0.0.1:8000/v1',
      protocol: 'auto',
      apiKey: 'plaintext-must-not-appear',
      models: []
    });
    assert.deepEqual(result, { success: true, id: 'svc-test' });
    const raw = fs.readFileSync(storeFile, 'utf8');
    assert.equal(raw.includes('plaintext-must-not-appear'), false);
    assert.match(raw, /test:v1:/);
    assert.equal(store.getService('svc-test').apiKey, 'plaintext-must-not-appear');
  } finally {
    store.resetConfiguration();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
