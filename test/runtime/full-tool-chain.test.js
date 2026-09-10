'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RuntimeConfigStore } = require('../../src/runtime/config-store');
const { ToolRegistry } = require('../../src/runtime/tool-registry');
const { createToolExecutor } = require('../../src/runtime/tool-executor');

test('isolated project completes search, read, patch, command, image, skill and MCP tool flow', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsagent-full-tools-'));
  const mcp = require('../../server-mcp').manager;
  const originalCall = mcp.callTool;
  try {
    fs.writeFileSync(path.join(root, 'sample.txt'), 'alpha\nbeta\n', 'utf8');
    fs.writeFileSync(path.join(root, 'pixel.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    const skillDir = path.join(root, '.dsa', 'skills', 'verify'); fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: verify\ndescription: test\nallowed_tools: []\n---\nVERIFY $ARGUMENTS', 'utf8');
    require('../../skill-engine').refresh(root);
    const config = new RuntimeConfigStore(root).init();
    config.patchSettings('user', null, { tools: { command: 'allow', network: 'allow' } });
    const executor = createToolExecutor({ workspace: root, config, registry: new ToolRegistry({ config }) });
    assert.equal((await executor.execute('rg', { pattern: 'beta' })).success, true);
    assert.match((await executor.execute('read_file', { path: 'sample.txt' })).data.content, /alpha/);
    assert.equal((await executor.execute('apply_patch', { path: 'sample.txt', find: 'beta', replace: 'gamma' })).success, true);
    assert.match((await executor.execute('exec_command', { command: 'Get-Content sample.txt' })).data.stdout, /gamma/);
    assert.equal((await executor.execute('view_image', { path: 'pixel.png' })).data.mime, 'png');
    const skill = await executor.execute('use_skill', { name: 'verify', arguments: 'OK' });
    assert.match(skill.data.expanded, /VERIFY OK/);
    mcp.callTool = async (server, tool, args) => ({ server, tool, args, verified: true });
    const external = await executor.execute('mcp', { server: 'mock', tool: 'verify', args: { value: 1 } });
    assert.equal(external.data.verified, true);
  } finally {
    mcp.callTool = originalCall;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
