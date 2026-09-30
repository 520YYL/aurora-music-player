'use strict';
/**
 * 极光音乐 —— 在线歌词
 *
 * 本地曲目走 lyrics-finder.js（找同名 .lrc 等），在线曲目没有本地文件，
 * 这里按音源各自的公开接口取一次歌词：
 *   - 网易云：music.163.com/api/song/lyric                 —— 直接给 LRC，还带翻译（tlyric）
 *   - QQ音乐：c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg —— 直接给 LRC + trans 翻译
 *   - 酷狗  ：krcs.kugou.com/search 找 id/accesskey
 *             → lyrics.kugou.com/download 拿 base64 编码的 LRC
 *
 * 各自拿不到时统一退到「酷狗按 歌手 - 歌名 搜歌词」——krcs 不带 hash 也能搜，
 * 实测「周杰伦 - 晴天」「林俊杰 - 江南」首条就是正主，是很好的通用兜底。
 *
 * 哔哩哔哩不取歌词：那里都是 UP 主投稿，没有可靠的歌词来源（用户也明确说除了 B 站）。
 *
 * 取到的歌词只在内存里缓存（LRU + 并发合并），**不往磁盘写文件**，
 * 免得自动生成的一堆 .lrc 污染用户的歌词目录、「导入歌词」面板。
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const TIMEOUT_MS = 8000;
const CACHE_MAX = 150;

/** key -> { text, label }；key 为 `${source}:${videoId}` */
const cache = new Map();
/** key -> Promise，避免同一首歌并发重复请求 */
const inflight = new Map();

const SOURCE_NAMES = { qq: 'QQ音乐', kugou: '酷狗音乐', netease: '网易云音乐' };

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

async function fetchText(url, headers = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9', ...headers }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, headers = {}) {
  const raw = await fetchText(url, headers);
  try { return JSON.parse(raw); } catch { return null; }
}

