'use strict';
/**
 * 第二步清理：删掉截图模式与自检里的「桌面歌词浮层」段落
 * （自检里保留迷你播放器窗口的验证）
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const f = path.join(ROOT, 'electron', 'main.js');
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

// ① 截图模式里的桌面歌词部分（保留前面的曲库/设置/均衡器截图）
cutRange('  // 桌面歌词浮层：分别放在深色与浅色背景上截图，便于判断可读性', '  report.finishedAt = new Date().toISOString();');

// ② 自检里的桌面歌词验证段（整段 try 的前半部分），保留迷你播放器验证
cutRange('        // 先让一首有歌词的歌在播放', "        // 迷你播放器也用全新窗口验证（它同样依赖这条同步消息）");

// ③ 自检里针对桌面歌词的断言
cutRange('        // 断言：全新的桌面歌词窗口必须显示当前歌词，绝不能是「暂无歌词」', '        const mr = smoke.miniWindow.render;');

// ④ 截图模式注释里提到桌面歌词
s = s.replace('/* 截图模式： --shots  把正在播放页 / 桌面歌词 / 曲库 存成 PNG 便于检查     */', '/* 截图模式： --shots  把正在播放页 / 曲库 / 设置 / 均衡器 存成 PNG 便于检查  */');
// ⑤ 注释
s = s.replace('  // 迷你播放器 / 桌面歌词发来的播放控制命令', '  // 迷你播放器发来的播放控制命令');

fs.writeFileSync(f, s);
const count = (re) => (s.match(re) || []).length;
console.log(`main.js: ${before} -> ${s.length} 字节`);
console.log('剩余 lyricsWindow:', count(/lyricsWindow/g));
console.log('剩余 toggleDesktopLyrics:', count(/toggleDesktopLyrics/g));
console.log('剩余 桌面歌词:', count(/桌面歌词/g));
