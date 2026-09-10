'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ClipboardTransactions } = require('../../src/runtime/clipboard-transactions');

function fixture() {
  const state = { text: 'original', html: '<b>original</b>', rtf: '{\\rtf1 original}', image: Buffer.from('image') };
  const clipboard = {
    availableFormats: () => ['text/plain', 'text/html', 'text/rtf', 'image/png'],
    readText: () => state.text,
    readHTML: () => state.html,
    readRTF: () => state.rtf,
    readImage: () => ({ isEmpty: () => !state.image, toPNG: () => Buffer.from(state.image) }),
    readBookmark: () => ({ title: '', url: '' }),
    writeText: (text) => { state.text = text; state.html = ''; state.rtf = ''; state.image = null; },
    write: (data) => { state.text = data.text || ''; state.html = data.html || ''; state.rtf = data.rtf || ''; state.image = data.image && data.image.buffer || null; },
    clear: () => { state.text = ''; state.html = ''; state.rtf = ''; state.image = null; }
  };
  const nativeImage = { createFromBuffer: (buffer) => ({ buffer: Buffer.from(buffer) }) };
  return { state, manager: new ClipboardTransactions({ clipboard, nativeImage, timeoutMs: 5000 }) };
}

test('temporary webpage copy restores text, HTML, RTF and image clipboard formats', async () => {
  const f = fixture();
  const saved = await f.manager.begin(1);
  f.manager.writeText(1, saved.token, 'webpage markdown');
  assert.equal(f.manager.readText(1, saved.token), 'webpage markdown');
  assert.deepEqual(f.manager.end(1, saved, 'webpage markdown'), { restored: true, preserved_newer_content: false });
  assert.equal(f.state.text, 'original');
  assert.equal(f.state.html, '<b>original</b>');
  assert.equal(f.state.rtf, '{\\rtf1 original}');
  assert.deepEqual(f.state.image, Buffer.from('image'));
});

test('a newer user clipboard change wins over transaction restoration', async () => {
  const f = fixture();
  const saved = await f.manager.begin(1);
  f.manager.writeText(1, saved.token, 'webpage markdown');
  f.manager.readText(1, saved.token);
  f.state.text = 'user copied this later';
  assert.deepEqual(f.manager.end(1, saved, 'webpage markdown'), { restored: false, preserved_newer_content: true });
  assert.equal(f.state.text, 'user copied this later');
});

test('clipboard transactions serialize competing webpage workers', async () => {
  const f = fixture();
  const first = await f.manager.begin(1);
  let secondResolved = false;
  const secondPromise = f.manager.begin(2).then((value) => { secondResolved = true; return value; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(secondResolved, false);
  f.manager.writeText(1, first.token, 'first worker');
  f.manager.end(1, first, 'first worker');
  const second = await secondPromise;
  assert.equal(second.text, 'original');
  f.manager.end(2, second, 'original');
});
