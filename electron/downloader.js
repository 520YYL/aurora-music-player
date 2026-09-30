'use strict';
/**
 * 极光音乐 —— 在线歌曲下载（纯 Node 逻辑，不依赖 electron，方便单跑验证）
 *
 * 只做两件事：把一条已经解析好的音频直链抓下来写进文件、把进度回报给调用方。
 * 「直链从哪来」（QQ音乐 / 酷狗 / 网易云 / 哔哩哔哩）由 aggregator / online 负责。
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const DL_EXTS = ['.mp3', '.m4a', '.mp4', '.flac', '.aac', '.ogg', '.oga', '.opus', '.webm', '.wav'];

/** 文件名里不能出现的字符换成下划线（Windows 上 \\ / : * ? " < > | 都不允许） */
function safeFileName(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 110);
}

function extFromType(type, fallback) {
  const t = String(type || '').toLowerCase();
  if (t.includes('audio/mp4') || t.includes('audio/x-m4a') || t.includes('video/mp4')) return '.m4a';
  if (t.includes('audio/mpeg')) return '.mp3';
  if (t.includes('audio/flac') || t.includes('audio/x-flac')) return '.flac';
  if (t.includes('audio/aac')) return '.aac';
  if (t.includes('audio/ogg')) return '.ogg';
  if (t.includes('audio/opus')) return '.opus';
  if (t.includes('audio/webm')) return '.webm';
  if (t.includes('audio/wav') || t.includes('audio/x-wav')) return '.wav';
  return fallback;
}

function extFromUrl(url, via) {
  try {
    const m = new URL(url).pathname.toLowerCase().match(/\.[a-z0-9]{2,4}$/);
    if (m && DL_EXTS.includes(m[0])) return m[0];
  } catch { /* 直链不是标准 URL 时忽略 */ }
  // 哔哩哔哩的 dash 音频是 MP4/AAC 容器但没有扩展名
  return via === 'bilibili' ? '.m4a' : '.mp3';
}

/** 同名文件不覆盖，往后排 (2) (3)… */
function uniqueFilePath(dir, base, ext) {
  let p = path.join(dir, base + ext);
  for (let i = 2; fs.existsSync(p) && i < 300; i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}

/**
 * 抓一条直链并落盘。
 * @param {{url: string, headers?: object, via?: string}} target
 * @param {{title?: string, artist?: string, name?: string, videoId?: string}} meta
 * @param {string} dir           目标目录（不存在会创建）
 * @param {(got: number, total: number) => void} [onProgress]
 * @returns {Promise<{ok: true, path: string, size: number, dir: string, ext: string}>}
 */
async function downloadToFile(target, meta, dir, onProgress) {
  if (!target || !target.url) throw new Error('拿不到音频直链');
  const m = meta || {};

  const res = await fetch(target.url, { headers: target.headers || {}, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error('拿不到音频数据（上游 HTTP ' + res.status + '）');

  await fsp.mkdir(dir, { recursive: true });

  const base = safeFileName(`${m.artist ? m.artist + ' - ' : ''}${m.title || m.name || ''}`)
    || `online-${String(m.videoId || 'track').slice(0, 12)}`;
  const ext = extFromType(res.headers.get('content-type'), extFromUrl(target.url, target.via));
  const file = uniqueFilePath(dir, base, ext);
  const total = Number(res.headers.get('content-length')) || 0;

  const out = fs.createWriteStream(file);
  const reader = res.body.getReader();
  let got = 0;
  let tick = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      got += buf.length;
      if (!out.write(buf)) await new Promise((r) => out.once('drain', r));
      const now = Date.now();
      if (onProgress && now - tick > 200) { tick = now; onProgress(got, total); }
    }
    await new Promise((resolve, reject) => { out.end((err) => (err ? reject(err) : resolve())); });
  } catch (err) {
    try { out.destroy(); } catch { /* ignore */ }
    try { await fsp.unlink(file); } catch { /* ignore */ }   // 半截文件不留
    throw err;
  }

  return { ok: true, path: file, size: got, dir, ext };
}

module.exports = { downloadToFile, safeFileName, extFromType, extFromUrl, uniqueFilePath, DL_EXTS };
