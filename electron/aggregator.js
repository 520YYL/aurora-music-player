'use strict';
const { createHash } = require('crypto');
const online = require('./online');

/**
 * Aurora 极光音乐 —— 在线音乐聚合音源（「所有音乐」分栏）
 *
 * 和「哔哩哔哩」分栏并列，直接用各平台公开的非官方接口，仍然满足：
 *   · 不需要 API Key
 *   · 不需要自建服务器，不做长驻服务
 *   · 播放时实时解析直链，不落地缓存音频
 *
 * 当前接入三个 provider：
 *   qq        QQ音乐     u.y.qq.com/cgi-bin/musicu.fcg（官方搜索接口）+ y.qq.com（封面）
 *                        ⚠ QQ 从 2023 起对匿名客户端不再下发播放凭证（vkey 的 purl 恒为空，
 *                          result=104003），所以它只负责「搜索 + 元数据 + 封面」；
 *                          播放时按「歌名 + 歌手 + 时长」去酷狗/网易云匹配同一首歌出流。
 *   kugou     酷狗音乐   songsearch.kugou.com（搜索）+ m.kugou.com / trackercdn（转直链）
 *                        + imge.kugou.com（封面）；搜索接口会返回 Privilege / PayType，
 *                        付费曲目拿不到地址，这时按「歌名 + 歌手」去网易云换一首能播的。
 *   netease   网易云音乐  music-api.gdstudio.xyz（公开聚合接口，搜索/直链/封面一把梭）
 *
 * 跨平台兜底顺序：酷狗 → 网易云 → 哔哩哔哩。用户搜的是主流华语歌时经常出现
 * 「QQ 不给凭证 + 酷狗要会员 + 网易云没有版权」三连，所以最后一站落到 B 站
 * （`electron/online.js` 那条链路，正版平台都不放时上面的完整版投稿往往还能放）。
 *
 * 所有请求都在 Electron 主进程里发出，渲染层只会拿到
 *   aurora://local/stream?v=<id>&s=<provider>   音频流（主进程带 Range 透传）
 *   aurora://local/thumb?u=<url>                封面（地址可直接拼出来的直链）
 *   aurora://local/thumb?s=netease&i=<pic_id>   封面（网易云需要先解析一次真实地址）
 *   aurora://local/thumb?s=qq&i=<albumMid>      封面（QQ 的地址可直接拼出来）
 *   aurora://local/thumb?s=kugou&i=<host/path>  封面（酷狗给的是带 {size} 占位的模板）
 * 所以既不用放开 CSP，也没有跨域问题。
 */

const GD_BASE = 'https://music-api.gdstudio.xyz/api.php';
const QQ_FCG = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const QQ_IMG = 'https://y.qq.com/music/photo_new/T002R300x300M000';
const KG_SEARCH = 'https://songsearch.kugou.com/song_search_v2';
const KG_STREAM = 'http://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=';
const KG_TRACKER = 'http://trackercdn.kugou.com/i/';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const SEARCH_TIMEOUT_MS = 12000;
const STREAM_TIMEOUT_MS = 20000;
const GD_TIMEOUT_MS = 8000;
/**
 * 跨平台兜底时，网易云最多等这么久。聚合接口 503 时会退避重试，
 * 兜底场景下没必要为它多等，超时就交给哔哩哔哩（B 站本来就已经在并发了）。
 */
const NE_FALLBACK_WAIT_MS = 900;

const STREAM_TTL_MS = 15 * 60 * 1000;
const STREAM_CACHE_MAX = 48;
const PIC_TTL_MS = 6 * 60 * 60 * 1000;

/** QQ 搜索有短时风控，两次请求之间至少隔这么久；实测 75 秒左右自动恢复 */
const QQ_MIN_INTERVAL_MS = 1200;
/** QQ 曲目信息备忘（播放时要用它去别的音源找同曲），只留最近这些条 */
const QQ_MEMO_MAX = 400;

/** provider key → 界面上显示的名字 */
const PROVIDER_NAMES = { qq: 'QQ音乐', kugou: '酷狗音乐', netease: '网易云音乐' };

/* ==================================================================== */
/* 小工具                                                                */
/* ==================================================================== */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fetchWithTimeout(url, options = {}, timeout = SEARCH_TIMEOUT_MS) {
  const opts = Object.assign({}, options);
  if (!opts.signal) opts.signal = AbortSignal.timeout(timeout);
  return fetch(url, opts);
}

