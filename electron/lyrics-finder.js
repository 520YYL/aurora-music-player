'use strict';
/**
 * 极光音乐 —— 歌词查找
 * 支持：同名 .lrc / 同目录 lyrics|歌词 子目录 / 父目录歌词目录 / 曲库根目录歌词目录 / 用户歌词缓存目录。
 * 文件编码在渲染进程用 TextDecoder 处理（UTF-8 优先，自动回退 GBK/GB18030），以兼容中文歌词文件。
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const LYRICS_DIR_NAMES = ['歌词', 'lyrics', 'Lyrics', 'LYRICS', 'lrc', 'LRC', '.lyrics'];
const LRC_EXTS = ['.lrc', '.LRC', '.txt'];

function normalize(name) {
  return String(name || '').toLowerCase().replace(/\s+/g, '').replace(/[_\-—–·.,'"()\[\]]/g, '');
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

async function readAsBase64(file) {
  const buf = await fsp.readFile(file);
  return { path: file, base64: buf.toString('base64'), size: buf.length };
}

/**
 * 查找歌词文件
 * @param {object} track 曲目对象（需要 path/title/artist/name）
 * @param {string[]} roots 曲库根目录，用于扩大搜索
 * @param {string} cacheDir 应用歌词缓存目录
 */
async function findLyrics(track, roots = [], cacheDir = null) {
  const file = track && track.path ? track.path : null;
  if (!file) return null;
  const dir = path.dirname(file);
  const stem = path.basename(file, path.extname(file));
  const targets = new Set();
  const addTarget = (d, n) => { if (d && n) targets.add(path.join(d, n)); };

  for (const ext of LRC_EXTS) addTarget(dir, stem + ext);
  for (const sub of LYRICS_DIR_NAMES) {
    for (const ext of LRC_EXTS) addTarget(path.join(dir, sub), stem + ext);
  }
  const parent = path.dirname(dir);
  if (parent && parent !== dir) {
    for (const sub of LYRICS_DIR_NAMES) {
      for (const ext of LRC_EXTS) addTarget(path.join(parent, sub), stem + ext);
    }
    for (const ext of LRC_EXTS) addTarget(parent, stem + ext);
  }
  for (const r of roots) {
    for (const sub of LYRICS_DIR_NAMES) {
      for (const ext of LRC_EXTS) addTarget(path.join(r, sub), stem + ext);
    }
  }
  if (cacheDir) {
    for (const ext of LRC_EXTS) {
      addTarget(cacheDir, stem + ext);
      if (track.artist) addTarget(cacheDir, `${track.artist} - ${track.title}${ext}`);
    }
  }

  for (const t of targets) {
    if (await exists(t)) {
      try {
        const st = await fsp.stat(t);
        if (st.size > 0) return await readAsBase64(t);
      } catch { /* continue */ }
    }
  }

  // 模糊匹配：在歌词目录中按“标题+歌手”规范化后查找
  const wanted = new Set([normalize(stem), normalize(track.title), normalize(`${track.artist}${track.title}`), normalize(`${track.title}${track.artist}`)]);
  const searchDirs = new Set();
  for (const sub of LYRICS_DIR_NAMES) searchDirs.add(path.join(dir, sub));
  if (parent && parent !== dir) for (const sub of LYRICS_DIR_NAMES) searchDirs.add(path.join(parent, sub));
  for (const r of roots) for (const sub of LYRICS_DIR_NAMES) searchDirs.add(path.join(r, sub));
  if (cacheDir) searchDirs.add(cacheDir);

  for (const d of searchDirs) {
    let entries;
    try { entries = await fsp.readdir(d); } catch { continue; }
    for (const name of entries) {
      const ext = path.extname(name).toLowerCase();
      if (!LRC_EXTS.map((e) => e.toLowerCase()).includes(ext)) continue;
      const n = normalize(path.basename(name, path.extname(name)));
      if (wanted.has(n)) return await readAsBase64(path.join(d, name));
    }
  }

  // 内嵌歌词
  if (track.embeddedLyrics && String(track.embeddedLyrics).trim()) {
    return { path: null, embedded: true, text: String(track.embeddedLyrics) };
  }
  return null;
}

module.exports = { findLyrics, LYRICS_DIR_NAMES };
