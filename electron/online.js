'use strict';
/**
 * Aurora 极光音乐 —— 在线音乐模块（哔哩哔哩音源）
 *
 * 走 B 站公开的 web 接口，不需要 API Key、不需要用户做任何配置、也不需要任何自建服务器：
 *   - 搜索：api.bilibili.com/x/web-interface/search/type
 *   - 取流：api.bilibili.com/x/web-interface/view  (拿 cid)
 *           api.bilibili.com/x/player/playurl       (拿 dash 音频直链)
 *   - 音频是标准 MP4/AAC（mp4a.40.2），Chromium 的 <audio> 原生支持。
 *
 * 全部逻辑跑在 Electron 主进程内，渲染层只拿到 aurora:// 同源地址。
 *
 * 三类对外能力：
 *   search(query, limit)       —— 搜索歌曲元数据（歌名 / 歌手 / UP主 / 时长 / 封面）
 *   streamResponse(bvid, req)  —— 按 Range 把上游音频流透传给渲染层的 <audio>
 *   imageResponse(url)         —— 代理封面图，避免改 CSP、也避免直连被拦
 */

const API = 'https://api.bilibili.com';
const HOME = 'https://www.bilibili.com/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * B 站有风控：只带 UA 会吃 412 Precondition Failed，
 * 必须补齐 Accept / Origin / Referer 这一套浏览器头。
 */
const BASE_HEADERS = {
  'User-Agent': UA,
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Referer': HOME,
  'Origin': 'https://www.bilibili.com'
};

/** 音频直链带 deadline 时效（通常几小时），缓存短一点更稳 */
const STREAM_TTL_MS = 15 * 60 * 1000;
const STREAM_CACHE_MAX = 32;
/** bvid -> cid 基本不变，缓存久一点省一次请求 */
const CID_TTL_MS = 6 * 60 * 60 * 1000;

/** 只允许代理这些域名下的封面，避免本模块变成任意 URL 转发器 */
const IMG_HOST_RE = /(^|\.)(hdslb\.com|bilivideo\.com|bilivideo\.cn|biliimg\.com)$/i;

const streamCache = new Map(); // bvid -> { url, cid, at }
const cidCache = new Map();    // bvid -> { cid, title, up, at }
const inflight = new Map();    // bvid -> Promise，避免同一首歌并发取流

let cookieJar = '';
let cookieAt = 0;
let cookiePromise = null;

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (m, d) => {
      const n = Number(d);
      return n >= 32 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    })
    .replace(/&amp;/g, '&');
}

