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
 * 实测「周杰伦 - 晴天」「林俊杰 - 江南」首条就是正主，是很好的通用兜底；
 * 再不行就「网易云按 歌名(+歌手) 搜同名歌」。
 *
 * 哔哩哔哩：CC 字幕匿名拿不到（/x/player/v2 的 data.subtitle.subtitles 实测恒为空数组），
 * 所以走「清洗投稿标题 → 跨源匹配」——B 站的 artist 是 UP 主而不是歌手，
 * 因此匹配只认标题（相等 / 互相包含）+ 时长邻近，且时长容差放宽（投稿含前奏 / 片尾）。
 *
 * 翻译（中日 / 中英互译）：网易云的 tlyric 最全，QQ / 酷狗的日语歌基本不给译文，
 * 所以原文拿到后如果还没有双语，会再去网易云搜同一首歌，把 tlyric 按时间戳贴回原文行，
 * 时间戳相同 → 渲染层的 parseLrc 会把两行合并成「原文 + 译文」。
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

const SOURCE_NAMES = { qq: 'QQ音乐', kugou: '酷狗音乐', netease: '网易云音乐', bilibili: '哔哩哔哩' };

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

/** 有没有假名 —— 判断「这行是不是日语」 */
function hasKana(s) { return /[\u3040-\u30ff]/.test(String(s || '')); }
/** 有没有汉字 */
function hasHan(s) { return /[\u3400-\u9fff\uf900-\ufaff]/.test(String(s || '')); }

/** 这段 LRC 是不是已经有双语了（同一个时间戳出现了不止一行） */
function hasBilingual(text) {
  const seen = new Set();
  for (const raw of String(text || '').split('\n')) {
    const m = raw.match(/^\[(\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?)\]/);
    if (!m) continue;
    if (seen.has(m[1])) return true;
    seen.add(m[1]);
  }
  return false;
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
const CREDIT_LINE_RE = /^\[[\d:.]+\]\s*(作词|作曲|编曲|填词|制作|出品|监制|混音|母带|录音|和声|合声|配唱|吉他|贝斯|鼓|键盘|弦乐|人声|策划|统筹|企划|封面|设计|发行|推广|翻译|上传|鸣谢|感谢|OP|SP|词|曲|歌|演唱|演奏|Composed|Lyrics?|Music|Arranged|Produced|Written|Mixed|Mastered|Recorded|Performed|Vocals?|Publisher|Label|Copyright)[^\[\]]{0,12}[:：]/i;
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

/** `[mm:ss.xx]正文` → { stamp, sec, body } */
const TS_FULL_RE = /^(\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\])\s*/;
function tsParts(line) {
  const m = String(line).match(TS_FULL_RE);
  if (!m) return null;
  const frac = m[4] ? Number(`0.${m[4]}`) : 0;
  return { stamp: m[1], sec: Number(m[2]) * 60 + Number(m[3]) + frac, body: String(line).slice(m[0].length).trim() };
}

/* ------------------------------------------------------------------ */
/* 跨源匹配（B 站歌词 / 补翻译共用）                                    */
/* ------------------------------------------------------------------ */

/**
 * 候选打分：标题必须对得上（相等 +4 / 互相包含 +2），对不上一律 0 分淘汰；
 * 歌手命中 +2；时长邻近分档加分。
 * `loose` 给 B 站用 —— 投稿时长含前奏 / 片尾，容差要放宽。
 */
function matchScore(meta, cTitle, cArtist, cDur, opts) {
  const wantTitle = normalize(meta && meta.title);
  const t = normalize(cTitle);
  if (!wantTitle || !t) return 0;
  let n = 0;
  if (t === wantTitle) n += 4;
  else if (t.includes(wantTitle) || wantTitle.includes(t)) n += 2;
  else return 0;

  const wantArtist = normalize(String((meta && meta.artist) || '').split(/[\/、,，&]/)[0]);
  const a = normalize(cArtist);
  if (wantArtist && a && (a === wantArtist || a.includes(wantArtist) || wantArtist.includes(a))) n += 2;

  const d = Number(cDur) || 0;
  const want = Number(meta && meta.duration) || 0;
  if (d > 0 && want > 0) {
    const diff = Math.abs(d - want);
    const lv = (opts && opts.loose) ? [8000, 15000, 30000] : [3000, 10000, 30000];
    if (diff <= lv[0]) n += 3;
    else if (diff <= lv[1]) n += 2;
    else if (diff <= lv[2]) n += 1;
    else if (diff > 90000) n -= 2;   // 差太远，多半是铃声 / 片段 / 别的歌
  }
  return n;
}

