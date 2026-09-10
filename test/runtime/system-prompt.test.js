'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_AGENT_INSTRUCTIONS } = require('../../src/runtime/system-prompt');

test('system prompt explicitly supports nested subagents without a recursion prohibition', () => {
  assert.match(DEFAULT_AGENT_INSTRUCTIONS, /子代理可以继续调用 subagent/);
  assert.doesNotMatch(DEFAULT_AGENT_INSTRUCTIONS, /不能递归|禁止递归|不可递归/);
});