/** `//i0.hdslb.com/x.jpg` / `http://...` 统一成 https */
function httpsify(u) {
  const s = String(u == null ? '' : u).trim();
  if (!s) return '';
  if (s.startsWith('//')) return 'https:' + s;
  if (/^http:\/\//i.test(s)) return 'https://' + s.slice(7);
  return s;
}

/** "4:30" / "1:02:33" -> 秒 */
function toSeconds(d) {
  if (typeof d === 'number' && isFinite(d)) return Math.max(0, Math.round(d));
  const parts = String(d == null ? '' : d).split(':').map((x) => Number(x));
  if (!parts.length || parts.some((n) => !isFinite(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/**
 * 清洗 B 站视频标题：去掉 <em> 高亮标签、HTML 实体、以及开头那一堆装饰性括号。
 * 例：【𝐇𝐢-𝐑𝐞𝐬无损音质】｜《晴天》- 周杰伦 -'故事的小黄花'
 *  -> 《晴天》- 周杰伦 -'故事的小黄花'
 */
function cleanTitle(raw) {
  const original = String(raw == null ? '' : raw);
  let s = decodeEntities(original.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3; i++) {
    const next = s.replace(/^(【[^】]*】|\[[^\]]*\]|（[^）]*）|\([^)]*\))\s*[｜|·\-–—>》]*\s*/, '').trim();
    if (next === s || !next) break;
    s = next;
  }
  s = s.replace(/^[｜|·\-–—>》\s]+/, '').trim();
  return s || decodeEntities(original.replace(/<[^>]*>/g, '')).trim();
}

/**
 * 尽量从标题里把「歌名」和「歌手」拆出来。
 * 只认《歌名》这种最明确的写法，其余一律不动（免得猜错）。
 */
function splitTitleArtist(clean) {
  const m = /《([^》]{1,40})》/.exec(clean);
  if (!m) return { title: clean, artist: '' };
  const song = m[1].trim();
  let rest = clean.slice(m.index + m[0].length).replace(/^[\s\-–—~～·｜|:：,，>》]+/, '');
  rest = rest.replace(/[\s\-–—~～·｜|]+$/, '').trim();
  // 「周杰伦 -'故事的小黄花'」这种：在第二个分隔符处截断，只留歌手名
  rest = rest.split(/\s*[-–—|｜]\s*/)[0].trim();
  const looksLikeName =
    rest.length > 0 &&
    rest.length <= 24 &&
    !/[《》【】\[\]（）()]/.test(rest) &&
    !/(MV|4K|8K|高清|修复|完整版|现场|演唱会|无损|音质|Hi-?Res|官方|合集|循环|纯音乐|伴奏)/i.test(rest);
  return { title: song || clean, artist: looksLikeName ? rest : '' };
}

/* ------------------------------------------------------------------ */
/* 会话 / Cookie（B 站风控要求带上 buvid3）                              */
/* ------------------------------------------------------------------ */

function fakeBuvid3() {
  const h = '0123456789ABCDEF';
  const seg = (n) => Array.from({ length: n }, () => h[(Math.random() * 16) | 0]).join('');
  const uuid = `${seg(8)}-${seg(4)}-${seg(4)}-${seg(4)}-${seg(12)}`;
  return uuid + String(10000 + ((Math.random() * 90000) | 0)) + 'infoc';
}

/** 从首页拿一次真实 cookie（buvid3 / b_nut），拿不到就本地伪造一个，保证能发出去 */
async function ensureCookie() {
  if (cookieJar && Date.now() - cookieAt < 6 * 60 * 60 * 1000) return cookieJar;
  if (cookiePromise) return cookiePromise;
  cookiePromise = (async () => {
    let jar = cookieJar;
    try {
      const res = await fetch(HOME, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'zh-CN,zh;q=0.9' }
      });
      let lines = [];
      if (typeof res.headers.getSetCookie === 'function') lines = res.headers.getSetCookie();
      else {
        const v = res.headers.get('set-cookie');
        if (v) lines = [v];
      }
      const keep = [];
      for (const line of lines) {
        const pair = String(line).split(';')[0].trim();
        if (/^(buvid3|buvid4|b_nut|b_lsid|CURRENT_FNVAL)=/.test(pair)) keep.push(pair);
      }
      if (keep.length) jar = keep.join('; ');
    } catch { /* 首页拿不到就用伪造的 */ }

    if (!/(^|;\s*)buvid3=/.test(jar)) jar = (jar ? jar + '; ' : '') + 'buvid3=' + fakeBuvid3();

    cookieJar = jar;
    cookieAt = Date.now();
    cookiePromise = null;
    return cookieJar;
  })();
  try { return await cookiePromise; } catch { cookiePromise = null; return cookieJar; }
}

/* ------------------------------------------------------------------ */
/* 接口访问                                                            */
/* ------------------------------------------------------------------ */

async function apiGet(path) {
  const cookie = await ensureCookie();
  const res = await fetch(API + path, { headers: cookie ? Object.assign({ Cookie: cookie }, BASE_HEADERS) : BASE_HEADERS });
  if (!res.ok) throw new Error(`B 站接口 HTTP ${res.status}`);
  const data = await res.json();
  if (data.code !== 0) throw new Error(`B 站接口返回 ${data.code}：${data.message || '未知错误'}`);
  return data.data;
}

/* ------------------------------------------------------------------ */
/* 搜索                                                                */
/* ------------------------------------------------------------------ */

function normalize(it) {
  const cleaned = cleanTitle(it.title);
  const split = splitTitleArtist(cleaned);
  const author = decodeEntities(String(it.author == null ? '' : it.author)).trim();
  return {
    videoId: it.bvid,                                   // 渲染层沿用这个字段名，对应 bvid
    title: split.title || cleaned || decodeEntities(String(it.title == null ? '' : it.title)).trim(),
    artist: split.artist || author || '未知',
    album: author || '哔哩哔哩',                          // 「专辑」列显示 UP主（B 站没有专辑概念）
    uploader: author,
    duration: toSeconds(it.duration) * 1000,            // 渲染层按毫秒处理
    thumbnail: httpsify(it.pic),
    source: 'bilibili'
  };
}

async function search(query, limit = 40) {
  const q = String(query == null ? '' : query).trim();
  if (!q) return { query: '', items: [] };

  const want = Math.max(1, Math.min(60, Number(limit) || 40));
  const pages = Math.max(1, Math.ceil(want / 20));       // 接口每页约 20 条
  const seen = new Set();
  const items = [];
  let lastErr = null;

  for (let page = 1; page <= pages; page++) {
    let data;
    try {
      data = await apiGet(`/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(q)}&page=${page}`);
    } catch (err) {
      lastErr = err;
      break;                                            // 失败就停止翻页，不做无限重试
    }
    const list = (data && data.result) || [];
    if (!list.length) break;
    for (const it of list) {
      if (!it || !it.bvid || seen.has(it.bvid)) continue;
      seen.add(it.bvid);
      items.push(normalize(it));
      if (items.length >= want) break;
    }
    if (items.length >= want) break;
  }

  if (!items.length && lastErr) throw lastErr;
  return { query: q, items };
}

/* ------------------------------------------------------------------ */
/* 取流                                                                */
/* ------------------------------------------------------------------ */

async function resolveCid(bvid) {
  const hit = cidCache.get(bvid);
  if (hit && Date.now() - hit.at < CID_TTL_MS) return hit;
  const view = await apiGet(`/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
  const cid = view && view.cid;
  if (!cid) throw new Error('拿不到该视频的 cid');
  const rec = { cid, title: view.title || '', up: (view.owner && view.owner.name) || '', at: Date.now() };
  cidCache.set(bvid, rec);
  return rec;
}

async function resolveStream(bvid) {
  const { cid, title, up } = await resolveCid(bvid);
  const play = await apiGet(`/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}&fnval=4048&fourk=1`);
  const dash = play && play.dash;
  const audios = (dash && Array.isArray(dash.audio) && dash.audio) || [];
  if (!audios.length) throw new Error('这条内容没有可用的音频流（可能是番剧 / 付费 / 已失效）');

  const best = audios.slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
  // B 站给一条 baseUrl + 若干 backupUrl。baseUrl 经常落在 P2P 节点（*.mcdn.bilivideo.cn:8082），
  // 这个节点在不少网络下连接会被重置（ECONNRESET），所以优先挑普通 CDN（upos-*）的地址。
  const cands = [best.baseUrl || best.base_url, ...((best.backupUrl || best.backup_url) || [])].filter(Boolean);
  const url = cands.find((u) => !/\.mcdn\./i.test(u)) || cands[0];
  if (!url) throw new Error('音频直链为空');
  return { url, cid, itag: best.id, bandwidth: best.bandwidth || 0, codecs: best.codecs || '', title, up };
}

function cacheGet(bvid) {
  const hit = streamCache.get(bvid);
  if (!hit) return null;
  if (Date.now() - hit.at > STREAM_TTL_MS) { streamCache.delete(bvid); return null; }
  return hit;
}

function cacheSet(bvid, info) {
  streamCache.delete(bvid);
  streamCache.set(bvid, Object.assign({}, info, { at: Date.now() }));
  while (streamCache.size > STREAM_CACHE_MAX) streamCache.delete(streamCache.keys().next().value);
}

function getStreamInfo(bvid) {
  const hit = cacheGet(bvid);
  if (hit) return Promise.resolve(hit);
  const running = inflight.get(bvid);
  if (running) return running;
  const p = resolveStream(bvid)
    .then((info) => { cacheSet(bvid, info); return info; })
    .finally(() => inflight.delete(bvid));
  inflight.set(bvid, p);
  return p;
}

/** 上游请求头（下载时复用；Range 由调用方另外拼） */
async function upstreamHeaders() {
  const cookie = await ensureCookie();
  const headers = {
    'User-Agent': UA,
    'Accept': '*/*',
    'Accept-Encoding': 'identity',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Referer': HOME,
    'Origin': 'https://www.bilibili.com'
  };
  if (cookie) headers.Cookie = cookie;
  return headers;
}

async function fetchUpstream(url, range) {
  const headers = await upstreamHeaders();
  if (range) headers.Range = range;
  return fetch(url, { headers });
}

/**
 * 下载用：哔哩哔哩的 dash 音频直链必须带 buvid3 cookie 和 B 站 Referer，
 * 所以把「直链 + 请求头」一起交出去。
 */
async function downloadTarget(bvid) {
  const info = await getStreamInfo(bvid);
  return { url: info.url, headers: await upstreamHeaders(), via: 'bilibili' };
}

async function streamResponse(bvid, req) {
  const range = req.headers.get('range') || req.headers.get('Range') || '';
  let info = await getStreamInfo(bvid);
  let up = await fetchUpstream(info.url, range);

  // 直链过期 / 被下线：清掉缓存重新解析一次（只重试一次）
  if (up.status === 403 || up.status === 404 || up.status === 410) {
    streamCache.delete(bvid);
    inflight.delete(bvid);
    info = await getStreamInfo(bvid);
    up = await fetchUpstream(info.url, range);
  }

  // 上游不支持「后缀 Range」（bytes=-N，MP3/FLAC 读尾部标签会用到）：
  // 退回整段 200，让浏览器的媒体栈自己再来一次正常 Range。
  if (up.status === 416 && /^bytes=-\d+$/.test(range)) {
    up = await fetchUpstream(info.url, '');
  }

  if (!up.ok && up.status !== 206) throw new Error('上游服务器返回 ' + up.status);

  const type = String(up.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const headers = new Headers();
  // B 站 CDN 对 dash 音频返回 application/octet-stream，Chromium 可能因此不认，
  // 这里强制标成 audio/mp4（内容确实是 ftypisom 的标准 MP4/AAC）。
  headers.set('Content-Type', type && type !== 'application/octet-stream' ? type : 'audio/mp4');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'no-store');
  const cl = up.headers.get('content-length');
  if (cl) headers.set('Content-Length', cl);
  const cr = up.headers.get('content-range');
  if (cr) headers.set('Content-Range', cr);

  return new Response(up.body, { status: up.status, headers });
}

/* ------------------------------------------------------------------ */
/* 封面代理                                                            */
/* ------------------------------------------------------------------ */

async function imageResponse(rawUrl) {
  const url = httpsify(rawUrl);
  if (!url) throw new Error('封面地址为空');

  let u;
  try { u = new URL(url); } catch { throw new Error('封面地址非法'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('封面协议不允许：' + u.protocol);
  if (!IMG_HOST_RE.test(u.hostname)) throw new Error('封面域名不在白名单：' + u.hostname);

  const res = await fetch(u.toString(), {
    headers: {
      'User-Agent': UA,
      'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Referer': HOME
    }
  });
  if (!res.ok) throw new Error('封面上游返回 ' + res.status);

  const buf = Buffer.from(await res.arrayBuffer());
  return new Response(buf, {
    status: 200,
    headers: {
      'Content-Type': res.headers.get('content-type') || 'image/jpeg',
      'Content-Length': String(buf.length),
      'Cache-Control': 'public, max-age=86400'
    }
  });
}

module.exports = {
  getClient: ensureCookie,   // 兼容旧接口：预热 cookie
  search,
  streamResponse,
  imageResponse,
  downloadTarget
};
