'use strict';

// Local transport token estimate; DSH owns context compaction.
function estimateTokens(value) {
  const text = String(value || '');
  let latin = 0;
  let wide = 0;
  for (const character of text) /[\u3400-\u9fff\uf900-\ufaff]/.test(character) ? wide += 1 : latin += 1;
  return Math.ceil(wide / 1.6 + latin / 4);
}

module.exports = { estimateTokens };
