'use strict';

module.exports = {
  testDir: './test/e2e', timeout: 45000, workers: 1, fullyParallel: false,
  reporter: [['list']], use: { channel: 'msedge', trace: 'retain-on-failure', screenshot: 'only-on-failure' }
};
