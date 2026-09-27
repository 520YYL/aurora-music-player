'use strict';
/**
 * 静态检查：找出 index.html 里存在、但 JS 从未引用过的元素 id，
 * 以及侧栏导航 / 添加文件夹 等关键交互是否绑定了点击事件。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
const jsFiles = fs.readdirSync(path.join(ROOT, 'src', 'js')).filter((f) => f.endsWith('.js'));
const js = jsFiles.map((f) => fs.readFileSync(path.join(ROOT, 'src', 'js', f), 'utf8')).join('\n');

const ids = [...new Set([...html.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]))];
console.log(`index.html 共 ${ids.length} 个 id`);

const unused = [];
for (const id of ids) {
  const esc = id.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  const re = new RegExp(`#${esc}\\b|getElementById\\(['"]${esc}['"]\\)|['"]${esc}['"]`);
  if (!re.test(js)) unused.push(id);
}

console.log('\n=== 没有任何 JS 引用的 id（可疑：可能没接线）===');
if (!unused.length) console.log('  （无）');
for (const u of unused) console.log('  ' + u);

const checks = [
  ['侧栏导航项 [data-view] 点击绑定', /nav-item\[data-view\][^\n]*onclick|querySelectorAll\(['"]\.nav-item/],
  ['#addFolder 点击绑定', /#addFolder['"]?\)?\s*\.onclick|#addFolder/],
  ['#newPlaylist 点击绑定', /#newPlaylist/],
  ['#winMin 绑定', /#winMin/],
  ['#search 绑定', /#search/],
  ['#btnPlay 绑定', /#btnPlay/],
  ['#pbar 绑定', /#pbar/]
];
console.log('\n=== 关键交互绑定检查 ===');
for (const [label, re] of checks) console.log(`  ${re.test(js) ? '有引用' : '❌ 没有'}  ${label}`);

// 更精确：检查是否有给 nav-item 挂点击的代码
const hasNavClick = /\.nav-item\[data-view\][\s\S]{0,200}?onclick|forEach\([^)]*nav-item[\s\S]{0,200}?onclick/.test(js);
console.log(`\n侧栏导航真有点击处理: ${hasNavClick ? '是' : '❌ 否 —— 这就是 bug'}`);
