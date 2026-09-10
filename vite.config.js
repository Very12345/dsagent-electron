'use strict';

const path = require('path');
const { defineConfig } = require('vite');
const react = require('@vitejs/plugin-react');

module.exports = defineConfig({
  root: path.join(__dirname, 'src', 'renderer'),
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
  build: { outDir: path.join(__dirname, 'dist-renderer'), emptyOutDir: true, sourcemap: false }
});
