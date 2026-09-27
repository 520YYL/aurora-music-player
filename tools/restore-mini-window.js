'use strict';
/** 把被误删的 createMiniWindow 从 git 历史里取回来并插回原位 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const f = path.join(ROOT, 'electron', 'main.js');

const old = execFileSync('git', ['show', 'HEAD:electron/main.js'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const start = old.indexOf('function createMiniWindow() {');
const end = old.indexOf('function broadcast(', start);
if (start < 0 || end < 0) throw new Error('无法从历史版本中定位 createMiniWindow');
const fn = old.slice(start, end).replace(/\s+$/, '') + '\n\n';

let s = fs.readFileSync(f, 'utf8');
if (s.includes('function createMiniWindow()')) {
  console.log('createMiniWindow 已存在，无需插入');
} else {
  const anchor = 'function broadcast(';
  const i = s.indexOf(anchor);
  if (i < 0) throw new Error('找不到插入锚点 function broadcast(');
  s = s.slice(0, i) + fn + s.slice(i);
  fs.writeFileSync(f, s);
  console.log('已插回 createMiniWindow，', fn.length, '字节');
}
