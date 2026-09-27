'use strict';
/**
 * 第三步清理：渲染进程里移除桌面歌词相关代码
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const f = path.join(ROOT, 'src', 'js', 'app.js');
let s = fs.readFileSync(f, 'utf8');
const before = s.length;

function must(needle) { if (!s.includes(needle)) throw new Error('锚点未找到: ' + needle.slice(0, 80)); }
function cutRange(startAnchor, endAnchor) {
  must(startAnchor);
  const i = s.indexOf(startAnchor);
  const j = s.indexOf(endAnchor, i);
  if (j < 0) throw new Error('结束锚点未找到: ' + endAnchor.slice(0, 80));
  s = s.slice(0, i) + s.slice(j);
}
function replaceOnce(a, b) { must(a); s = s.replace(a, b); }

// 1) 播放栏按钮
replaceOnce("    $('#btnDesktopLyrics').onclick = () => App.setDesktopLyrics(!App.settings.lyrics.desktopEnabled);\n", '');
replaceOnce("    $('#btnDesktopLyrics').classList.toggle('fav-on', !!App.settings.lyrics.desktopEnabled);\n", '');

// 2) syncOverlays：只保留迷你播放器
replaceOnce('  function syncOverlays(full) {', '  function syncOverlays() {');
replaceOnce('      settings: { lyrics: App.settings.lyrics, mini: App.settings.mini },', '      settings: { mini: App.settings.mini },');
replaceOnce('    api.player.syncLyrics(payload).catch(() => {});\n', '');

// 3) 三个桌面歌词相关方法
cutRange('  App.setDesktopLyrics = async function (on) {', '  /* ================================ 浮动可视化面板 ================================ */');

// 4) 快捷键动作
replaceOnce("      case 'toggleDesktopLyrics': App.setDesktopLyrics(!App.settings.lyrics.desktopEnabled); break;\n", '');

// 5) 事件监听
replaceOnce("    api.on('lyrics:settings', () => { /* 桌面歌词窗口自行处理 */ });\n", '');

// 6) 卡拉OK 判断改为使用固定默认值（该设置随浮层一起移除）
replaceOnce(
  "el.classList.toggle('karaoke', i === App.lyrics.current && App.settings.lyrics.karaoke);",
  "el.classList.toggle('karaoke', i === App.lyrics.current && App.settings.lyrics.karaoke !== false);"
);

// 7) 调用点统一去掉参数
s = s.replace(/syncOverlays\(true\)/g, 'syncOverlays()').replace(/syncOverlays\(false\)/g, 'syncOverlays()');

fs.writeFileSync(f, s);
const count = (re) => (s.match(re) || []).length;
console.log(`app.js: ${before} -> ${s.length} 字节`);
for (const [label, re] of [['DesktopLyrics', /DesktopLyrics/g], ['setDesktopLyrics', /setDesktopLyrics/g], ['lockLyrics', /lockLyrics/g], ['pickLyricsMonitor', /pickLyricsMonitor/g], ['syncLyrics', /syncLyrics/g], ['lyricsWin', /lyricsWin/g]]) {
  console.log(`  剩余 ${label}:`, count(re));
}
