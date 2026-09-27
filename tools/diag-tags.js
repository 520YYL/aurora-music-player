'use strict';
/**
 * 诊断：对比「文件名」与「ID3 标签」里的标题/歌手，判断是不是标签本身反了。
 */
const fs = require('node:fs');
const path = require('node:path');

const DIR = process.argv[2] || 'C:\\Users\\Administrator\\Music\\音乐';

function parseNameFromFile(file) {
  const base = path.basename(file, path.extname(file));
  const m = base.split(/\s+-\s+/);
  if (m.length >= 2) return { first: m[0].trim(), second: m.slice(1).join(' - ').trim() };
  return { first: '', second: base.trim() };
}

(async () => {
  const mm = await import('music-metadata');
  const files = fs.readdirSync(DIR).filter((f) => /\.(mp3|ogg|m4a|flac|wav|aac)$/i.test(f));
  console.log('文件数:', files.length);
  console.log('');
  console.log('文件名第一段 | 文件名第二段 || 标签title | 标签artist || 判断');
  console.log('-'.repeat(120));
  let swapped = 0;
  let ok = 0;
  let noTag = 0;
  for (const f of files) {
    const full = path.join(DIR, f);
    const { first, second } = parseNameFromFile(f);
    let title = '';
    let artist = '';
    try {
      const meta = await mm.parseFile(full, { duration: false });
      title = (meta.common.title || '').trim();
      artist = (meta.common.artist || '').trim();
    } catch (e) { /* ignore */ }
    let verdict;
    if (!title && !artist) { verdict = '无标签'; noTag++; }
    else if (title === first && artist === second) { verdict = '★ 标签与文件名「反」了（title=前段）'; swapped++; }
    else if (title === second && artist === first) { verdict = '正常（title=后段, artist=前段）'; ok++; }
    else { verdict = '不一致/其它'; }
    console.log(`${first}\n  | ${second}\n  || title="${title}"  artist="${artist}"\n  || ${verdict}`);
    console.log('');
  }
  console.log('='.repeat(60));
  console.log(`标签反了: ${swapped}   正常: ${ok}   无标签: ${noTag}`);
})();