/** 接口返回的文本里带 &nbsp; 和 \\u0026 这类转义，统一洗干净 */
function cleanText(raw) {
  return String(raw == null ? '' : raw)
    .replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 去重用的归一化 key */
function dedupeKey(it) {
  return `${it.title}|${it.artist}`.toLowerCase().replace(/[\s\-–—_·、,，.。!！?？'"()（）[\]【】]/g, '');
}

/* ==================================================================== */
/* 缓存                                                                  */
/* ==================================================================== */

/** `${provider}:${id}` → { url, exp } */
const streamCache = new Map();
/** 同一首歌并发播放时只解析一次 */
const streamInflight = new Map();
/** `pic:${picId}` → { url, exp } */
const picCache = new Map();
/** QQ 的 songmid → { title, artist, album, duration }，搜索时顺手记下来，播放时用来找同曲 */
const qqMemo = new Map();

function cacheGet(map, key) {
  const v = map.get(key);
  if (!v) return null;
  if (v.exp && v.exp < Date.now()) { map.delete(key); return null; }
  return v;
}
function cacheSet(map, key, value, max) {
  map.set(key, value);
  while (max && map.size > max) map.delete(map.keys().next().value);
}

/* ==================================================================== */
/* provider: 网易云音乐（走 gdstudio 公开聚合接口）                        */
/* ==================================================================== */

/** 聚合接口偶尔 502/503，重试几次；失败就抛，让上层把这个 provider 标成不可用 */
async function gdFetch(qs, tries = 3) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetchWithTimeout(GD_BASE + qs, { headers: { 'User-Agent': UA, Referer: 'https://music.gdstudio.xyz/' } }, GD_TIMEOUT_MS);
      if (r.ok) return r;
      last = new Error(`聚合接口暂时不可用（HTTP ${r.status}）`);
    } catch (err) {
      last = err;
    }
    if (i < tries - 1) await sleep(350 * (i + 1));
  }
  throw last || new Error('聚合接口请求失败');
}

async function neteaseSearch(query, want, tries = 3) {
  const r = await gdFetch(`?types=search&source=netease&name=${encodeURIComponent(query)}&count=${Math.min(60, want)}&pages=1`, tries);
  const arr = await r.json();
  if (!Array.isArray(arr)) throw new Error('聚合接口返回格式异常');
  return arr.map((it) => {
    const id = String(it.url_id || it.id || '');
    const artists = Array.isArray(it.artist) ? it.artist.join(' / ') : String(it.artist || '');
    const picId = String(it.pic_id || '');
    return {
      id: `on_netease_${id}`,
      videoId: id,
      source: 'netease',
      sourceName: '网易云',
      title: cleanText(it.name),
      artist: cleanText(artists) || '未知',
      album: cleanText(it.album),
      uploader: cleanText(artists),
      duration: 0, // 聚合接口不返回时长，界面上显示成「—」
      format: 'MP3',
      thumbnail: '', // 网易云封面地址得先解析，交给 aurora://local/thumb?s=&i= 处理
      thumbRef: picId ? { source: 'netease', id: picId } : null
    };
  }).filter((x) => x.videoId);
}

/* ==================================================================== */
/* provider: QQ 音乐（官方搜索接口，只出元数据；播放走同名匹配）           */
/* ==================================================================== */

const QQ_COMM = {
  ct: '19', cv: '1859', uin: '0', format: 'json', platform: 'wk_v17'
};

// QQ 接口有短时风控：连打几次就会返回 reqCode 2001 且列表为空，
// 所以这里串行排队 + 强制最小间隔，避免自己把自己打到限流。
let qqGate = Promise.resolve();
let qqNextAt = 0;

function qqSchedule(fn) {
  const run = qqGate.then(async () => {
    const wait = qqNextAt - Date.now();
    if (wait > 0) await sleep(wait);
    qqNextAt = Date.now() + QQ_MIN_INTERVAL_MS;
    return fn();
  });
  qqGate = run.then(() => {}, () => {});
  return run;
}

async function qqCall(req) {
  const r = await fetchWithTimeout(QQ_FCG, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Referer: 'https://y.qq.com/',
      Origin: 'https://y.qq.com',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ comm: QQ_COMM, req })
  }, SEARCH_TIMEOUT_MS);
  if (!r.ok) throw new Error(`QQ音乐接口返回 HTTP ${r.status}`);
  return r.json();
}

