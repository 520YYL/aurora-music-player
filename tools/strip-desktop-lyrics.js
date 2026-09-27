'use strict';
/**
 * 一次性清理脚本：从主进程移除「桌面歌词浮层」相关代码。
 * （用户明确要求删除该功能）
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const f = path.join(ROOT, 'electron', 'main.js');
let s = fs.readFileSync(f, 'utf8');
const before = s.length;

function must(needle, label) {
  if (!s.includes(needle)) throw new Error('锚点未找到: ' + (label || needle.slice(0, 70)));
}
function cutRange(startAnchor, endAnchor) {
  must(startAnchor, 'start:' + startAnchor.slice(0, 50));
  const i = s.indexOf(startAnchor);
  const j = s.indexOf(endAnchor, i);
  if (j < 0) throw new Error('结束锚点未找到: ' + endAnchor.slice(0, 60));
  s = s.slice(0, i) + s.slice(j);
}

// 1) 变量声明
const declLine = '/** @type {BrowserWindow|null} */ let lyricsWindow = null;\n';
must(declLine, 'lyricsWindow 声明');
s = s.replace(declLine, '');

// 2) createLyricsWindow 整个函数
cutRange('function createLyricsWindow() {', 'function broadcast(');

// 3) 全局快捷键动作表
must("toggleDesktopLyrics: 'toggleDesktopLyrics'", 'GLOBAL_ACTIONS');
s = s.replace(", toggleDesktopLyrics: 'toggleDesktopLyrics'", '');

// 4) 全局动作分发
const branch = "  if (action === 'toggleDesktopLyrics') { toggleDesktopLyrics(); return; }\n";
must(branch, 'handleGlobalAction 分支');
s = s.replace(branch, '');

// 5) toggleDesktopLyrics 函数
cutRange('function toggleDesktopLyrics(force) {', 'function toggleMini(');

// 6) settings:merge 中的应用调用
const mergeCall = "    if (patch && patch.lyrics) applyLyricsSettings(patch.lyrics);\n";
must(mergeCall, 'settings:merge');
s = s.replace(mergeCall, '');

// 7) 所有 lyricsWin:* IPC 处理（保留后面的迷你播放器部分）
cutRange("  handle('lyricsWin:toggle'", '  // 迷你播放器');

// 8) applyLyricsSettings 函数
cutRange('function applyLyricsSettings(patch) {', 'function applyMiniSettings(');

// 9) 托盘菜单项
const trayItem = "      { label: '桌面歌词', type: 'checkbox', checked: settingsStore.get('lyrics.desktopEnabled', false), click: (i) => toggleDesktopLyrics(i.checked) },\n";
must(trayItem, '托盘项');
s = s.replace(trayItem, '');

// 10) 启动时自动创建浮层
const bootCreate = "  if (settingsStore.get('lyrics.desktopEnabled', false)) { createLyricsWindow(); }\n";
must(bootCreate, 'whenReady 自动创建');
s = s.replace(bootCreate, '');

fs.writeFileSync(f, s);
const count = (re) => (s.match(re) || []).length;
console.log(`main.js: ${before} -> ${s.length} 字节`);
console.log('剩余引用  lyricsWindow:', count(/lyricsWindow/g));
console.log('剩余引用  toggleDesktopLyrics:', count(/toggleDesktopLyrics/g));
console.log('剩余引用  applyLyricsSettings:', count(/applyLyricsSettings/g));
console.log('剩余引用  createLyricsWindow:', count(/createLyricsWindow/g));
console.log('剩余引用  lyricsWin::', count(/lyricsWin:/g));