/** B 站投稿标题里的噪声词（MV / 动态鼓谱 / 完整版 / 翻唱 …），猜歌名歌手时先剥掉 */
const BILI_NOISE = /(\bmv\b|\bpv\b|4k|8k|1080p|720p|60fps|高清|超清|修复|完整版|现场版|演唱会|无损|音质|\bhi-?res\b|官方|合集|合辑|循环|纯音乐|伴奏|翻唱|\bcover\b|翻调|动态鼓谱|鼓谱|简谱|吉他谱|钢琴|教学|字幕|双语|中字|中日|日文|罗马音|音译|\btv\s*size\b|\bver\b\.?|\blive\b|\bdemo\b|\bremix\b|\binst\b\.?|\bktv\b|片段|剪辑|混剪|搬运|转载|投稿)/gi;
const BILI_BRACKET = /[【\[（(]([^】\]）)]{1,40})[】\]）)]/g;

/**
 * 从投稿标题里猜「歌名」和「歌手」：
 *   「Lemon【米津玄師】动态鼓谱」 → { song: 'Lemon', artist: '米津玄師' }
 *   「周杰伦 - 晴天」             → { song: '晴天',  artist: '周杰伦' }
 *   「甩葱歌原版」                → { song: '甩葱歌原版', artist: '' }
 */