function qqRemember(mid, meta) {
  qqMemo.set(mid, meta);
  while (qqMemo.size > QQ_MEMO_MAX) qqMemo.delete(qqMemo.keys().next().value);
}

async function qqSearch(query, want) {
  const num = Math.max(1, Math.min(30, want));
  const req = {
    module: 'music.search.SearchCgiService',
    method: 'DoSearchForQQMusicDesktop',
    param: { query, num_per_page: num, page_num: 1 }
  };

  let list = [];
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const j = await qqSchedule(() => qqCall(req));
      const body = j && j.req && j.req.data && j.req.data.body;
      list = (body && body.song && body.song.list) || [];
      if (list.length) break;
      const code = j && j.req && j.req.code;
      lastErr = new Error(code === 2001
        ? 'QQ音乐暂时限制了搜索频率，歇一下再试'
        : 'QQ音乐没有返回搜索结果');
    } catch (err) {
      lastErr = err;
    }
    if (attempt < 2) await sleep(1400 * (attempt + 1));
  }
  if (!list.length) throw lastErr || new Error('QQ音乐搜索失败');

  return list.map((x) => {
    const mid = String(x.mid || x.songmid || '');
    const albumMid = String((x.album && x.album.mid) || '');
    const singers = (x.singer || []).map((a) => a.name).filter(Boolean).join(' / ');
    const file = x.file || {};
    const fmt = file.size_flac ? 'FLAC' : (file.size_320mp3 ? '320K' : 'MP3');
    const item = {
      id: `on_qq_${mid}`,
      videoId: mid,
      source: 'qq',
      sourceName: 'QQ音乐',
      title: cleanText(x.title || x.name),
      artist: cleanText(singers) || '未知',
      album: cleanText(x.album && x.album.name),
      uploader: cleanText(singers),
      duration: (Number(x.interval) || 0) * 1000,
      format: fmt,
      thumbnail: '', // QQ 封面地址能直接拼：aurora://local/thumb?s=qq&i=<albumMid>
      thumbRef: albumMid ? { source: 'qq', id: albumMid } : null
    };
    if (mid) qqRemember(mid, { title: item.title, artist: item.artist, album: item.album, duration: item.duration });
    return item;
  }).filter((x) => x.videoId && x.title);
}

