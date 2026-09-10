'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function run(executable, args, input, options) {
  options = options || {};
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolve(stdout.replace(/\r?\n$/, ''))
      : reject(new Error((stderr || stdout || executable + ' exited with code ' + code).trim())));
    child.stdin.end(input == null ? '' : String(input));
  });
}

function detached(executable, args) {
  const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: false, shell: false });
  child.unref();
  return true;
}

class NativeBridge {
  constructor(options) {
    options = options || {};
    this.platform = options.platform || process.platform;
    this.validateWorkspace = options.validateWorkspace || null;
    this.run = options.run || run;
    this.transactions = new Map();
  }

  setWorkspaceValidator(validate) { this.validateWorkspace = validate; }

  async revealWorkspace(value) {
    if (!this.validateWorkspace) throw Object.assign(new Error('Workspace validation is unavailable'), { code: 'workspace_validation_unavailable' });
    const target = await this.validateWorkspace(String(value || ''));
    if (!target || !path.isAbsolute(target) || !fs.existsSync(target)) throw Object.assign(new Error('Workspace directory does not exist'), { code: 'workspace_not_found' });
    if (this.platform === 'win32') return detached('explorer.exe', [target]);
    if (this.platform === 'darwin') return detached('open', [target]);
    return detached('xdg-open', [target]);
  }

  async openExternal(value) {
    const target = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(target.protocol)) throw Object.assign(new Error('Only HTTP(S) URLs can be opened'), { code: 'external_url_invalid' });
    if (this.platform === 'win32') return detached('rundll32.exe', ['url.dll,FileProtocolHandler', target.toString()]);
    if (this.platform === 'darwin') return detached('open', [target.toString()]);
    return detached('xdg-open', [target.toString()]);
  }

  async selectDirectory() {
    if (this.platform === 'win32') {
      const script = "Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='选择 WebAgent 工作区'; if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Out.Write($d.SelectedPath)}";
      const value = await this.run('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command', script]);
      return value && path.isAbsolute(value) ? value : null;
    }
    if (this.platform === 'darwin') {
      const value = await this.run('osascript', ['-e', 'POSIX path of (choose folder with prompt "Choose WebAgent workspace")']);
      return value ? value.replace(/\/$/, '') : null;
    }
    try { return await this.run('zenity', ['--file-selection', '--directory', '--title=Choose WebAgent workspace']); }
    catch (_) { throw Object.assign(new Error('No supported native directory picker is installed'), { code: 'directory_picker_unavailable' }); }
  }

  async readClipboard() {
    if (this.platform === 'win32') return this.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::Out.Write((Get-Clipboard -Raw -Format Text))']);
    if (this.platform === 'darwin') return this.run('pbpaste', []);
    return this.run('xclip', ['-selection', 'clipboard', '-o']);
  }

  async writeClipboard(text) {
    if (this.platform === 'win32') {
      await this.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$v=[Console]::In.ReadToEnd(); Set-Clipboard -Value $v'], String(text || ''));
      return true;
    }
    if (this.platform === 'darwin') { await this.run('pbcopy', [], String(text || '')); return true; }
    await this.run('xclip', ['-selection', 'clipboard'], String(text || ''));
    return true;
  }

  async beginClipboard(owner) {
    const snapshot = this.platform === 'win32'
      ? await this._captureWindowsClipboard().catch(async () => ({ text: await this.readClipboard().catch(() => '') }))
      : { text: await this.readClipboard().catch(() => '') };
    const token = crypto.randomBytes(16).toString('hex');
    this.transactions.set(token, { owner: String(owner || ''), snapshot, createdAt: Date.now() });
    return { token, text: snapshot.text || '' };
  }

  async endClipboard(owner, saved, expectedText) {
    const token = saved && saved.token;
    const transaction = token && this.transactions.get(token);
    if (!transaction || transaction.owner !== String(owner || '')) return { restored: false, reason: 'invalid_transaction' };
    this.transactions.delete(token);
    const current = await this.readClipboard().catch(() => '');
    if (expectedText != null && current !== String(expectedText)) return { restored: false, reason: 'clipboard_changed' };
    if (this.platform === 'win32') await this._restoreWindowsClipboard(transaction.snapshot);
    else await this.writeClipboard(transaction.snapshot.text || '');
    return { restored: true };
  }

  async _captureWindowsClipboard() {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      '$o=[ordered]@{text="";html="";rtf="";image=""}',
      '$d=[Windows.Forms.Clipboard]::GetDataObject()',
      'if($d){',
      '  if($d.GetDataPresent([Windows.Forms.DataFormats]::UnicodeText)){$o.text=[string]$d.GetData([Windows.Forms.DataFormats]::UnicodeText)}',
      '  elseif($d.GetDataPresent([Windows.Forms.DataFormats]::Text)){$o.text=[string]$d.GetData([Windows.Forms.DataFormats]::Text)}',
      '  if($d.GetDataPresent([Windows.Forms.DataFormats]::Html)){$o.html=[string]$d.GetData([Windows.Forms.DataFormats]::Html)}',
      '  if($d.GetDataPresent([Windows.Forms.DataFormats]::Rtf)){$o.rtf=[string]$d.GetData([Windows.Forms.DataFormats]::Rtf)}',
      '  if($d.GetDataPresent([Windows.Forms.DataFormats]::Bitmap)){',
      '    $img=$d.GetData([Windows.Forms.DataFormats]::Bitmap);$ms=New-Object IO.MemoryStream',
      '    $img.Save($ms,[Drawing.Imaging.ImageFormat]::Png);$o.image=[Convert]::ToBase64String($ms.ToArray());$ms.Dispose()',
      '  }',
      '}',
      '[Console]::Out.Write(($o|ConvertTo-Json -Compress))'
    ].join('; ');
    const raw = await this.run('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command', script]);
    return JSON.parse(raw || '{}');
  }

  async _restoreWindowsClipboard(snapshot) {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      '$o=([Console]::In.ReadToEnd()|ConvertFrom-Json)',
      '$d=New-Object Windows.Forms.DataObject',
      'if($null-ne $o.text){$d.SetData([Windows.Forms.DataFormats]::UnicodeText,[string]$o.text)}',
      'if($o.html){$d.SetData([Windows.Forms.DataFormats]::Html,[string]$o.html)}',
      'if($o.rtf){$d.SetData([Windows.Forms.DataFormats]::Rtf,[string]$o.rtf)}',
      'if($o.image){$bytes=[Convert]::FromBase64String([string]$o.image);$ms=New-Object IO.MemoryStream(,$bytes);$img=[Drawing.Image]::FromStream($ms);$d.SetImage($img);$ms.Dispose()}',
      '[Windows.Forms.Clipboard]::SetDataObject($d,$true)'
    ].join('; ');
    await this.run('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command', script], JSON.stringify(snapshot || {}));
    return true;
  }
}

module.exports = { NativeBridge, run };