function biliParts(title) {
  const raw = String(title || '').trim();
  const tags = [];
  const core0 = raw.replace(BILI_BRACKET, (_m, inner) => { tags.push(String(inner).trim()); return ' '; })
    .replace(/[_|｜/]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const core = core0 || raw;

  let song = core;
  let artist = '';
  const dash = core.split(/\s*[-–—]\s*/).filter(Boolean);
  if (dash.length >= 2) { artist = dash[0]; song = dash.slice(1).join(' '); }
  if (!artist) {
    const t2 = tags.find((x) => x && !BILI_NOISE.test(x) && !/^\d+$/.test(x) && x.length <= 24);
    if (t2) artist = t2;
  }
  song = song.replace(BILI_NOISE, '').replace(/[【】\[\]（）()]/g, ' ').replace(/\s{2,}/g, ' ').trim() || core || raw;
  artist = artist.replace(BILI_NOISE, '').replace(/[【】\[\]（）()]/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return { song: song.trim(), artist: artist.trim() };
}

/** 网易云官方搜索 → 候选 [{id,title,artist,album,duration}] */
async function neteaseSearchCands(kw, limit) {
  const j = await fetchJson(
    `https://music.163.com/api/search/get/web?s=${encodeURIComponent(kw)}&type=1&limit=${Number(limit) || 8}&offset=0`,
    { Referer: 'https://music.163.com/' });
  const songs = (j && j.result && Array.isArray(j.result.songs)) ? j.result.songs : [];
  return songs.map((s) => ({
    id: String(s.id || ''),
    title: s.name || '',
    artist: (Array.isArray(s.artists) ? s.artists.map((a) => a && a.name).filter(Boolean).join(' / ') : ''),
    album: (s.album && s.album.name) || '',
    duration: Number(s.duration) || 0
  })).filter((x) => x.id);
}

/** 网易云歌词接口 → { lrc, trans } */
async function neteaseLyricById(id) {
  const j = await fetchJson(`https://music.163.com/api/song/lyric?id=${encodeURIComponent(id)}&lv=1&kv=1&tv=-1`,
    { Referer: 'https://music.163.com/' });
  if (!j) return null;
  return { lrc: (j.lrc && j.lrc.lyric) || '', trans: (j.tlyric && j.tlyric.lyric) || '' };
}

/** 按关键词去网易云找同一首歌并取歌词（打分不达阈值就不认） */
async function neteaseByKeyword(kw, meta, opts) {
  const min = (opts && opts.min) || 4;
  const cands = await neteaseSearchCands(kw, (opts && opts.limit) || 8);
  let best = null;
  let bestScore = 0;
  for (const c of cands) {
    const n = matchScore(meta, c.title, c.artist, c.duration, opts);
    if (n > bestScore) { bestScore = n; best = c; }
  }
  if (!best || bestScore < min) return null;
  const ly = await neteaseLyricById(best.id);
  if (!ly || !looksLrc(ly.lrc)) return null;
  const res = combine(ly.lrc, ly.trans, SOURCE_NAMES.netease);
  if (res) { res.kw = kw; res.score = bestScore; res.match = best; }
  return res;
}

/** 按关键词去酷狗 krcs 找同一首歌的歌词（打分不达阈值就不认） */
async function kugouByKeyword(kw, meta, opts) {
  const min = (opts && opts.min) || 4;
  const dur = Number(meta && meta.duration) || 0;
  let qs = `ver=1&man=yes&client=mobi&keyword=${encodeURIComponent(kw)}`;
  if (dur > 0) qs += `&duration=${Math.round(dur)}`;
  const s = await fetchJson(`https://krcs.kugou.com/search?${qs}`);
  const list = (s && Array.isArray(s.candidates)) ? s.candidates.filter((c) => c && c.id && c.accesskey) : [];
  let best = null;
  let bestScore = 0;
  for (const c of list) {
    const n = matchScore(meta, c.song, c.singer, c.duration, opts);
    if (n > bestScore) { bestScore = n; best = c; }
  }
  if (!best || bestScore < min) return null;
  const d = await fetchJson(`https://lyrics.kugou.com/download?ver=1&client=pc&id=${best.id}&accesskey=${encodeURIComponent(best.accesskey)}&fmt=lrc&charset=utf8`);
  if (!d || !d.content) return null;
  let text = '';
  try { text = Buffer.from(String(d.content), 'base64').toString('utf8'); } catch { return null; }
  return looksLrc(text) ? { text, label: SOURCE_NAMES.kugou, kw, score: bestScore } : null;
}

/**
 * 补翻译：酷狗 / QQ / B 站的日语（或英语）歌词通常只有原文，
 * 这里去网易云按同一首歌取 tlyric，再按时间戳（±0.6s）贴到原文行下面 ——
 * 时间戳一样，渲染层的 parseLrc 就会合并成「原文 + 译文」。
 */
async function attachTranslation(text, track, kwHint) {
  if (hasBilingual(text)) return text;
  // 纯中文歌就别折腾了：网易云那边基本也没有译文
  if (!hasKana(text) && hasHan(text)) return text;

  const parsed = biliParts(track.title || '');
  const biliArtist = parsed.artist;
  const artist = biliArtist || (track.source === 'bilibili' ? '' : (track.artist || ''));
  const meta = { title: parsed.song || track.title || '', artist, duration: Number(track.duration) || 0 };
  const kws = [...new Set([
    kwHint,
    `${meta.title} ${meta.artist}`.trim(),
    meta.title
  ].filter(Boolean))].slice(0, 2);

  for (const kw of kws) {
    const cands = await neteaseSearchCands(kw, 8);
    let best = null;
    let bestScore = 0;
    for (const c of cands) {
      const n = matchScore(meta, c.title, c.artist, c.duration, { loose: true });
      if (n > bestScore) { bestScore = n; best = c; }
    }
    if (!best || bestScore < 5) continue;   // 贴翻译要更严，宁可没有也别贴错歌
    const ly = await neteaseLyricById(best.id);
    if (!ly || !ly.trans || !looksLrc(ly.trans)) continue;

    const trList = [];
    for (const raw of ly.trans.replace(/\r/g, '').split('\n')) {
      const p = tsParts(raw);
      if (p && p.body) trList.push({ sec: p.sec, text: p.body });
    }
    if (!trList.length) continue;

    const out = [];
    let hit = 0;
    for (const raw of String(text).replace(/\r/g, '').split('\n')) {
      out.push(raw);
      const p = tsParts(raw);
      if (!p || !p.body) continue;
      let tr = '';
      let bestD = 1e9;
      for (const e of trList) {
        const d = Math.abs(e.sec - p.sec);
        if (d < bestD) { bestD = d; tr = e.text; }
      }
      if (bestD <= 0.6 && tr && tr !== p.body) { out.push(`${p.stamp}${tr}`); hit++; }
    }
    if (hit >= 4) return out.join('\n');
  }
  return text;
}

/* ------------------------------------------------------------------ */
/* 各音源                                                              */
/* ------------------------------------------------------------------ */

/** 网易云：官方歌词接口，LRC + tlyric 翻译 */
async function fromNetease(track) {
  const id = String(track.videoId || '');
  if (!/^\d+$/.test(id)) return null;
  const ly = await neteaseLyricById(id);
  if (!ly) return null;
  return combine(ly.lrc, ly.trans, SOURCE_NAMES.netease);
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

/**
 * 哔哩哔哩：没有 CC 字幕可用，改成「清洗投稿标题 → 跨源匹配」。
 * B 站的 artist 字段是 UP 主，所以只把括号里的内容当歌手候选，
 * 匹配主要靠标题 + 时长邻近（容差放宽到 8/15/30 秒）。
 */
async function fromBilibili(track) {
  const { song, artist } = biliParts(track.title);
  const meta = { title: song || track.title || '', artist, duration: Number(track.duration) || 0 };
  const kws = [...new Set([
    `${meta.title} ${artist}`.trim(),
    meta.title,
    track.title
  ].filter(Boolean))].slice(0, 2);

  for (const kw of kws) {
    const r = await neteaseByKeyword(kw, meta, { loose: true, min: 4, limit: 10 });
    if (r) return r;
  }
  for (const kw of kws) {
    const r = await kugouByKeyword(kw, meta, { loose: true, min: 4 });
    if (r) return r;
  }
  return null;
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

/** 按「歌名 (+歌手)」去网易云找同一首歌 —— 通用兜底二 */
async function neteaseFallback(track) {
  const parsed = biliParts(track.title || '');
  const artist = parsed.artist || (track.source === 'bilibili' ? '' : (track.artist || ''));
  const meta = { title: parsed.song || track.title || '', artist, duration: Number(track.duration) || 0 };
  const kws = [...new Set([`${meta.title} ${meta.artist}`.trim(), meta.title].filter(Boolean))].slice(0, 2);
  for (const kw of kws) {
    const r = await neteaseByKeyword(kw, meta, { loose: true, min: 4, limit: 8 });
    if (r) return r;
  }
  return null;
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
  // 本地曲目不该走到这里；在线曲目按音源取
  if (!track || !source || !track.title) return null;

  const key = `${source}:${videoId || `${track.artist || ''}-${track.title}`}`;
  if (force) {
    cache.delete(key);
  } else {
    const hit = cacheGet(key);
    if (hit !== undefined) return hit;
    if (inflight.has(key)) return inflight.get(key);
  }

  const job = (async () => {
    let res = null;
    // 一、走自己的音源
    const own = { qq: fromQQ, kugou: fromKugou, netease: fromNetease, bilibili: fromBilibili }[source];
    if (own) { try { res = await own(track); } catch { res = null; } }
    // 二、通用兜底：酷狗按「歌手 - 歌名 + 真实时长」搜歌词
    if (!res) {
      try {
        res = await fromKugouRaw(`${track.artist || ''} - ${track.title || ''}`.trim(), '', Number(track.duration) || 0);
      } catch { res = null; }
    }
    // 三、通用兜底：网易云按 歌名 (+歌手) 搜同名歌
    if (!res) {
      try { res = await neteaseFallback(track); } catch { res = null; }
    }
    if (!res || !res.text) return null;
    // 四、原文还没有双语时，去网易云补一份译文（中日 / 中英互译）
    if (track.jpTrans !== false) {
      try { res.text = await attachTranslation(res.text, track, res.kw); } catch { /* 翻译失败不影响原文 */ }
    }
    res.text = stripLeadingJunk(res.text, track);
    return res;
  })();

  inflight.set(key, job);
  try {
    const res = await job;
    cacheSet(key, res);
    return res;
  } finally {
    inflight.delete(key);
  }
}

module.exports = { fetchLyrics, SOURCE_NAMES };
