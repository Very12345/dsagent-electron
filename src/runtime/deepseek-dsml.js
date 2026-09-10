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

module.exports = { canonicalizeDsml, parseDsmlCalls, dsmlMarkerIndex, completeDsmlSuffix };
