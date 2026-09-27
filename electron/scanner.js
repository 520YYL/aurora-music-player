'use strict';
/**
 * 极光音乐 —— 曲库扫描 / 音频元数据解析
 * 支持 mp3 / ogg / m4a / flac / wav / aac / opus 等。
 * 优先使用 music-metadata 读取标签与封面；不可用时回退到文件名解析。
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const AUDIO_EXTS = new Set(['.mp3', '.ogg', '.oga', '.m4a', '.m4b', '.mp4', '.flac', '.wav', '.aac', '.opus', '.weba', '.webm', '.aiff', '.aif', '.wma']);
const SKIP_DIRS = new Set(['node_modules', '$recycle.bin', 'system volume information', '.git', 'windows', 'appdata', 'program files', 'program files (x86)', 'programdata', 'music_cache', 'cache']);

function trackId(filePath) {
  return crypto.createHash('sha1').update(String(filePath).toLowerCase()).digest('hex').slice(0, 16);
}

/**
 * 元数据缓存版本。解析规则发生变化时必须 +1，否则旧缓存里的错误结果会被继续沿用。
 * v2: 文件名回退解析由「歌手 - 歌名」改为「歌名 - 歌手」
 */
const META_VERSION = 2;

/**
 * 从文件名猜标题/歌手。
 * 采用最常见的「歌名 - 歌手」顺序（例如 "Refrain - 阿南亮子.mp3" → 歌名 Refrain，歌手 阿南亮子）。
 */
function parseNameFromFile(file) {
  const base = path.basename(file, path.extname(file));
  const m = base.split(/\s+-\s+/);
  if (m.length >= 2) {
    const title = m[0].trim();
    const artist = m.slice(1).join(' - ').trim();
    if (title) return { artist, title };
  }
  return { artist: '', title: base.trim() };
}

/** 递归扫描目录，返回音频文件绝对路径列表 */
async function scanFolders(roots, opts = {}) {
  const out = [];
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const maxDepth = opts.maxDepth || 24;
  const seen = new Set();

  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        const low = ent.name.toLowerCase();
        if (SKIP_DIRS.has(low)) continue;
        if (ent.name.startsWith('$') || ent.name.startsWith('.')) continue;
        await walk(full, depth + 1);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (!AUDIO_EXTS.has(ext)) continue;
        const key = full.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(full);
        if (out.length % 25 === 0) onProgress({ found: out.length, current: full });
      }
    }
  }

  for (const r of roots) {
    if (!r) continue;
    try {
      const st = await fsp.stat(r);
      if (st.isDirectory()) await walk(r, 0);
      else if (st.isFile() && AUDIO_EXTS.has(path.extname(r).toLowerCase())) out.push(r);
    } catch { /* 路径不存在，忽略 */ }
  }
  onProgress({ found: out.length, done: true });
  return out;
}

/** 载入 music-metadata（ESM，动态导入） */
let mmModule = null;
let mmTried = false;
async function getMM() {
  if (mmTried) return mmModule;
  mmTried = true;
  try {
    mmModule = await import('music-metadata');
  } catch (err) {
    mmModule = null;
  }
  return mmModule;
}

const EXT_MIME = {
  // 音频
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4', '.m4b': 'audio/mp4', '.mp4': 'audio/mp4', '.aac': 'audio/aac',
  '.flac': 'audio/flac', '.wav': 'audio/wav', '.weba': 'audio/webm', '.webm': 'audio/webm',
  '.aiff': 'audio/aiff', '.aif': 'audio/aiff', '.wma': 'audio/x-ms-wma',
  // 界面资源（aurora:// 协议也用同一张表）
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.lrc': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.ico': 'image/x-icon', '.wasm': 'application/wasm',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf'
};

