'use strict';
/** 分析用：验证 F5 / 方向键等按键能否被快捷键匹配逻辑识别 */
const fs = require('node:fs');
const path = require('node:path');

global.window = { addEventListener() {}, removeEventListener() {} };
global.document = { createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} } }), addEventListener() {} };
// Node 18+ 已有只读的 global.navigator，这里改用 defineProperty 覆盖
Object.defineProperty(global, 'navigator', { value: { platform: 'Win32' }, configurable: true });
(0, eval)(fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'util.js'), 'utf8'));
const U = global.window.U;

const ev = (key, extra) => Object.assign({ key, code: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }, extra || {});

console.log('=== 匹配测试：按下某键时，该绑定能否触发 ===');
const cases = [
  ['F5', ev('F5')],
  ['ArrowUp', ev('ArrowUp')],
  ['ArrowDown', ev('ArrowDown')],
  ['ArrowLeft', ev('ArrowLeft')],
  ['ArrowRight', ev('ArrowRight')],
  ['Ctrl+ArrowUp', ev('ArrowUp', { ctrlKey: true })]
];
for (const [spec, e] of cases) {
  console.log('  绑定 ' + spec.padEnd(14) + ' 遇到 ' + String(e.key).padEnd(12) + ' => ' + U.matchHotkey(e, spec));
}
console.log('');
console.log('=== 匹配测试：带修饰键时不应误触发（F5 无修饰）===');
console.log('  绑定 F5 遇到 Ctrl+F5 => ' + U.matchHotkey(ev('F5', { ctrlKey: true }), 'F5'));
console.log('');
console.log('=== 录入测试：按键能否被记录成快捷键 ===');
for (const k of ['F5', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'MediaPlayPause', 'a', 'Control']) {
  console.log('  按下 ' + k.padEnd(16) + ' => ' + JSON.stringify(U.hotkeyFromEvent(ev(k))));
}