/** 比较用的标题：去掉 (Live)、(伴奏) 这类后缀和所有标点 */
function titleKey(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[（(\[【][^)）\]】]*[)）\]】]/g, '')
    .replace(/[\s\-–—_·、,，.。!！?？'"`]/g, '');
}

/**
 * 在别的音源的搜索结果里挑出和 QQ 那首「同一首歌」的条目。
 * 标题必须一致，歌手要能对上，时长越接近越优先——用来避开翻唱/伴奏/Live 版。
 */
function pickBestMatch(list, meta) {
  const want = titleKey(meta.title);
  if (!want) return null;
  const artistKey = String(meta.artist || '').split(/\s*\/\s*/)[0].toLowerCase().replace(/\s+/g, '');
  let best = null;
  let bestScore = 0;
  for (const it of list) {
    if (titleKey(it.title) !== want) continue;
    let score = 2;
    const other = String(it.artist || '').toLowerCase().replace(/\s+/g, '');
    if (artistKey && other.includes(artistKey)) score += 2;
    else if (artistKey && other && artistKey.includes(other)) score += 1;
    if (meta.duration && it.duration) {
      const diff = Math.abs(it.duration - meta.duration);
      if (diff <= 3000) score += 1.5;
      else if (diff <= 8000) score += 0.5;
      else if (diff > 60000) score -= 2;
    }
    if (score > bestScore) { bestScore = score; best = it; }
  }
  return bestScore >= 4 ? best : null; // 至少「同名 + 同歌手」才算匹配上
}

/**
 * 酷狗、网易云都没有可播放版本时的最后一站：哔哩哔哩。
 * B 站的条目标题是视频标题（「周杰伦 - 晴天 无损音质」这类），所以匹配放宽成
 * 「标题互相包含 + 歌手出现在标题或 UP 主里」，伴奏/翻唱/教程之类扣分。
 */
function biliPick(list, meta) {
  const want = titleKey(meta.title);
  if (!want) return null;
  const artistKey = String(meta.artist || '').split(/\s*\/\s*/)[0].toLowerCase().replace(/\s+/g, '');
  let best = null;
  let bestScore = 0;
  for (const it of list) {
    if (!it || !it.videoId) continue;
    const t = titleKey(it.title);
    if (!t) continue;
    let score = 0;
    if (t === want) score += 4;
    else if (t.includes(want)) score += 2.5;
    else if (want.includes(t) && t.length >= 2) score += 1.5;
    else continue;
    const hay = `${it.title} ${it.artist || ''} ${it.uploader || ''}`.toLowerCase().replace(/\s+/g, '');
    if (!artistKey || !hay.includes(artistKey)) continue;   // 歌手对不上就不要
    score += 2;
    if (JUNK_CJK.test(it.title) || JUNK_EN.test(it.title)) score -= 2.5;
    if (score > bestScore) { bestScore = score; best = it; }
  }
  return bestScore >= 4 ? best : null;
}

/* ==================================================================== */
/* provider: 酷狗音乐（官方搜索 + 免签名播放接口）                          */
/* ==================================================================== */

/** 酷狗封面模板里的 `{size}` 占位符换成这个边长 */
const KG_PIC_SIZE = '240';
/** 酷狗两次取流之间留一点间隔，别把自己打到风控 */
const KG_MIN_INTERVAL_MS = 400;

let kgGate = Promise.resolve();
let kgNextAt = 0;

function kgSchedule(fn) {
  const run = kgGate.then(async () => {
    const wait = kgNextAt - Date.now();
    if (wait > 0) await sleep(wait);
    kgNextAt = Date.now() + KG_MIN_INTERVAL_MS;
    return fn();
  });
  kgGate = run.then(() => {}, () => {});
  return run;
}

/** 搜索结果里的 FileName 形如「周杰伦 - 晴天」，优先用 SongName，取不到再从 FileName 里剥掉歌手前缀 */
function kgTitle(it, singer) {
  const direct = cleanText(it.SongName || it.OriSongName || '');
  if (direct) return direct;
  let name = cleanText(it.FileName || '');
  const s = cleanText(singer);
  if (s && name.startsWith(s)) name = name.slice(s.length).replace(/^\s*[-–—]\s*/, '');
  return name.trim();
}

/** `http://imge.kugou.com/stdmusic/{size}/a/b.jpg` → `imge.kugou.com/stdmusic/240/a/b.jpg`（放进 URL 参数里会短一些） */
function kgPicRef(tpl) {
  const s = String(tpl || '').replace('{size}', KG_PIC_SIZE).replace(/^https?:\/\//i, '');
  return /^[A-Za-z0-9.\-]+\/[^?#\s]+\.(?:jpg|jpeg|png|webp)$/i.test(s) ? s : '';
}

async function kugouSearch(query, want) {
  const total = Math.max(1, Math.min(60, want));
  const out = [];
  for (let page = 1; out.length < total && page <= 3; page++) {
    const size = Math.min(30, total - out.length);
    if (size <= 0) break;
    const qs = `?keyword=${encodeURIComponent(query)}&page=${page}&pagesize=${size}`
      + '&platform=WebFilter&userid=-1&clientver=2000&filter=2&iscorrection=1&privilege_filter=0';
    let list = [];
    try {
      const r = await fetchWithTimeout(KG_SEARCH + qs, { headers: { 'User-Agent': UA, Referer: 'https://www.kugou.com/' } });
      if (!r.ok) throw new Error(`酷狗搜索返回 HTTP ${r.status}`);
      const j = await r.json();
      list = (j && j.data && j.data.lists) || [];
    } catch (err) {
      if (!out.length) throw err; // 一条都没有才算失败，翻页失败就用已有结果
      break;
    }
    if (!list.length) break;
    for (const it of list) out.push(it);
    if (list.length < size) break;
  }

  return out.map((it) => {
    const hash = String(it.FileHash || '');
    const singer = cleanText(it.SingerName || '').replace(/\s*、\s*/g, ' / ');
    // Privilege/PayType 都为 0 才是匿名可直接播放的；付费曲目仍然列出来（元数据更全），
    // 点击时由 resolveKugouStream 换到网易云出流。
    const paywalled = !(Number(it.Privilege) === 0 && Number(it.PayType) === 0);
    const suffix = String(it.ExtName || '').toLowerCase();
    return {
      id: `on_kugou_${hash}`,
      videoId: hash,
      source: 'kugou',
      sourceName: '酷狗',
      title: kgTitle(it, it.SingerName),
      artist: singer || '未知',
      album: cleanText(it.AlbumName),
      uploader: singer,
      duration: (Number(it.Duration) || 0) * 1000, // 接口给的是秒，转成毫秒
      format: suffix === 'flac' ? 'FLAC' : (Number(it.Bitrate) >= 320 ? '320K' : 'MP3'),
      thumbnail: '',
      thumbRef: kgPicRef(it.Image) ? { source: 'kugou', id: kgPicRef(it.Image) } : null,
      vip: paywalled
    };
  }).filter((x) => x.videoId && x.title);
}

/* ==================================================================== */
/* 聚合搜索                                                              */
/* ==================================================================== */

const PROVIDERS = {
  qq: qqSearch,
  netease: neteaseSearch,
  kugou: kugouSearch
};
// 去重时按这个顺序保留：同一首歌优先显示 QQ 音乐的元数据（专辑/时长/封面更齐），
// 播放时再自动换到酷狗/网易云出流；QQ 挂了或没这首歌，就由酷狗顶上。
const PROVIDER_ORDER = ['qq', 'kugou', 'netease'];

/** 翻唱/伴奏/DJ 之类的水货标记，用来把它们沉到正版后面 */
const JUNK_CJK = /伴奏|翻唱|钢琴|纯音乐|铃声|片段|试听|现场|演唱会|混音|抖音|童声|竖琴|吉他版|尤克里里|口琴|八音盒/;
const JUNK_EN = /\b(live|cover|karaoke|ktv|instrumental|remix|dj|acoustic|piano)\b/i;

/**
 * 关键词命中度：歌手命中比标题命中更值钱，用来把翻唱/伴奏沉下去。
 * 另外「标题是搜索词的子串」时给一个很大的加成——用户输入「周杰伦 晴天」，
 * 只有歌名就叫「晴天」的那条能吃到这个分，`周杰伦"晴天"PopxTrap Beat` 吃不到。
 */
function relevance(item, terms, rawQuery) {
  const title = String(item.title || '').toLowerCase();
  const artist = String(item.artist || '').toLowerCase();
  const album = String(item.album || '').toLowerCase();
  let score = 0;
  for (const t of terms) {
    if (!t) continue;
    if (title.includes(t)) score += 1;
    if (artist.includes(t)) score += 1.5;
    else if (album.includes(t)) score += 0.3;
  }

  const cleanTitle = titleKey(item.title);
  const cleanQuery = titleKey(rawQuery);
  if (cleanTitle && cleanTitle.length >= 2 && cleanQuery.includes(cleanTitle)) score += 2.5;
  else score -= Math.min(2, Math.max(0, cleanTitle.length - cleanQuery.length) / 6);

  const queryHasJunk = JUNK_CJK.test(rawQuery) || JUNK_EN.test(rawQuery);
  if (!queryHasJunk) {
    if (JUNK_CJK.test(item.title || '') || JUNK_EN.test(item.title || '')) score -= 1.2;
    if (/[(（[【]/.test(item.title || '')) score -= 0.4;
  }
  return score;
}

/**
 * 同时问所有 provider，任何一个失败都不影响其它的。
 * @returns {Promise<{items: Array, providers: Array<{source,name,ok,error,count}>}>}
 */
async function search(query, limit = 40) {
  const q = String(query == null ? '' : query).trim();
  if (!q) return { items: [], providers: [] };
  const want = Math.max(1, Math.min(100, Number(limit) || 40));

  const settled = await Promise.all(PROVIDER_ORDER.map(async (source) => {
    try {
      const items = await PROVIDERS[source](q, want);
      return { source, name: PROVIDER_NAMES[source], ok: true, error: '', items };
    } catch (err) {
      return {
        source,
        name: PROVIDER_NAMES[source],
        ok: false,
        error: (err && err.message) ? err.message : String(err),
        items: []
      };
    }
  }));

  const providers = settled.map((s) => ({ source: s.source, name: s.name, ok: s.ok, error: s.error, count: s.items.length }));
  if (!settled.some((s) => s.ok)) {
    const first = settled.find((s) => s.error);
    throw new Error(first ? first.error : '所有音源都不可用');
  }

  // 合并 + 去重（同歌名同歌手只留先出现的那个 provider）
  const seen = new Set();
  const merged = [];
  for (const s of settled) {
    for (const it of s.items) {
      const key = dedupeKey(it);
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      merged.push(it);
    }
  }

  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const order = new Map(PROVIDER_ORDER.map((p, i) => [p, i]));
  merged.forEach((it, i) => { it.__i = i; it.__r = relevance(it, terms, q); });
  merged.sort((a, b) => (b.__r - a.__r) || ((order.get(a.source) - order.get(b.source)) || (a.__i - b.__i)));
  const items = merged.slice(0, want).map((it) => { delete it.__i; delete it.__r; return it; });

  return { items, providers };
}

/* ==================================================================== */
/* 取播放直链                                                            */
/* ==================================================================== */

/** 酷狗拿不到播放地址时接口会回 status:0 / err_code，或者干脆没有 url 字段 */
async function resolveKugouUrl(hash) {
  const h = String(hash || '').trim();
  if (!/^[A-Za-z0-9]{16,40}$/.test(h)) throw new Error('酷狗曲目标识不正确');
  const err = new Error('酷狗没有返回播放地址（可能是会员/付费曲目）');
  err.restricted = true;

  // 通道一：移动端老接口，免签名，实测可直接出直链
  try {
    const r = await kgSchedule(() => fetchWithTimeout(
      KG_STREAM + encodeURIComponent(h),
      { headers: { 'User-Agent': UA, Referer: 'https://www.kugou.com/' } },
      SEARCH_TIMEOUT_MS
    ));
    const j = await r.json();
    if (j && typeof j.url === 'string' && /^https?:\/\//i.test(j.url)) return j.url;
  } catch { /* 换下一个通道 */ }

  // 通道二：trackercdn v1（key 是 hash + 固定盐的 md5）
  try {
    const key = createHash('md5').update(h + 'kgcloud').digest('hex');
    const r = await kgSchedule(() => fetchWithTimeout(
      `${KG_TRACKER}?cmd=4&hash=${encodeURIComponent(h)}&key=${key}&pid=1&forceDown=0&vip=1`,
      { headers: { 'User-Agent': UA, Referer: 'https://www.kugou.com/' } },
      SEARCH_TIMEOUT_MS
    ));
    const j = await r.json();
    if (j && typeof j.url === 'string' && /^https?:\/\//i.test(j.url)) return j.url;
  } catch { /* 两个通道都不行 */ }

  throw err;
}

async function resolveNeteaseUrl(id) {
  const r = await gdFetch(`?types=url&source=netease&id=${encodeURIComponent(id)}&br=320`);
  const data = await r.json();
  if (!data || !data.url) throw new Error('网易云没有返回播放地址（可能是会员/版权曲目）');
  return data.url;
}

/**
 * 版权/会员受限、或平台本身不放流时，拿「歌名 + 歌手 + 时长」去别的平台找同一首歌出流。
 *
 * 三个平台**同时并发搜**，再按「酷狗 → 网易云 → 哔哩哔哩」的优先级依次取结果。
 * 串行等的话点一次歌要付 3 个网络往返，用户能明显感到卡顿；并发之后最坏情况
 * 只等于最慢的那一个，命中高优先级时更是直接返回、不必等后面两个。
 *
 * @returns {Promise<{url?:string, bvid?:string, via:string}|null>}
 */
async function crossResolve(meta, except) {
  if (!meta || !meta.title) return null;
  const firstArtist = String(meta.artist || '').split(/\s*\/\s*/)[0];
  // 搜索词用「去掉括号后缀的歌名 + 第一歌手」：榜单里常出现
  // 「晴天 (2017周杰伦地表最强演唱会台北站)」这种长标题，整串丢给搜索接口会一条都搜不到
  const shortTitle = String(meta.title || '').replace(/[（(\[【][^)）\]】]*[)）\]】]/g, '').trim() || String(meta.title || '');
  const query = `${shortTitle} ${firstArtist}`.trim();

  // 先把三个请求都发出去（失败各自吞掉，变成空数组）
  const kgP = except === 'kugou'
    ? null
    : kugouSearch(query, 15).catch(() => []);
  const neP = except === 'netease'
    ? null
    : neteaseSearch(query, 15, 2).catch(() => []);   // 兜底用，只重试 2 次，别让 503 拖住播放
  const biliP = online.search(query, 20).then((r) => r.items || []).catch(() => []);

  // 酷狗优先
  if (kgP) {
    const list = await kgP;
    const hit = pickBestMatch(list.filter((x) => !x.vip), meta) || pickBestMatch(list, meta);
    if (hit) {
      const url = await resolveKugouUrl(hit.videoId).catch(() => null);
      if (url) return { url, via: 'kugou' };
    }
  }

  // 网易云（请求早就发出去了，这里通常不用再等；超时就放弃它，别拖住 B 站）
  if (neP) {
    const list = await Promise.race([neP, sleep(NE_FALLBACK_WAIT_MS).then(() => null)]);
    if (list) {
      const hit = pickBestMatch(list, meta);
      if (hit) {
        const url = await resolveNeteaseUrl(hit.videoId).catch(() => null);
        if (url) return { url, via: 'netease' };
      }
    }
  }

  // 最后一站：哔哩哔哩。正版平台都不给放时，B 站上的「完整版 / 无损」投稿往往还能放。
  const hit = biliPick(await biliP, meta);
  if (hit) return { bvid: hit.videoId, via: 'bilibili' };

  return null;
}

async function resolveKugouStream(hash, hint) {
  try {
    return { url: await resolveKugouUrl(hash), via: 'kugou' };
  } catch (err) {
    if (!err || !err.restricted) throw err;
    // 典型情况：酷狗这首是会员/付费曲目匿名拿不到地址，那就换网易云放同一首歌
    const alt = await crossResolve(hint, 'kugou');
    if (alt) return alt;
    const name = (hint && hint.title) || '这首歌曲';
    throw new Error(`《${name}》在酷狗是会员/付费曲目，网易云和哔哩哔哩也没有找到可播放的版本`);
  }
}

async function resolveNeteaseStream(id, hint) {
  try {
    return { url: await resolveNeteaseUrl(id), via: 'netease' };
  } catch (err) {
    const alt = await crossResolve(hint, 'netease');
    if (alt) return alt;
    throw err;
  }
}

/**
 * QQ 音乐不给匿名客户端播放凭证，所以这里按「歌名 + 歌手 + 时长」去酷狗/网易云
 * 找同一首歌来出流。两边都找不到就明确报错，不做静默降级。
 */
async function resolveQqStream(mid, hint) {
  // hint 来自渲染层（收藏里的歌曲重启后 qqMemo 已经空了），没有它就退化成“重新搜索”
  const meta = qqMemo.get(mid)
    || (hint && hint.title ? { title: hint.title, artist: hint.artist || '', duration: Number(hint.duration) || 0 } : null);
  if (!meta) throw new Error('QQ音乐：这首曲目的信息已失效，请重新搜索后再播放');

  const alt = await crossResolve(meta, 'qq');
  if (alt) return alt;

  throw new Error(`QQ音乐：《${meta.title}》在酷狗/网易云/哔哩哔哩里没有找到可播放的版本`);
}

/** @returns {Promise<{url: string, via: string}>} via 是真正出流的平台，决定请求头 */
async function resolveStreamUrl(source, id, hint) {
  if (source === 'kugou') return resolveKugouStream(id, hint);
  if (source === 'netease') return resolveNeteaseStream(id, hint);
  if (source === 'qq') return resolveQqStream(id, hint);
  throw new Error('未知音源：' + source);
}

/** 带缓存 + 并发去重的直链解析 */
async function getStreamInfo(source, id, hint) {
  const key = `${source}:${id}`;
  const hit = cacheGet(streamCache, key);
  if (hit) return hit;

  const running = streamInflight.get(key);
  if (running) return running;

  const task = (async () => {
    const resolved = await resolveStreamUrl(source, id, hint);
    const info = {
      url: resolved.url || '',
      via: resolved.via,
      bvid: resolved.bvid || '',          // via=bilibili 时用它走 B 站那条链路
      exp: Date.now() + STREAM_TTL_MS
    };
    cacheSet(streamCache, key, info, STREAM_CACHE_MAX);
    return info;
  })();

  streamInflight.set(key, task);
  try {
    return await task;
  } finally {
    streamInflight.delete(key);
  }
}

function rangeOf(req) {
  if (!req || !req.headers) return '';
  return req.headers.get('range') || req.headers.get('Range') || '';
}

async function fetchUpstream(url, req, via) {
  const headers = { 'User-Agent': UA };
  if (via === 'kugou') headers.Referer = 'https://www.kugou.com/';
  if (via === 'netease') headers.Referer = 'https://music.163.com/';
  const range = rangeOf(req);
  if (range) headers.Range = range;
  return fetchWithTimeout(url, { headers, redirect: 'follow' }, STREAM_TIMEOUT_MS);
}

function audioResponse(up) {
  const headers = new Headers();
  const ct = (up.headers.get('content-type') || '').toLowerCase();
  // 上游经常给 application/octet-stream，Chromium 会直接拒播，这里统一成 audio/*
  headers.set('Content-Type', ct.startsWith('audio/mp4') ? 'audio/mp4' : 'audio/mpeg');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'no-store');
  const len = up.headers.get('content-length');
  if (len) headers.set('Content-Length', len);
  const cr = up.headers.get('content-range');
  if (cr) headers.set('Content-Range', cr);
  if (!up.body) return new Response('上游没有返回音频数据', { status: 502 });
  return new Response(up.body, { status: up.status, headers });
}

/**
 * 音频流代理：解析直链 → 带 Range 透传给 <audio>。
 * 直链过期（403/404/410）会清缓存重新解析一次；后缀 Range（bytes=-N）个别 CDN
 * 不支持会回 416，这时退回整段重发，否则播放器 seek 到尾部会报错。
 */
async function streamResponse(source, id, req, hint) {
  if (!PROVIDERS[source]) throw new Error('未知音源：' + source);
  const key = `${source}:${id}`;

  let info = await getStreamInfo(source, id, hint);

  // 兜底到哔哩哔哩的曲目：交给 B 站那条链路（要有 buvid3 cookie、Referer 也不一样）
  if (info.via === 'bilibili' && info.bvid) {
    try {
      return await online.streamResponse(info.bvid, req);
    } catch (err) {
      streamCache.delete(key);            // 直链过期 / 视频被删，下次点重新解析
      throw err;
    }
  }

  let up = await fetchUpstream(info.url, req, info.via);

  if (up.status === 403 || up.status === 404 || up.status === 410) {
    streamCache.delete(key);
    info = await getStreamInfo(source, id, hint);
    up = await fetchUpstream(info.url, req, info.via);
  }
  if (up.status === 416 && /^bytes=-\d+$/i.test(rangeOf(req))) {
    up = await fetchUpstream(info.url, null, info.via);
  }
  return audioResponse(up);
}

/* ==================================================================== */
/* 封面代理（网易云的封面地址要先解析一次，QQ / 酷狗 的可以直接拼）        */
/* ==================================================================== */

async function imageResponse(source, id) {
  let url;
  let referer;
  if (source === 'netease') {
    const key = `pic:${id}`;
    const entry = cacheGet(picCache, key);
    if (entry) {
      url = entry.url;
    } else {
      const r = await gdFetch(`?types=pic&source=netease&id=${encodeURIComponent(id)}&size=300`);
      const data = await r.json();
      if (!data || !data.url) throw new Error('拿不到封面地址');
      url = data.url;
      picCache.set(key, { url, exp: Date.now() + PIC_TTL_MS });
    }
    referer = 'https://music.163.com/';
  } else if (source === 'qq') {
    const albumMid = String(id).replace(/[^A-Za-z0-9]/g, '');
    if (!albumMid) throw new Error('QQ音乐封面参数不正确');
    url = QQ_IMG + albumMid + '.jpg';
    referer = 'https://y.qq.com/';
  } else if (source === 'kugou') {
    // id 就是「host/路径」形式，只允许图片站，别让它变成任意请求
    const ref = String(id || '');
    if (!/^[A-Za-z0-9.\-]+\/[^?#\s]+\.(?:jpg|jpeg|png|webp)$/i.test(ref)) {
      throw new Error('酷狗封面参数不正确');
    }
    url = 'http://' + ref;
    referer = 'https://www.kugou.com/';
  } else {
    throw new Error('该音源不需要代理封面：' + source);
  }

  const up = await fetchWithTimeout(url, { headers: { 'User-Agent': UA, Referer: referer } }, GD_TIMEOUT_MS);
  if (!up.ok || !up.body) throw new Error('封面 HTTP ' + up.status);
  return new Response(up.body, {
    status: 200,
    headers: {
      'Content-Type': up.headers.get('content-type') || 'image/jpeg',
      'Cache-Control': 'public, max-age=86400'
    }
  });
}

module.exports = { search, streamResponse, imageResponse, PROVIDER_NAMES };