/** 有没有 [mm:ss] 时间轴，用来判断「这段到底是不是 LRC」 */
function looksLrc(s) { return /\[\d{1,3}:\d{1,2}/.test(String(s || '')); }

/** QQ 偶尔无视 nobase64 返回 base64，这里兜一下 */
function maybeBase64(s) {
  const v = String(s || '').trim();
  if (!v || looksLrc(v)) return v;
  if (/^[A-Za-z0-9+/=\s]+$/.test(v)) {
    try {
      const d = Buffer.from(v, 'base64').toString('utf8');
      if (looksLrc(d)) return d;
    } catch { /* 不是 base64 就算了 */ }
  }
  return v;
}

function normalize(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, '').replace(/[_\-—–·.,'"()\[\]（）【】]/g, '');
}

/**
 * 各平台的 LRC 开头都爱塞点非歌词的东西：
 *   - 酷狗 / QQ：`[00:00.00]晴天 - 周杰伦 (Jay Chou)` 这种标题行，再来「词：/曲：」
 *   - 网易云：一整块制作名单（作词 / 作曲 / 编曲 / 吉他 / 贝斯 / 混音 …）
 * 这些在时间轴上都挤在前几秒，不处理的话歌词第一屏全是制作信息。
 * 这里只在**开头**连续剔除（最多 14 行），碰到第一行真正的歌词就停手，
 * 所以不会误删正文；而且只作用于在线歌词，本地 .lrc 的解析逻辑一点没动。
 */
const META_LINE_RE = /^\[[a-z_]{1,12}:/i;
const CREDIT_LINE_RE = /^\[[\d:.]+\]\s*(作词|作曲|编曲|填词|制作|出品|监制|混音|母带|录音|和声|合声|配唱|吉他|贝斯|鼓|键盘|弦乐|人声|策划|统筹|企划|封面|设计|发行|推广|翻译|上传|鸣谢|感谢|OP|SP|词|曲|Composed|Lyrics?|Music|Arranged|Produced|Written|Mixed|Mastered|Recorded|Performed|Vocals?|Publisher|Label|Copyright)[^\[\]]{0,12}[:：]/i;
/** 「标签：内容」形状（合声编写：周杰伦 / 录音助理：刘勇志 / Composed by：Taylor Swift…），标签很短、整行也短 */
const LABEL_COLON_RE = /^[^:：]{1,14}[:：]\s*\S/;

function stripLeadingJunk(lrc, track) {
  const lines = String(lrc || '').replace(/\r/g, '').split('\n');
  const titleN = normalize(track && track.title);
  let i = 0;
  let dropped = 0;
  while (i < lines.length && i < 32 && dropped < 20) {
    const t = lines[i].trim();
    if (!t || META_LINE_RE.test(t)) { i++; continue; }                 // 空行 / 元信息行直接跳过
    const body = t.replace(/^\[[\d:.]+\]\s*/, '');
    const isTitleLine = body.includes(' - ') && /[-–—]/.test(body) && body.length <= 60
      && (!titleN || normalize(body).includes(titleN));
    const isCredit = CREDIT_LINE_RE.test(t) || (LABEL_COLON_RE.test(body) && body.length <= 34);
    if (isTitleLine || isCredit) { dropped++; i++; continue; }
    break;
  }
  return lines.slice(i).join('\n');
}

/**
 * 把译文 LRC 拼在原文后面：两边时间轴一致，渲染层的 parseLrc 会把同时间戳的两行
 * 合并成「原文 + 译文」的双语显示，所以这里只要按顺序接上就行。
 */
function combine(main, trans, label) {
  const base = String(main || '').replace(/\r/g, '').trim();
  if (!base) return null;
  const t = String(trans || '').replace(/\r/g, '').trim();
  const text = (t && looksLrc(t) && !base.includes(t)) ? `${base}\n${t}` : base;
  return { text, label };
}

/* ------------------------------------------------------------------ */
/* 各音源                                                              */
/* ------------------------------------------------------------------ */

/** 网易云：官方歌词接口，LRC + tlyric 翻译 */
async function fromNetease(track) {
  const id = String(track.videoId || '');
  if (!/^\d+$/.test(id)) return null;
  const j = await fetchJson(`https://music.163.com/api/song/lyric?id=${id}&lv=1&kv=1&tv=-1`,
    { Referer: 'https://music.163.com/' });
  if (!j) return null;
  const lrc = (j.lrc && j.lrc.lyric) || '';
  const tr = (j.tlyric && j.tlyric.lyric) || '';
  return combine(lrc, tr, SOURCE_NAMES.netease);
}

/** QQ 音乐：官方歌词接口，靠 songmid，LRC + trans 翻译 */
async function fromQQ(track) {
  const mid = String(track.videoId || '');
  if (!/^[A-Za-z0-9]{10,20}$/.test(mid)) return null;
  const j = await fetchJson(
    `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${encodeURIComponent(mid)}&format=json&nobase64=1&g_tk=5381`,
    { Referer: 'https://y.qq.com/portal/player.html' });
  if (!j) return null;
  return combine(maybeBase64(j.lyric), maybeBase64(j.trans), SOURCE_NAMES.qq);
}

/**
 * 酷狗：先 krcs 找歌词 id + accesskey，再 download 拿 base64 LRC。
 *
 * **一定要带上真实时长**：同一首歌在 krcs 里有一堆候选，不带 duration 时排在最前的
 * 往往只是 30~35 秒的铃声片段（只有 7~9 行）；带上之后首条就是时长对得上的完整版
 * （实测「晴天」269s → 64 行、「稻香」223s → 71 行、「江南」268s → 56 行）。
 * 所以除了 `duration=` 参数，这里再用时长邻近度补一刀，防酷狗自己的排序抽风。
 */
async function fromKugouRaw(keyword, hash, durationMs) {
  const kw = String(keyword || '').trim();
  if (!kw) return null;
  const dur = Number(durationMs) > 0 ? Math.round(Number(durationMs)) : 0;
  let qs = `ver=1&man=yes&client=mobi&keyword=${encodeURIComponent(kw)}`;
  if (hash && /^[A-Za-z0-9]{16,40}$/.test(hash)) qs += `&hash=${hash}`;
  if (dur > 0) qs += `&duration=${dur}`;

  const s = await fetchJson(`https://krcs.kugou.com/search?${qs}`);
  const list = (s && Array.isArray(s.candidates)) ? s.candidates.filter((c) => c && c.id && c.accesskey) : [];
  if (!list.length) return null;

  // 关键词搜索会给一堆候选，尽量挑和这首歌对得上的那条
  const wantTitle = normalize(String(kw).split(' - ').pop());
  const wantArtist = normalize(String(kw).split(' - ')[0]);
  const score = (c) => {
    let n = 0;
    const cTitle = normalize(c.song);
    const cArtist = normalize(c.singer);
    if (cTitle && wantTitle && cTitle === wantTitle) n += 2;
    else if (cTitle && wantTitle && (cTitle.includes(wantTitle) || wantTitle.includes(cTitle))) n += 1;
    if (cArtist && wantArtist && cArtist.includes(wantArtist)) n += 1;
    if (dur > 0) {
      const diff = Math.abs(Number(c.duration || 0) - dur);
      if (diff <= 3000) n += 3;
      else if (diff <= 10000) n += 2;
      else if (diff <= 30000) n += 1;
      else n -= 1; // 时长差太远，多半是铃声 / 片段
    }
    if (c.score) n += Math.min(1, Number(c.score) / 100);
    return n;
  };
  const best = list.slice().sort((a, b) => score(b) - score(a))[0];

  const d = await fetchJson(`https://lyrics.kugou.com/download?ver=1&client=pc&id=${best.id}&accesskey=${encodeURIComponent(best.accesskey)}&fmt=lrc&charset=utf8`);
  if (!d || !d.content) return null;
  let text = '';
  try { text = Buffer.from(String(d.content), 'base64').toString('utf8'); } catch { return null; }
  return looksLrc(text) ? { text, label: SOURCE_NAMES.kugou } : null;
}

function fromKugou(track) {
  return fromKugouRaw(
    `${track.artist || ''} - ${track.title || ''}`.trim(),
    String(track.videoId || ''),
    Number(track.duration) || 0
  );
}

/* ------------------------------------------------------------------ */
/* 对外入口                                                            */
/* ------------------------------------------------------------------ */

function cacheGet(key) {
  if (!cache.has(key)) return undefined;
  const v = cache.get(key);
  cache.delete(key);
  cache.set(key, v); // 刷新 LRU 顺序
  return v;
}

function cacheSet(key, val) {
  cache.set(key, val);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

/**
 * 取一首在线曲目的歌词
 * @param {{source?:string, videoId?:string, title?:string, artist?:string, duration?:number}} track
 * @param {boolean} [force] 绕过缓存重试（界面上「查找歌词」按钮用）
 * @returns {Promise<{text:string, label:string}|null>}
 */
async function fetchLyrics(track, force) {
  const source = String((track && track.source) || '');
  const videoId = String((track && track.videoId) || '');
  // 哔哩哔哩没有可靠的歌词来源，本地曲目也不该走到这里
  if (!track || !source || source === 'bilibili' || !track.title) return null;

  const key = `${source}:${videoId || `${track.artist || ''}-${track.title}`}`;
  if (force) {
    cache.delete(key);
  } else {
    const hit = cacheGet(key);
    if (hit !== undefined) return hit;
    if (inflight.has(key)) return inflight.get(key);
  }

  const job = (async () => {
    const own = { qq: fromQQ, kugou: fromKugou, netease: fromNetease }[source];
    try { if (own) { const r = await own(track); if (r) return r; } } catch { /* 换兜底 */ }
    try {
      // 通用兜底：酷狗按「歌手 - 歌名 + 真实时长」搜歌词
      // （不含 B 站，它本来就不是音乐平台）
      return await fromKugouRaw(
        `${track.artist || ''} - ${track.title || ''}`.trim(),
        '',
        Number(track.duration) || 0
      );
    } catch { return null; }
  })();

  inflight.set(key, job);
  try {
    const res = await job;
    if (res && res.text) res.text = stripLeadingJunk(res.text, track);
    cacheSet(key, res);
    return res;
  } finally {
    inflight.delete(key);
  }
}

module.exports = { fetchLyrics, SOURCE_NAMES };
