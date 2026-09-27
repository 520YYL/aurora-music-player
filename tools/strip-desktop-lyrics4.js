'use strict';
/**
 * 第四步清理：删掉设置面板里的「桌面歌词」整段，以及导航项与快捷键标签
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const f = path.join(ROOT, 'src', 'js', 'panels.js');
let s = fs.readFileSync(f, 'utf8');
const before = s.length;

function cutRange(startAnchor, endAnchor, keepEnd = true) {
  const i = s.indexOf(startAnchor);
  if (i < 0) throw new Error('起始锚点未找到: ' + startAnchor.slice(0, 70));
  const j = s.indexOf(endAnchor, i);
  if (j < 0) throw new Error('结束锚点未找到: ' + endAnchor.slice(0, 70));
  s = s.slice(0, i) + (keepEnd ? s.slice(j) : s.slice(j + endAnchor.length));
}

// ① 删掉 secL 的所有 appendChild 到 sections.appendChild(secL);
cutRange(
  "    secL.appendChild(setRow('开启桌面歌词'",
  '    sections.appendChild(secL);\n',
  false
);

// ② 删掉重复出现的「播放与过渡」注释与 P 声明（原本在 secL 之后那一份保留，把前面误留的删掉）
const dup = "    /* ---------- 播放与过渡 ---------- */\n    const P = s.playback;\n    secL.appendChild";
if (s.includes(dup)) {
  s = s.replace(dup, '    /* ---------- 播放与过渡 ---------- */\n    const P = s.playback;\n    secL.appendChild');
}

// ③ 设置导航里的「桌面歌词」入口
s = s.replace("['lyrics', '🎤 桌面歌词'], ", '');

// ④ 快捷键标签中的桌面歌词
s = s.replace("toggleDesktopLyrics: '开关桌面歌词', ", '');

fs.writeFileSync(f, s);
const count = (re) => (s.match(re) || []).length;
console.log(`panels.js: ${before} -> ${s.length} 字节`);
console.log('  剩余 secL:', count(/secL/g));
console.log('  剩余 L\\.:', count(/\bL\./g));
console.log('  剩余 桌面歌词:', count(/桌面歌词/g));
console.log('  剩余 pickLyricsMonitor:', count(/pickLyricsMonitor/g));
console.log('  剩余 const P = s.playback 出现次数:', count(/const P = s\.playback/g));
