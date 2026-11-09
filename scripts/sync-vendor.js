'use strict';

/* Копирует библиотеки из node_modules в app/vendor.
   Запуск: npm run sync-vendor */

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const vendor = path.join(root, 'app', 'vendor');

const files = [
  ['katex/dist/katex.min.js', 'katex.min.js'],
  ['katex/dist/katex.min.css', 'katex.min.css'],
  ['marked/lib/marked.umd.js', 'marked.umd.js'],
  ['dompurify/dist/purify.min.js', 'purify.min.js']
];

fs.mkdirSync(vendor, { recursive: true });

for (const [from, to] of files) {
  const source = path.join(root, 'node_modules', from);
  const target = path.join(vendor, to);
  fs.copyFileSync(source, target);
  console.log('vendor: ' + to);
}

const fontsFrom = path.join(root, 'node_modules', 'katex', 'dist', 'fonts');
const fontsTo = path.join(vendor, 'fonts');

fs.rmSync(fontsTo, { recursive: true, force: true });
fs.mkdirSync(fontsTo, { recursive: true });

for (const name of fs.readdirSync(fontsFrom)) {
  fs.copyFileSync(path.join(fontsFrom, name), path.join(fontsTo, name));
}

console.log('vendor: fonts (' + fs.readdirSync(fontsTo).length + ' файлов)');
