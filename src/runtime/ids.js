'use strict';

const crypto = require('crypto');

function id(prefix) {
  return prefix + '_' + crypto.randomBytes(12).toString('hex');
}

module.exports = { id };
