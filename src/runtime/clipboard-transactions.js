'use strict';

const crypto = require('crypto');

function hasFormat(formats, pattern) {
  return (formats || []).some((format) => pattern.test(String(format || '')));
}

class ClipboardTransactions {
  constructor(options) {
    this.clipboard = options.clipboard;
    this.nativeImage = options.nativeImage;
    this.timeoutMs = Math.max(5000, Number(options.timeoutMs) || 60000);
    this.active = null;
    this.tail = Promise.resolve();
  }

  _capture() {
    const formats = this.clipboard.availableFormats('clipboard');
    const image = this.clipboard.readImage('clipboard');
    const bookmark = this.clipboard.readBookmark();
    return {
      formats,
      text: this.clipboard.readText('clipboard'),
      html: this.clipboard.readHTML('clipboard'),
      rtf: this.clipboard.readRTF('clipboard'),
      image: image && !image.isEmpty() ? image.toPNG() : null,
      bookmark: bookmark && (bookmark.title || bookmark.url) ? bookmark : null
    };
  }

  _restore(snapshot) {
    const data = {};
    if (hasFormat(snapshot.formats, /text\/plain|text\/unicode|unicode text/i)) data.text = snapshot.text;
    if (hasFormat(snapshot.formats, /text\/html|html format/i)) data.html = snapshot.html;
    if (hasFormat(snapshot.formats, /text\/rtf|rich text format/i)) data.rtf = snapshot.rtf;
    if (snapshot.image && snapshot.image.length) data.image = this.nativeImage.createFromBuffer(snapshot.image);
    if (snapshot.bookmark) {
      data.bookmark = snapshot.bookmark.title || '';
      if (data.text === undefined) data.text = snapshot.bookmark.url || '';
    }
    if (Object.keys(data).length) this.clipboard.write(data, 'clipboard');
    else this.clipboard.clear('clipboard');
  }

  async begin(ownerId) {
    let release;
    const previous = this.tail;
    this.tail = new Promise((resolve) => { release = resolve; });
    await previous;
    const transaction = {
      token: crypto.randomUUID(), ownerId, snapshot: this._capture(), lastObservedText: null, release, timer: null
    };
    transaction.timer = setTimeout(() => this._expire(transaction), this.timeoutMs);
    if (transaction.timer.unref) transaction.timer.unref();
    this.active = transaction;
    return { token: transaction.token, text: transaction.snapshot.text };
  }

  readText(ownerId, token) {
    const text = this.clipboard.readText('clipboard');
    if (this._owns(ownerId, token)) this.active.lastObservedText = text;
    return text;
  }

  writeText(ownerId, token, text) {
    const value = String(text || '');
    this.clipboard.writeText(value, 'clipboard');
    if (this._owns(ownerId, token)) this.active.lastObservedText = value;
    return true;
  }

  end(ownerId, saved, expectedText) {
    const token = saved && typeof saved === 'object' ? saved.token : '';
    if (!this._owns(ownerId, token)) return { restored: false, reason: 'clipboard_transaction_not_owned' };
    const transaction = this.active;
    const current = this.clipboard.readText('clipboard');
    const expected = expectedText == null ? transaction.lastObservedText : String(expectedText);
    const userChanged = expected != null && current !== expected && current !== transaction.snapshot.text;
    if (!userChanged && current !== transaction.snapshot.text) this._restore(transaction.snapshot);
    this._release(transaction);
    return { restored: !userChanged, preserved_newer_content: userChanged };
  }

  _owns(ownerId, token) { return !!this.active && this.active.ownerId === ownerId && this.active.token === token; }

  _expire(transaction) {
    if (this.active !== transaction) return;
    const current = this.clipboard.readText('clipboard');
    if (transaction.lastObservedText != null && (current === transaction.lastObservedText || current === transaction.snapshot.text)) {
      if (current !== transaction.snapshot.text) this._restore(transaction.snapshot);
    }
    this._release(transaction);
  }

  _release(transaction) {
    if (this.active !== transaction) return;
    if (transaction.timer) clearTimeout(transaction.timer);
    this.active = null;
    transaction.release();
  }
}

module.exports = { ClipboardTransactions };
