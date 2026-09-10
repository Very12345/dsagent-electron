'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { NativeBridge } = require('../../src/node/native-bridge');

test('Windows provider clipboard transaction restores text, HTML, RTF and image snapshot', async () => {
  const restored = [];
  const runner = async (_exe, args, input) => {
    const script = args[args.length - 1];
    if (script.includes('GetDataObject')) return JSON.stringify({ text: 'original', html: '<b>original</b>', rtf: '{\\rtf1 original}', image: 'aW1hZ2U=' });
    if (script.includes('Get-Clipboard')) return 'webpage markdown';
    if (script.includes('SetDataObject')) { restored.push(JSON.parse(input)); return ''; }
    throw new Error('unexpected command');
  };
  const bridge = new NativeBridge({ platform: 'win32', run: runner });
  const saved = await bridge.beginClipboard('worker');
  assert.equal(saved.text, 'original');
  assert.deepEqual(await bridge.endClipboard('worker', saved, 'webpage markdown'), { restored: true });
  assert.deepEqual(restored, [{ text: 'original', html: '<b>original</b>', rtf: '{\\rtf1 original}', image: 'aW1hZ2U=' }]);
});

test('a newer user clipboard value is preserved instead of overwritten', async () => {
  let restored = 0;
  const runner = async (_exe, args) => {
    const script = args[args.length - 1];
    if (script.includes('GetDataObject')) return JSON.stringify({ text: 'original', html: '', rtf: '', image: '' });
    if (script.includes('Get-Clipboard')) return 'user copied later';
    if (script.includes('SetDataObject')) { restored += 1; return ''; }
    throw new Error('unexpected command');
  };
  const bridge = new NativeBridge({ platform: 'win32', run: runner });
  const saved = await bridge.beginClipboard('worker');
  assert.deepEqual(await bridge.endClipboard('worker', saved, 'webpage markdown'), { restored: false, reason: 'clipboard_changed' });
  assert.equal(restored, 0);
});

test('external URL bridge rejects non-HTTP protocols before launching anything', async () => {
  const bridge = new NativeBridge({ platform: 'win32', run: async () => '' });
  await assert.rejects(bridge.openExternal('file:///C:/Windows/System32'), { code: 'external_url_invalid' });
});