function mimeFor(file) { return EXT_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'; }

/** 猜测比特率（当解析器不可用时根据文件大小和时长估算） */
function guessBitrate(size, duration) {
  if (!duration || !size) return 0;
  return Math.round((size * 8) / duration / 1000);
}

/**
 * 解析单个文件的元数据。
 * 返回 { id, path, ... , picture: {data:Buffer,format:string}|null }
 */
async function readMetadata(file, onCover) {
  const st = await fsp.stat(file).catch(() => null);
  const ext = path.extname(file).toLowerCase();
  const fallback = parseNameFromFile(file);
  const base = {
    id: trackId(file),
    path: file,
    name: path.basename(file),
    ext,
    format: ext.replace('.', '').toUpperCase(),
    size: st ? st.size : 0,
    mtime: st ? Math.round(st.mtimeMs) : 0,
    title: fallback.title,
    artist: fallback.artist,
    album: '',
    albumArtist: '',
    genre: '',
    year: null,
    trackNo: null,
    disc: null,
    duration: 0,
    bitrate: 0,
    sampleRate: 0,
    channels: 0,
    codec: '',
    lossless: ['.flac', '.wav', '.aiff', '.aif'].includes(ext),
    hasCover: false,
    hasLyricsTag: false,
    addedAt: Date.now(),
    playCount: 0,
    playedMs: 0,
    lastPlayedAt: 0,
    rating: 0,
    favorite: false
  };

  const mm = await getMM();
  if (mm && typeof mm.parseFile === 'function') {
    try {
      const meta = await mm.parseFile(file, { duration: true, skipCovers: false });
      const c = meta.common || {};
      const f = meta.format || {};
      if (c.title) base.title = String(c.title).trim();
      if (c.artist) base.artist = String(c.artist).trim();
      if (c.album) base.album = String(c.album).trim();
      if (c.albumartist) base.albumArtist = String(c.albumartist).trim();
      if (Array.isArray(c.genre) && c.genre.length) base.genre = c.genre.join(' / ');
      else if (typeof c.genre === 'string') base.genre = c.genre;
      if (c.year) base.year = Number(c.year) || null;
      if (c.track && c.track.no) base.trackNo = Number(c.track.no);
      if (c.disk && c.disk.no) base.disc = Number(c.disk.no);
      if (f.duration) base.duration = Math.round(f.duration * 1000);
      if (f.bitrate) base.bitrate = Math.round(f.bitrate);
      if (f.sampleRate) base.sampleRate = f.sampleRate;
      if (f.numberOfChannels) base.channels = f.numberOfChannels;
      if (f.codec) base.codec = String(f.codec);
      if (f.lossless !== undefined) base.lossless = !!f.lossless;
      if (Array.isArray(c.picture) && c.picture.length && typeof onCover === 'function') {
        const pic = c.picture[0];
        if (pic && pic.data) {
          base.hasCover = true;
          onCover(base.id, Buffer.from(pic.data), pic.format || 'image/jpeg');
        }
      } else if (Array.isArray(c.picture) && c.picture.length) {
        base.hasCover = true;
      }
      // 内嵌歌词（ID3 USLT / Vorbis LYRICS）
      const lyr = c.lyrics;
      if (lyr) {
        const text = Array.isArray(lyr)
          ? lyr.map((x) => (typeof x === 'string' ? x : (x && (x.text || x.lyrics)) || '')).join('\n')
          : (typeof lyr === 'string' ? lyr : (lyr.text || lyr.lyrics || ''));
        if (text && String(text).trim()) {
          base.hasLyricsTag = true;
          base.embeddedLyrics = String(text);
        }
      }
    } catch { /* 解析失败则使用回退信息 */ }
  }

  if (!base.duration && base.bitrate && base.size && base.bitrate > 8) {
    base.duration = Math.round((base.size * 8) / base.bitrate);
  }
  if (!base.bitrate) base.bitrate = guessBitrate(base.size, base.duration / 1000);

  // 封面兜底：同目录下的 cover.jpg / folder.jpg / <同名>.jpg
  if (!base.hasCover) {
    const dir = path.dirname(file);
    const stem = path.basename(file, ext);
    const candidates = [stem + '.jpg', stem + '.png', 'cover.jpg', 'folder.jpg', 'front.jpg', 'album.jpg', 'Cover.jpg'];
    for (const cname of candidates) {
      const p = path.join(dir, cname);
      try {
        const st2 = await fsp.stat(p);
        if (st2.isFile() && st2.size > 512 && st2.size < 12 * 1024 * 1024) {
          base.hasCover = true;
          if (typeof onCover === 'function') {
            const buf = await fsp.readFile(p);
            onCover(base.id, buf, cname.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg');
          }
          break;
        }
      } catch { /* ignore */ }
    }
  }

  return base;
}

module.exports = { scanFolders, readMetadata, trackId, mimeFor, AUDIO_EXTS, EXT_MIME, parseNameFromFile, getMM, META_VERSION };
