'use strict';

const dirtyJson = require('dirty-json');

function decodeEntities(value) {
  return String(value || '')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;|&#34;|&#x22;/gi, '"')
    .replace(/&#65372;|&#xff5c;/gi, '｜')
    .replace(/&amp;/gi, '&');
}

function canonicalizeDsml(value) {
  const source = decodeEntities(value);
  return source.replace(/<\s*(\/?)\s*(?:[|｜]\s*){1,3}DSML\s*(?:[|｜]\s*){1,3}(tool_calls|function_calls|calls|invoke|parameter)\b([^>]*)>/gi,
    (_match, closing, name, attributes) => '<' + (closing ? '/' : '') + 'dsml_' + name.toLowerCase() + (closing ? '' : attributes) + '>');
}

/**
 * Rebuild missing closing tags. DeepSeek's markdown renderer can keep an
 * opening custom tag while consuming its closing tag as DOM (see
 * bridgeCallPayloads in api-server), and long model outputs sometimes drop
 * them outright — a fully intact call then dies as "malformed tags" even
 * though every byte of the arguments is correct. Walk the canonical tags in
 * order and close whatever the next tag cannot legally contain:
 * parameter ⊂ invoke ⊂ tool_calls. Stray closers without an opener are
 * dropped. Content between tags is copied through untouched.
 */
function autoCloseDsml(source) {
  const tagPattern = /<(\/?)dsml_(tool_calls|invoke|parameter)\b[^>]*>/gi;
  const rank = { tool_calls: 0, invoke: 1, parameter: 2 };
  const out = [];
  const open = [];
  let last = 0;
  let match;
  while ((match = tagPattern.exec(source)) !== null) {
    out.push(source.slice(last, match.index));
    last = match.index + match[0].length;
    const kind = match[2].toLowerCase();
    if (!match[1]) {
      while (open.length && rank[open[open.length - 1]] >= rank[kind]) {
        out.push('</dsml_' + open.pop() + '>');
      }
      out.push(match[0]);
      open.push(kind);
    } else {
      while (open.length && rank[open[open.length - 1]] > rank[kind]) {
        out.push('</dsml_' + open.pop() + '>');
      }
      if (open.length && open[open.length - 1] === kind) {
        open.pop();
        out.push(match[0]);
      }
      // else: a closer for a tag that was never opened — drop it
    }
  }
  out.push(source.slice(last));
  while (open.length) out.push('</dsml_' + open.pop() + '>');
  return out.join('');
}

/**
 * Lenient normalizer for the ASSESSMENT and EXTRACTION paths: decode entities,
 * canonicalize the delimiters (1-3 bars, fullwidth or ASCII), then auto-close.
 * NOT used by the streaming gate (completeDsmlSuffix), which keeps its strict
 * "envelope fully closed" semantics.
 */
function normalizeDsmlOutput(value) {
  return autoCloseDsml(canonicalizeDsml(value));
}

function attribute(source, name) {
  const pattern = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*["“”\\\']([^"“”\\\']*)["“”\\\']', 'i');
  const match = String(source || '').match(pattern);
  return match ? match[1] : '';
}

function parameterValue(source, isString) {
  const raw = String(source || '').replace(/^\r?\n/, '').replace(/\r?\n$/, '');
  if (isString === true) return raw;
  const trimmed = raw.trim();
  if (isString === false) {
    try { return JSON.parse(trimmed); }
    catch (_) {
      try { return dirtyJson.parse(trimmed); }
      catch (_) { throw new Error('Invalid DSML JSON parameter'); }
    }
  }
  try { return JSON.parse(trimmed); } catch (_) { return raw; }
}

function parseDsmlCalls(value) {
  const source = canonicalizeDsml(value);
  const calls = [];
  const invokePattern = /<dsml_invoke\b([^>]*)>([\s\S]*?)<\/dsml_invoke>/gi;
  let invoke;
  while ((invoke = invokePattern.exec(source)) !== null) {
    const name = attribute(invoke[1], 'name').trim();
    if (!name) continue;
    const args = {};
    let valid = true;
    let parameterCount = 0;
    const parameterPattern = /<dsml_parameter\b([^>]*)>([\s\S]*?)<\/dsml_parameter>/gi;
    let parameter;
    while ((parameter = parameterPattern.exec(invoke[2])) !== null) {
      const parameterName = attribute(parameter[1], 'name').trim();
      if (!parameterName) { valid = false; break; }
      const stringFlag = attribute(parameter[1], 'string').trim().toLowerCase();
      try {
        args[parameterName] = parameterValue(parameter[2], stringFlag === 'true' ? true : stringFlag === 'false' ? false : null);
        parameterCount += 1;
      } catch (_) { valid = false; break; }
    }
    if (!valid || !parameterCount) continue;
    // Web models sometimes wrap the whole argument object in a single
    // parameter. Accept both spellings: `arguments` is DSH's native name,
    // `params` is what the Runtime system prompt teaches the model
    // ({"tool":"...","params":{...}}). Missing `params` here meant every
    // such call reached the executor with zero real arguments, which then
    // failed with confusing errors and made the agent retry forever.
    let normalizedArguments = args;
    if (parameterCount === 1) {
      for (const wrapper of ['arguments', 'params']) {
        const inner = args[wrapper];
        if (inner && typeof inner === 'object' && !Array.isArray(inner)) { normalizedArguments = inner; break; }
      }
    }
    calls.push({ name, arguments: normalizedArguments, index: invoke.index, end: invokePattern.lastIndex });
  }
  return calls;
}

function dsmlMarkerIndex(value) {
  const source = canonicalizeDsml(value);
  const match = /<dsml_(?:tool_calls?|function_calls?|calls|invoke)\b/i.exec(source);
  return match ? match.index : -1;
}

function completeDsmlSuffix(value) {
  const source = canonicalizeDsml(value);
  const calls = parseDsmlCalls(source);
  if (!calls.length) return [];
  const tail = source.slice(calls[calls.length - 1].end)
    .replace(/<\/dsml_(?:tool_calls|function_calls|calls)>/gi, '')
    .replace(/<\/?dsml_(?:tool_calls|function_calls|calls)[^>]*>/gi, '')
    .replace(/<\s*(?:[|｜]\s*)+end[^>]*>/gi, '')
    .trim();
  return tail ? [] : calls;
}

module.exports = { canonicalizeDsml, autoCloseDsml, normalizeDsmlOutput, parseDsmlCalls, dsmlMarkerIndex, completeDsmlSuffix };
