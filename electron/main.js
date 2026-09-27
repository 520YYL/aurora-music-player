'use strict';
/**
 * 极光音乐 Aurora Music —— Electron 主进程
 */
const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, globalShortcut, screen, nativeImage, Menu, Tray } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pathToFileURL } = require('node:url');

const { JsonStore } = require('./store');
const scanner = require('./scanner');
const { findLyrics } = require('./lyrics-finder');
const DEFAULTS = require('../src/js/defaults.js');
const PRESETS = require('../src/js/presets.js');

const APP_ROOT = path.join(__dirname, '..');
const SRC_ROOT = path.join(APP_ROOT, 'src');
const IS_DEV = !app.isPackaged;

// 应用名（决定用户数据目录）
app.setName('AuroraPlayer');

/* ------------------------------------------------------------------ */
/* 自检模式： electron . --smoke  → 15 秒后写出 smoke-report.json 并退出  */
/* ------------------------------------------------------------------ */
const SMOKE = process.argv.includes('--smoke');
const smoke = { console: [], errors: [], state: null, startedAt: new Date().toISOString() };

/** 直接写文件的诊断轨迹（Electron 是 GUI 子系统程序，stdout 常无法捕获） */
const TRACE_FILE = path.join(APP_ROOT, 'smoke-trace.log');
function trace(line) {
  if (!SMOKE) return;
  try { fs.appendFileSync(TRACE_FILE, `${new Date().toISOString()} ${line}\n`); } catch { /* ignore */ }
}

function smokeLog(line) {
  if (!SMOKE) return;
  try { smoke.console.push(line); } catch { /* ignore */ }
  trace(line);
}
function smokePhase(phase) {
  smoke.phase = phase;
  try { fs.writeFileSync(path.join(APP_ROOT, 'smoke-report.json'), JSON.stringify(smoke, null, 2)); } catch { /* ignore */ }
  trace('phase=' + phase);
}
if (SMOKE) { try { fs.writeFileSync(TRACE_FILE, ''); } catch { /* ignore */ } }
trace('module-loaded argv=' + process.argv.slice(1).join(' '));

/** @type {BrowserWindow|null} */ let mainWindow = null;
/** @type {BrowserWindow|null} */ let lyricsWindow = null;
/** @type {BrowserWindow|null} */ let miniWindow = null;
/** @type {Tray|null} */ let tray = null;

let settingsStore, libraryStore, statsStore, playlistsStore;
let metaCache = {};
let NEEDS_LIBRARY_REBUILD = false;
let DATA_DIR = '';
let COVERS_DIR = '';
let LYRICS_DIR = '';
let quitting = false;

/* ------------------------------------------------------------------ */
/* 单实例                                                              */
/* ------------------------------------------------------------------ */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  trace('single-instance-lock FAILED -> quitting');
  app.quit();
} else {
  app.on('second-instance', () => { showMain(); });
  trace('single-instance-lock acquired');
}

/* ------------------------------------------------------------------ */
/* 自定义协议：aurora://local/...                                       */
/* 统一 host=local，保证页面与媒体同源，Web Audio 分析器不会被跨域污染。    */
/* ------------------------------------------------------------------ */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'aurora',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true, corsEnabled: true, allowServiceWorkers: false }
  }
]);

/**
 * 返回文件响应。
 * 使用「有界缓冲区 + 206 分段」而不是 Node 流：既避免 Electron 对 Web 流响应体的兼容问题，
 * 又保证拖动进度条时可以按需分块读取（单次最多 4MB，内存可控）。
 */
const MAX_CHUNK = 4 * 1024 * 1024;

function fileResponse(filePath, req, extraHeaders = {}) {
  return (async () => {
    let stat;
    try { stat = await fsp.stat(filePath); } catch { trace('fileResponse 404 ' + filePath); return new Response('Not Found', { status: 404 }); }
    if (stat.isDirectory()) return new Response('Is a directory', { status: 404 });
    const total = stat.size;
    const mime = scanner.mimeFor(filePath);
    const headers = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', ...extraHeaders };
    const rangeHeader = req.headers.get('range') || req.headers.get('Range');
    const isMedia = /^(audio|video)\//.test(mime);

    async function slice(start, end) {
      const len = end - start + 1;
      const buf = Buffer.allocUnsafe(len);
      const fh = await fsp.open(filePath, 'r');
      try { await fh.read(buf, 0, len, start); } finally { await fh.close(); }
      return buf;
    }

    if (rangeHeader && isMedia) {
      const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
      if (!Number.isFinite(start) || start < 0) start = 0;
      if (!Number.isFinite(end) || end >= total) end = total - 1;
      if (start > end || start >= total) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
      }
      if (end - start + 1 > MAX_CHUNK) end = Math.min(total - 1, start + MAX_CHUNK - 1);
      const buf = await slice(start, end);
      return new Response(buf, {
        status: 206,
        headers: { ...headers, 'Content-Length': String(buf.length), 'Content-Range': `bytes ${start}-${end}/${total}` }
      });
    }

    if (total <= MAX_CHUNK) {
      const buf = await fsp.readFile(filePath);
      return new Response(buf, { status: 200, headers: { ...headers, 'Content-Length': String(buf.length) } });
    }

    // 大文件且未带 Range：返回第一段并声明 206，浏览器会继续按需请求
    const end = Math.min(total - 1, MAX_CHUNK - 1);
    const buf = await slice(0, end);
    return new Response(buf, {
      status: 206,
      headers: { ...headers, 'Content-Length': String(buf.length), 'Content-Range': `bytes 0-${end}/${total}` }
    });
  })();
}

async function registerProtocol() {
  protocol.handle('aurora', async (req) => {
    try {
      return await handleAuroraRequest(req);
    } catch (err) {
      trace('proto EXCEPTION ' + req.url + ' :: ' + (err && err.stack ? err.stack : err));
      return new Response('Internal Error', { status: 500 });
    }
  });
}

async function handleAuroraRequest(req) {
  {
    let url;
    try { url = new URL(req.url); } catch { trace('proto BADURL ' + req.url); return new Response('Bad Request', { status: 400 }); }
    const kind = url.pathname.replace(/^\/+/, '').split('/')[0];
    const params = url.searchParams;
    if (kind === 'app') trace('proto app ' + url.pathname);

    if (kind === 'app') {
      const rel = decodeURIComponent(url.pathname.replace(/^\/app\/?/, '')) || 'index.html';
      const target = path.join(SRC_ROOT, rel);
      if (!target.startsWith(SRC_ROOT)) { trace('proto FORBIDDEN ' + target); return new Response('Forbidden', { status: 403 }); }
      return fileResponse(target, req);
    }
    if (kind === 'media' || kind === 'bg') {
      const p = params.get('p');
      if (!p) return new Response('Missing path', { status: 400 });
      const target = path.resolve(decodeURIComponent(p));
      if (!fs.existsSync(target)) return new Response('Not Found', { status: 404 });
      return fileResponse(target, req);
    }
    if (kind === 'cover') {
      const id = params.get('id');
      if (!id || !/^[a-f0-9]+$/i.test(id)) return new Response('Bad id', { status: 400 });
      for (const ext of ['.jpg', '.png', '.webp']) {
        const p = path.join(COVERS_DIR, id + ext);
        if (fs.existsSync(p)) return fileResponse(p, req, { 'Cache-Control': 'public, max-age=86400' });
      }
      return new Response('Not Found', { status: 404 });
    }
    if (kind === 'asset') {
      const rel = decodeURIComponent(url.pathname.replace(/^\/asset\/?/, ''));
      const target = path.join(APP_ROOT, 'assets', rel);
      if (!target.startsWith(path.join(APP_ROOT, 'assets'))) return new Response('Forbidden', { status: 403 });
      return fileResponse(target, req);
    }
    return new Response('Not Found', { status: 404 });
  }
}

/* ------------------------------------------------------------------ */
/* 数据初始化                                                           */
/* ------------------------------------------------------------------ */
function initStores() {
  DATA_DIR = app.getPath('userData');
  COVERS_DIR = path.join(DATA_DIR, 'covers');
  LYRICS_DIR = path.join(DATA_DIR, 'lyrics');
  fs.mkdirSync(COVERS_DIR, { recursive: true });
  fs.mkdirSync(LYRICS_DIR, { recursive: true });

  settingsStore = new JsonStore(path.join(DATA_DIR, 'settings.json'), DEFAULTS.DEFAULT_SETTINGS);
  libraryStore = new JsonStore(path.join(DATA_DIR, 'library.json'), { tracks: [], roots: [], updatedAt: 0 });
  statsStore = new JsonStore(path.join(DATA_DIR, 'stats.json'), { version: 1, days: {}, tracks: {}, totals: { ms: 0 }, createdAt: Date.now() });
  playlistsStore = new JsonStore(path.join(DATA_DIR, 'playlists.json'), { playlists: [] });

  try { metaCache = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'meta-cache.json'), 'utf8')); } catch { metaCache = {}; }

  // 首次运行：把默认内置插件写入设置
  const installed = settingsStore.get('plugins.installed');
  if (!Array.isArray(installed) || installed.length === 0) {
    settingsStore.set('plugins.installed', PRESETS.BUILTIN_PLUGINS.map((p) => ({ ...p, enabled: false })));
  }

  // 首次运行：自动探测系统音乐目录作为曲库根
  const roots = settingsStore.get('library.roots', []);
  if (!Array.isArray(roots) || roots.length === 0) {
    const guess = [];
    const home = app.getPath('home');
    for (const cand of [app.getPath('music'), path.join(home, 'Music')]) {
      try { if (cand && fs.existsSync(cand) && !guess.includes(cand)) guess.push(cand); } catch { /* ignore */ }
    }
    if (guess.length) settingsStore.set('library.roots', guess);
  }
  // 元数据解析规则升级（例如修正了标题/歌手顺序）后，丢弃旧缓存并自动重建一次曲库，
  // 否则用户会一直看到旧缓存里的错误结果。
  const metaVer = settingsStore.get('library.metaVersion', 1);
  if (metaVer !== scanner.META_VERSION) {
    settingsStore.set('library.metaVersion', scanner.META_VERSION);
    try { fs.unlinkSync(path.join(DATA_DIR, 'meta-cache.json')); } catch { /* 不存在则忽略 */ }
    metaCache = {};
    NEEDS_LIBRARY_REBUILD = true;
    trace(`metaVersion ${metaVer} -> ${scanner.META_VERSION}，将重建曲库`);
  }

  settingsStore.save();
  libraryStore.set('roots', settingsStore.get('library.roots', []));
  libraryStore.save();
}

function saveMetaCacheDebounced() {
  clearTimeout(saveMetaCacheDebounced._t);
  saveMetaCacheDebounced._t = setTimeout(() => {
    try { fs.writeFileSync(path.join(DATA_DIR, 'meta-cache.json'), JSON.stringify(metaCache)); } catch { /* ignore */ }
  }, 1500);
}

function saveCover(id, buffer, format) {
  try {
    const img = nativeImage.createFromBuffer(buffer);
    if (img.isEmpty()) return false;
    let out = img;
    const size = img.getSize();
    const maxSide = Math.max(size.width, size.height);
    if (maxSide > 420) {
      const scale = 420 / maxSide;
      out = img.resize({ width: Math.round(size.width * scale), height: Math.round(size.height * scale), quality: 'good' });
    }
    const png = /png/i.test(format || '');
    const data = png ? out.toPNG() : out.toJPEG(88);
    fs.writeFileSync(path.join(COVERS_DIR, id + (png ? '.png' : '.jpg')), data);
    return true;
  } catch { return false; }
}

/* ------------------------------------------------------------------ */
/* 窗口                                                                */
/* ------------------------------------------------------------------ */
function preloadPath() { return path.join(__dirname, 'preload.js'); }

function appUrl(page) { return `aurora://local/app/${page}`; }

function createMainWindow() {
  const bounds = settingsStore.get('window.bounds', null);
  mainWindow = new BrowserWindow({
    width: bounds?.width || 1240,
    height: bounds?.height || 800,
    x: bounds?.x, y: bounds?.y,
    minWidth: 940, minHeight: 620,
    show: false,
    frame: false,
    backgroundColor: '#0a0a12',
    title: 'Aurora 极光音乐',
    icon: path.join(APP_ROOT, 'assets', 'icon.ico'),
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      backgroundThrottling: false,
      spellcheck: false
    }
  });

  if (bounds?.maximized) mainWindow.maximize();
  mainWindow.loadURL(appUrl('index.html')).then(
    () => trace('loadURL resolved'),
    (err) => trace('loadURL REJECTED ' + (err && err.message ? err.message : err))
  );
  mainWindow.webContents.on('dom-ready', () => trace('dom-ready'));
  mainWindow.webContents.on('did-stop-loading', () => trace('did-stop-loading'));
  mainWindow.webContents.on('preload-error', (_e, p, err) => trace('preload-error ' + p + ' ' + (err && err.message)));
  // 把渲染进程的 console 转发到主进程 stdout，便于排查问题
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const tag = ['debug', 'info', 'warn', 'error'][level] || 'log';
    smokeLog(`[renderer:${tag}] ${message} (${String(sourceId).replace(/^.*\//, '')}:${line})`);
    if (level >= 2 || process.argv.includes('--verbose')) {
      console.log(`[renderer:${tag}] ${message} (${String(sourceId).replace(/^.*\//, '')}:${line})`);
    }
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    trace(`did-fail-load ${code} ${desc} ${url}`);
    console.error(`[main] 页面加载失败 ${code} ${desc} ${url}`);
    smoke.errors.push(`did-fail-load ${code} ${desc} ${url}`);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    smoke.errors.push('render-process-gone ' + JSON.stringify(details));
  });
  mainWindow.webContents.on('unresponsive', () => smoke.errors.push('renderer unresponsive'));
  mainWindow.webContents.on('did-finish-load', () => {
    smokeLog('[main] did-finish-load');
    trace('did-finish-load');
    if (SMOKE) runSmokeTest();
  });
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (process.argv.includes('--devtools') || IS_DEV && process.argv.includes('--debug')) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  const persist = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const b = mainWindow.getNormalBounds ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    settingsStore.set('window.bounds', { ...b, maximized: mainWindow.isMaximized() });
  };
  mainWindow.on('resize', persist);
  mainWindow.on('move', persist);
  mainWindow.on('maximize', persist);
  mainWindow.on('unmaximize', persist);
  mainWindow.on('close', (e) => {
    persist();
    if (!quitting && settingsStore.get('ui.closeToTray', false)) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('aurora://')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
  });
}

function createLyricsWindow() {
  if (lyricsWindow && !lyricsWindow.isDestroyed()) return lyricsWindow;
  const L = settingsStore.get('lyrics', DEFAULTS.DEFAULT_SETTINGS.lyrics);
  const pos = L.pos || {};
  const w = pos.w || 1100;
  const h = pos.h || 220;
  const x = Number.isFinite(pos.x) ? pos.x : Math.round((screen.getPrimaryDisplay().workAreaSize.width - w) / 2);
  const y = Number.isFinite(pos.y) ? pos.y : Math.round(screen.getPrimaryDisplay().workAreaSize.height - h - 90);

  lyricsWindow = new BrowserWindow({
    width: w, height: h, x, y,
    minWidth: 420, minHeight: 110,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    movable: true,
    skipTaskbar: true,
    focusable: true,
    show: false,
    fullscreenable: false,
    alwaysOnTop: L.alwaysOnTop !== false,
    title: 'Aurora 桌面歌词',
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });
  lyricsWindow.setAlwaysOnTop(L.alwaysOnTop !== false, 'screen-saver');
  lyricsWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  lyricsWindow.loadURL(appUrl('lyrics.html'));
  lyricsWindow.once('ready-to-show', () => { if (L.desktopEnabled) lyricsWindow.showInactive(); });
  lyricsWindow.on('closed', () => { lyricsWindow = null; });

  const persistPos = () => {
    if (!lyricsWindow || lyricsWindow.isDestroyed()) return;
    const b = lyricsWindow.getBounds();
    settingsStore.set('lyrics.pos', b);
  };
  lyricsWindow.on('move', persistPos);
  lyricsWindow.on('resize', persistPos);
  if (L.clickThrough) lyricsWindow.setIgnoreMouseEvents(true, { forward: true });
  return lyricsWindow;
}

function createMiniWindow() {
  if (miniWindow && !miniWindow.isDestroyed()) return miniWindow;
  const M = settingsStore.get('mini', DEFAULTS.DEFAULT_SETTINGS.mini);
  const pos = M.pos || {};
  const size = M.size || { w: 340, h: 128 };
  const x = Number.isFinite(pos.x) ? pos.x : undefined;
  const y = Number.isFinite(pos.y) ? pos.y : undefined;
  miniWindow = new BrowserWindow({
    width: size.w || 340, height: size.h || 128,
    x, y,
    minWidth: 260, minHeight: 92,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: M.alwaysOnTop !== false,
    title: 'Aurora 迷你播放器',
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });
  miniWindow.setAlwaysOnTop(M.alwaysOnTop !== false, 'floating');
  miniWindow.loadURL(appUrl('mini.html'));
  miniWindow.once('ready-to-show', () => { if (M.visible) miniWindow.showInactive(); });
  miniWindow.on('closed', () => { miniWindow = null; });

  const persist = () => {
    if (!miniWindow || miniWindow.isDestroyed()) return;
    const b = miniWindow.getBounds();
    settingsStore.set('mini.pos', { x: b.x, y: b.y });
    settingsStore.set('mini.size', { w: b.width, h: b.height });
  };
  miniWindow.on('move', persist);
  miniWindow.on('resize', persist);
  return miniWindow;
}

function broadcast(channel, payload, exceptWebContentsId) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    if (exceptWebContentsId && w.webContents.id === exceptWebContentsId) continue;
    try { w.webContents.send(channel, payload); } catch { /* ignore */ }
  }
}

function showMain() {
  if (!mainWindow || mainWindow.isDestroyed()) { createMainWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/* ------------------------------------------------------------------ */
/* 扫描曲库                                                             */
/* ------------------------------------------------------------------ */
let scanning = false;

async function doScan(rootsInput, opts = {}) {
  if (scanning) return { ok: false, error: '正在扫描中，请稍候' };
  scanning = true;
  const started = Date.now();
  try {
    let roots = rootsInput;
    if (!roots || !roots.length) roots = settingsStore.get('library.roots', []);
    roots = (roots || []).filter(Boolean);
    if (!roots.length) { scanning = false; return { ok: false, error: '尚未选择任何音乐文件夹' }; }

    broadcast('scan:progress', { phase: 'searching', found: 0, message: '正在搜索音频文件…' });
    const files = await scanner.scanFolders(roots, {
      onProgress: (p) => broadcast('scan:progress', { phase: 'searching', found: p.found, current: p.current, message: `已找到 ${p.found} 个音频文件` })
    });

    const prevTracks = libraryStore.get('tracks', []) || [];
    const prevById = new Map(prevTracks.map((t) => [t.id, t]));
    const tracks = [];
    let done = 0;
    for (const f of files) {
      let st = null;
      try { st = await fsp.stat(f); } catch { continue; }
      const id = scanner.trackId(f);
      const cached = metaCache[f];
      const prev = prevById.get(id);
      if (cached && cached.v === scanner.META_VERSION && cached.mtime === Math.round(st.mtimeMs) && cached.size === st.size) {
        const t = { ...cached.data, id, path: f };
        // 保留用户态数据
        if (prev) { t.favorite = prev.favorite; t.rating = prev.rating; t.playCount = prev.playCount; t.lastPlayedAt = prev.lastPlayedAt; }
        tracks.push(t);
      } else {
        const coverJob = [];
        const meta = await scanner.readMetadata(f, (cid, buf, fmt) => coverJob.push([cid, buf, fmt]));
        for (const [cid, buf, fmt] of coverJob) saveCover(cid, buf, fmt);
        if (meta.embeddedLyrics) { delete meta.embeddedLyrics; }
        metaCache[f] = { v: scanner.META_VERSION, mtime: Math.round(st.mtimeMs), size: st.size, data: meta };
        const t = { ...meta };
        if (prev) { t.favorite = prev.favorite; t.rating = prev.rating; t.playCount = prev.playCount; t.lastPlayedAt = prev.lastPlayedAt; }
        tracks.push(t);
      }
      done++;
      if (done % 5 === 0 || done === files.length) {
        broadcast('scan:progress', { phase: 'reading', done, total: files.length, percent: Math.round((done / files.length) * 100), message: `正在读取标签 ${done}/${files.length}` });
      }
    }
    saveMetaCacheDebounced();

    tracks.sort((a, b) => String(a.path).localeCompare(String(b.path), 'zh-Hans-CN'));
    libraryStore.set('tracks', tracks);
    libraryStore.set('roots', roots);
    libraryStore.set('updatedAt', Date.now());
    libraryStore.save();
    settingsStore.set('library.roots', roots);
    settingsStore.save();

    const result = { ok: true, tracks, count: tracks.length, roots, elapsedMs: Date.now() - started };
    broadcast('library:updated', result);
    broadcast('scan:progress', { phase: 'done', percent: 100, message: `扫描完成，共 ${tracks.length} 首` });
    return result;
  } catch (err) {
    broadcast('scan:progress', { phase: 'error', message: String(err && err.message ? err.message : err) });
    return { ok: false, error: String(err && err.message ? err.message : err) };
  } finally {
    scanning = false;
  }
}

/* ------------------------------------------------------------------ */
/* 统计                                                                */
/* ------------------------------------------------------------------ */
function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addStats(entries) {
  const stats = statsStore.get();
  if (!stats.days) stats.days = {};
  if (!stats.tracks) stats.tracks = {};
  if (!stats.totals) stats.totals = { ms: 0 };
  let added = 0;
  for (const e of entries || []) {
    const ms = Math.max(0, Math.round(Number(e.ms) || 0));
    if (!ms) continue;
    const day = e.day || todayKey();
    if (!stats.days[day]) stats.days[day] = { ms: 0, tracks: {} };
    const d = stats.days[day];
    d.ms += ms;
    if (e.id) {
      d.tracks[e.id] = (d.tracks[e.id] || 0) + ms;
      if (!stats.tracks[e.id]) stats.tracks[e.id] = { ms: 0, count: 0, last: 0 };
      stats.tracks[e.id].ms += ms;
      if (e.incrementPlay) {
        stats.tracks[e.id].count += 1;
        stats.tracks[e.id].last = Date.now();
        const lib = libraryStore.get('tracks', []);
        const t = lib.find((x) => x.id === e.id);
        if (t) { t.playCount = (t.playCount || 0) + 1; t.lastPlayedAt = Date.now(); libraryStore.set('tracks', lib); }
      }
    }
    stats.totals.ms += ms;
    added += ms;
  }
  statsStore.markDirty && statsStore.markDirty();
  statsStore.saveDebounced(800);
  return { ok: true, added };
}

function computeStatsSummary() {
  const stats = statsStore.get();
  const days = stats.days || {};
  const today = todayKey();
  const now = new Date();
  const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const yearPrefix = String(now.getFullYear());

  let todayMs = 0, monthMs = 0, yearMs = 0, allMs = 0;
  let monthDays = 0, yearDays = 0, activeDays = 0;
  const last30 = [];
  const byMonth = {};
  const byYear = {};

  const dayMs = (k) => (days[k] && days[k].ms) || 0;

  for (const [k, v] of Object.entries(days)) {
    const ms = v.ms || 0;
    allMs += ms;
    if (ms > 0) activeDays++;
    if (k.startsWith(yearPrefix)) { yearMs += ms; if (ms > 0) yearDays++; }
    if (k.startsWith(monthPrefix)) { monthMs += ms; if (ms > 0) monthDays++; }
    if (k === today) todayMs += ms;
    const ym = k.slice(0, 7);
    byMonth[ym] = (byMonth[ym] || 0) + ms;
    const y = k.slice(0, 4);
    byYear[y] = (byYear[y] || 0) + ms;
  }

  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const k = todayKey(d);
    last30.push({ day: k, ms: dayMs(k) });
  }

  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    months.push({ month: k, ms: byMonth[k] || 0 });
  }

  const years = Object.keys(byYear).sort().map((y) => ({ year: y, ms: byYear[y] }));

  const daysInMonthSoFar = now.getDate();
  const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);

  return {
    today: todayMs,
    month: monthMs,
    year: yearMs,
    all: allMs,
    activeDays,
    monthActiveDays: monthDays,
    yearActiveDays: yearDays,
    monthAverage: monthDays ? Math.round(monthMs / monthDays) : 0,
    yearAverage: yearDays ? Math.round(yearMs / yearDays) : 0,
    allAverage: activeDays ? Math.round(allMs / activeDays) : 0,
    monthAverageCalendar: Math.round(monthMs / Math.max(1, daysInMonthSoFar)),
    yearAverageCalendar: Math.round(yearMs / Math.max(1, dayOfYear)),
    last30,
    months,
    years,
    tracks: stats.tracks || {},
    firstDay: Object.keys(days).sort()[0] || null,
    updatedAt: Date.now()
  };
}

/* ------------------------------------------------------------------ */
/* 快捷键                                                              */
/* ------------------------------------------------------------------ */
const GLOBAL_ACTIONS = {
  playPause: 'playPause', next: 'next', prev: 'prev', stop: 'stop',
  toggleMain: 'toggleMain', toggleDesktopLyrics: 'toggleDesktopLyrics', toggleMini: 'toggleMini'
};

function toElectronAccel(accel) {
  if (!accel) return null;
  let a = String(accel).trim();
  if (!a) return null;
  a = a.replace(/CommandOrControl/gi, 'Ctrl').replace(/\bCmd\b/gi, 'Ctrl').replace(/\bCommand\b/gi, 'Ctrl');
  a = a.replace(/\bControl\b/gi, 'Ctrl').replace(/\bEsc\b/gi, 'Escape');
  a = a.replace(/\bSpacebar\b/gi, 'Space').replace(/\bReturn\b/gi, 'Enter');
  a = a.replace(/\bArrowUp\b/g, 'Up').replace(/\bArrowDown\b/g, 'Down').replace(/\bArrowLeft\b/g, 'Left').replace(/\bArrowRight\b/g, 'Right');
  return a;
}

function registerGlobalShortcuts() {
  globalShortcut.unregisterAll();
  const S = settingsStore.get('shortcuts', DEFAULTS.DEFAULT_SETTINGS.shortcuts);
  if (!S || S.globalEnabled === false) return { registered: [], failed: [] };
  const registered = [];
  const failed = [];
  for (const [action, accel] of Object.entries(S.global || {})) {
    if (!accel || !GLOBAL_ACTIONS[action]) continue;
    const e = toElectronAccel(accel);
    if (!e) continue;
    try {
      const ok = globalShortcut.register(e, () => handleGlobalAction(action));
      if (ok) registered.push({ action, accel: e });
      else failed.push({ action, accel: e });
    } catch { failed.push({ action, accel: e }); }
  }
  return { registered, failed };
}

function handleGlobalAction(action) {
  if (action === 'toggleMain') { toggleMainWindow(); return; }
  if (action === 'toggleDesktopLyrics') { toggleDesktopLyrics(); return; }
  if (action === 'toggleMini') { toggleMini(); return; }
  broadcast('shortcut:action', { action });
}

function toggleMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
  else showMain();
}

function toggleDesktopLyrics(force) {
  const cur = settingsStore.get('lyrics.desktopEnabled', false);
  const next = typeof force === 'boolean' ? force : !cur;
  settingsStore.set('lyrics.desktopEnabled', next);
  settingsStore.save();
  if (next) {
    const w = createLyricsWindow();
    w.showInactive();
  } else if (lyricsWindow && !lyricsWindow.isDestroyed()) {
    lyricsWindow.hide();
  }
  broadcast('settings:changed', { lyrics: settingsStore.get('lyrics') });
  return next;
}

function toggleMini(force) {
  const cur = settingsStore.get('mini.visible', false);
  const next = typeof force === 'boolean' ? force : !cur;
  settingsStore.set('mini.visible', next);
  settingsStore.save();
  if (next) { const w = createMiniWindow(); w.showInactive(); }
  else if (miniWindow && !miniWindow.isDestroyed()) miniWindow.hide();
  broadcast('settings:changed', { mini: settingsStore.get('mini') });
  return next;
}

/* ------------------------------------------------------------------ */
/* 桌面快捷方式                                                         */
/* ------------------------------------------------------------------ */
function createDesktopShortcut(opts2 = {}) {
  try {
    const desktop = opts2.desktopDir || app.getPath('desktop');
    fs.mkdirSync(desktop, { recursive: true });
    const lnk = path.join(desktop, 'Aurora 极光音乐.lnk');
    const iconCandidates = [
      path.join(APP_ROOT, 'assets', 'icon.ico'),
      path.join(process.resourcesPath || '', 'app', 'assets', 'icon.ico'),
      path.join(APP_ROOT, 'assets', 'icon.png'),
      process.execPath
    ];
    let iconPath = process.execPath;
    for (const c of iconCandidates) {
      try { if (c && fs.existsSync(c)) { iconPath = c; break; } } catch { /* ignore */ }
    }
    const opts = {
      target: process.execPath,
      cwd: path.dirname(process.execPath),
      description: 'Aurora 极光音乐 - 本地音乐播放器',
      icon: iconPath,
      iconIndex: 0,
      appUserModelId: 'com.aurora.music'
    };
    if (!app.isPackaged) { opts.args = `"${APP_ROOT}"`; opts.cwd = APP_ROOT; }
    const exist = fs.existsSync(lnk);
    const ok = shell.writeShortcutLink(lnk, exist ? 'update' : 'create', opts);
    return { ok, path: lnk, target: process.execPath, icon: iconPath, updated: exist };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */
function setupIpc() {
  const handle = (ch, fn) => ipcMain.handle(ch, async (evt, ...args) => {
    try { return await fn(evt, ...args); }
    catch (err) { return { __error: String(err && err.message ? err.message : err) }; }
  });

  handle('app:info', () => ({
    version: app.getVersion(),
    name: app.getName(),
    dataDir: DATA_DIR,
    coversDir: COVERS_DIR,
    lyricsDir: LYRICS_DIR,
    appRoot: APP_ROOT,
    resourcesPath: process.resourcesPath,
    packaged: app.isPackaged,
    platform: process.platform,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    mediaSupport: { mp3: true, ogg: true, flac: true, wav: true, m4a: true, aac: true, opus: true }
  }));

  handle('settings:get', () => settingsStore.get());
  handle('settings:set', (e, key, value) => {
    settingsStore.set(key, value);
    settingsStore.saveDebounced();
    return { ok: true };
  });
  handle('settings:merge', (e, patch) => {
    settingsStore.merge(patch);
    settingsStore.save();
    broadcast('settings:changed', patch, e.sender.id);
    if (patch && patch.shortcuts) registerGlobalShortcuts();
    if (patch && patch.lyrics) applyLyricsSettings(patch.lyrics);
    if (patch && patch.mini) applyMiniSettings(patch.mini);
    return settingsStore.get();
  });
  handle('settings:reset', () => { settingsStore.data = JSON.parse(JSON.stringify(DEFAULTS.DEFAULT_SETTINGS)); settingsStore.save(); return settingsStore.get(); });

  handle('library:get', () => libraryStore.get());
  handle('library:scan', (e, roots) => doScan(roots));
  handle('library:pickFolder', async () => {
    const res = await dialog.showOpenDialog(mainWindow, { title: '选择音乐文件夹', properties: ['openDirectory', 'multiSelections'] });
    if (res.canceled) return { canceled: true };
    return { canceled: false, paths: res.filePaths };
  });
  handle('library:addRoots', async (e, roots) => {
    const cur = settingsStore.get('library.roots', []);
    const next = Array.from(new Set([...cur, ...(roots || [])]));
    settingsStore.set('library.roots', next);
    settingsStore.save();
    return doScan(next);
  });
  handle('library:removeRoot', async (e, root) => {
    const cur = settingsStore.get('library.roots', []);
    const next = cur.filter((r) => r !== root);
    settingsStore.set('library.roots', next);
    settingsStore.save();
    libraryStore.set('tracks', (libraryStore.get('tracks', []) || []).filter((t) => !String(t.path).startsWith(root)));
    libraryStore.save();
    return { ok: true, roots: next, tracks: libraryStore.get('tracks', []) };
  });
  handle('library:updateTrack', (e, id, patch) => {
    const tracks = libraryStore.get('tracks', []);
    const t = tracks.find((x) => x.id === id);
    if (t) { Object.assign(t, patch); libraryStore.set('tracks', tracks); libraryStore.save(); }
    return t || null;
  });
  handle('library:reorder', (e, orderedIds) => {
    const tracks = libraryStore.get('tracks', []);
    const map = new Map(tracks.map((t) => [t.id, t]));
    const next = [];
    for (const id of orderedIds || []) { const t = map.get(id); if (t) { next.push(t); map.delete(id); } }
    for (const t of map.values()) next.push(t);
    libraryStore.set('tracks', next);
    libraryStore.set('manualOrder', true);
    libraryStore.save();
    return { ok: true };
  });
  handle('library:removeTrack', (e, id) => {
    const tracks = (libraryStore.get('tracks', []) || []).filter((t) => t.id !== id);
    libraryStore.set('tracks', tracks); libraryStore.save();
    return { ok: true };
  });
  handle('library:deleteFile', async (e, id) => {
    const tracks = libraryStore.get('tracks', []);
    const t = tracks.find((x) => x.id === id);
    if (!t) return { ok: false, error: '未找到曲目' };
    try {
      await shell.trashItem(t.path);
      libraryStore.set('tracks', tracks.filter((x) => x.id !== id));
      libraryStore.save();
      return { ok: true };
    } catch (err) { return { ok: false, error: String(err.message || err) }; }
  });
  handle('library:showInFolder', (e, p) => { shell.showItemInFolder(p); return { ok: true }; });

  handle('covers:get', async (e, id) => {
    for (const ext of ['.jpg', '.png', '.webp']) {
      const p = path.join(COVERS_DIR, id + ext);
      try { await fsp.access(p); return `aurora://local/cover?id=${id}&t=${Date.now()}`; } catch { /* next */ }
    }
    return null;
  });
  handle('covers:stats', async () => {
    try {
      const files = await fsp.readdir(COVERS_DIR);
      let bytes = 0;
      for (const f of files) { try { bytes += (await fsp.stat(path.join(COVERS_DIR, f))).size; } catch { /* ignore */ } }
      return { count: files.length, bytes };
    } catch { return { count: 0, bytes: 0 }; }
  });

  // 歌词
  handle('lyrics:find', async (e, track) => {
    const roots = settingsStore.get('library.roots', []);
    const res = await findLyrics(track, roots, LYRICS_DIR);
    return res;
  });
  handle('lyrics:import', async (e, trackId) => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '导入歌词文件',
      filters: [{ name: '歌词文件', extensions: ['lrc', 'txt'] }],
      properties: ['openFile']
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    const src = res.filePaths[0];
    try {
      const buf = await fsp.readFile(src);
      const safe = path.basename(src).replace(/[\\/:*?"<>|]/g, '_');
      const dest = path.join(LYRICS_DIR, safe);
      await fsp.writeFile(dest, buf);
      return { canceled: false, base64: buf.toString('base64'), path: dest, name: safe };
    } catch (err) { return { canceled: false, error: String(err.message || err) }; }
  });
  handle('lyrics:saveFor', async (e, name, base64) => {
    try {
      const safe = String(name || 'lyrics.lrc').replace(/[\\/:*?"<>|]/g, '_');
      const dest = path.join(LYRICS_DIR, safe.endsWith('.lrc') ? safe : safe + '.lrc');
      await fsp.writeFile(dest, Buffer.from(base64, 'base64'));
      return { ok: true, path: dest };
    } catch (err) { return { ok: false, error: String(err.message || err) }; }
  });
  handle('lyrics:list', async () => {
    try {
      const files = await fsp.readdir(LYRICS_DIR);
      return files.filter((f) => /\.(lrc|txt)$/i.test(f)).map((f) => ({ name: f, path: path.join(LYRICS_DIR, f) }));
    } catch { return []; }
  });

  // 桌面歌词窗口
  handle('lyricsWin:toggle', (e, force) => ({ enabled: toggleDesktopLyrics(force) }));
  handle('lyricsWin:show', () => { toggleDesktopLyrics(true); return { ok: true }; });
  handle('lyricsWin:hide', () => { toggleDesktopLyrics(false); return { ok: true }; });
  handle('lyricsWin:update', (e, patch) => {
    if (patch && typeof patch === 'object') {
      settingsStore.merge({ lyrics: patch });
      settingsStore.save();
      const L = settingsStore.get('lyrics');
      applyLyricsSettings(L);
      broadcast('lyrics:settings', L);
      broadcast('settings:changed', { lyrics: L }, e.sender.id);
    }
    return { ok: true };
  });
  handle('lyricsWin:setClickThrough', (e, on) => {
    settingsStore.set('lyrics.clickThrough', !!on); settingsStore.save();
    if (lyricsWindow && !lyricsWindow.isDestroyed()) lyricsWindow.setIgnoreMouseEvents(!!on, { forward: true });
    broadcast('settings:changed', { lyrics: settingsStore.get('lyrics') });
    return { ok: true };
  });
  handle('lyricsWin:lock', (e, on) => {
    settingsStore.set('lyrics.locked', !!on);
    if (lyricsWindow && !lyricsWindow.isDestroyed()) {
      lyricsWindow.setIgnoreMouseEvents(!!on, { forward: true });
      lyricsWindow.setResizable(!on);
    }
    settingsStore.save();
    broadcast('settings:changed', { lyrics: settingsStore.get('lyrics') });
    return { ok: true };
  });
  handle('lyricsWin:setAlwaysOnTop', (e, on) => {
    settingsStore.set('lyrics.alwaysOnTop', !!on); settingsStore.save();
    if (lyricsWindow && !lyricsWindow.isDestroyed()) lyricsWindow.setAlwaysOnTop(!!on, 'screen-saver');
    return { ok: true };
  });
  handle('lyricsWin:resetPos', () => {
    if (lyricsWindow && !lyricsWindow.isDestroyed()) {
      const { width, height } = screen.getPrimaryDisplay().workAreaSize;
      lyricsWindow.setBounds({ x: Math.round((width - 1100) / 2), y: height - 310, width: 1100, height: 220 });
    }
    return { ok: true };
  });
  handle('lyricsWin:sync', (e, payload) => { broadcast('lyrics:sync', payload); return { ok: true }; });
  handle('lyricsWin:getBounds', () => (lyricsWindow && !lyricsWindow.isDestroyed() ? lyricsWindow.getBounds() : null));

  // 迷你播放器
  handle('mini:toggle', (e, force) => ({ visible: toggleMini(force) }));
  handle('mini:update', (e, patch) => {
    if (patch && typeof patch === 'object') {
      settingsStore.merge({ mini: patch });
      settingsStore.save();
      const M = settingsStore.get('mini');
      applyMiniSettings(M);
      broadcast('mini:settings', M);
      broadcast('settings:changed', { mini: M }, e.sender.id);
    }
    return { ok: true };
  });
  handle('mini:sync', (e, payload) => { broadcast('mini:sync', payload); return { ok: true }; });

  // 统计
  handle('stats:add', (e, entries) => { const r = addStats(entries); broadcast('stats:updated', computeStatsSummary()); return r; });
  handle('stats:summary', () => computeStatsSummary());
  handle('stats:raw', () => statsStore.get());
  handle('stats:reset', () => {
    statsStore.data = { version: 1, days: {}, tracks: {}, totals: { ms: 0 }, createdAt: Date.now() };
    statsStore.save();
    const tracks = libraryStore.get('tracks', []);
    for (const t of tracks) { t.playCount = 0; t.lastPlayedAt = 0; }
    libraryStore.set('tracks', tracks); libraryStore.save();
    broadcast('stats:updated', computeStatsSummary());
    return { ok: true };
  });
  handle('stats:export', async () => {
    const res = await dialog.showSaveDialog(mainWindow, { title: '导出听歌统计', defaultPath: `aurora-stats-${todayKey()}.json`, filters: [{ name: 'JSON', extensions: ['json'] }, { name: 'CSV', extensions: ['csv'] }] });
    if (res.canceled || !res.filePath) return { canceled: true };
    const summary = computeStatsSummary();
    try {
      if (res.filePath.toLowerCase().endsWith('.csv')) {
        const lines = ['日期,听歌时长(秒)'];
        for (const k of Object.keys(statsStore.get('days') || {}).sort()) lines.push(`${k},${Math.round(((statsStore.get('days')[k] || {}).ms || 0) / 1000)}`);
        await fsp.writeFile(res.filePath, '\ufeff' + lines.join('\r\n'), 'utf8');
      } else {
        await fsp.writeFile(res.filePath, JSON.stringify({ summary, raw: statsStore.get() }, null, 2), 'utf8');
      }
      return { ok: true, path: res.filePath };
    } catch (err) { return { ok: false, error: String(err.message || err) }; }
  });

  // 播放列表
  handle('playlists:get', () => playlistsStore.get('playlists', []));
  handle('playlists:save', (e, list) => { playlistsStore.set('playlists', list || []); playlistsStore.save(); return { ok: true }; });
  handle('playlists:export', async (e, payload) => {
    const res = await dialog.showSaveDialog(mainWindow, { title: '导出播放列表', defaultPath: `${(payload && payload.name) || 'playlist'}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (res.canceled || !res.filePath) return { canceled: true };
    await fsp.writeFile(res.filePath, JSON.stringify(payload, null, 2), 'utf8');
    return { ok: true, path: res.filePath };
  });

  // 音效插件
  handle('plugins:list', () => {
    const installed = settingsStore.get('plugins.installed', []) || [];
    const enabled = settingsStore.get('plugins.enabled', []) || [];
    const params = settingsStore.get('plugins.params', {}) || {};
    return { installed, enabled, params };
  });
  handle('plugins:setEnabled', (e, id, on) => {
    let enabled = settingsStore.get('plugins.enabled', []) || [];
    if (on) { if (!enabled.includes(id)) enabled.push(id); }
    else enabled = enabled.filter((x) => x !== id);
    settingsStore.set('plugins.enabled', enabled);
    settingsStore.save();
    broadcast('plugins:changed', { enabled }, e.sender.id);
    return { ok: true, enabled };
  });
  handle('plugins:setParams', (e, id, p) => {
    settingsStore.set(`plugins.params.${id}`, p);
    settingsStore.save();
    broadcast('plugins:changed', { params: { [id]: p } }, e.sender.id);
    return { ok: true };
  });
  handle('plugins:import', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '导入音效插件',
      filters: [
        { name: '极光音效插件', extensions: ['auroraplugin', 'json'] },
        { name: '脉冲响应音频 (混响)', extensions: ['wav', 'ogg', 'mp3', 'flac', 'm4a'] },
        { name: '所有文件', extensions: ['*'] }
      ],
      properties: ['openFile', 'multiSelections']
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    const added = [];
    const errors = [];
    for (const f of res.filePaths) {
      try {
        const ext = path.extname(f).toLowerCase();
        if (['.auroraplugin', '.json'].includes(ext)) {
          const raw = await fsp.readFile(f, 'utf8');
          const obj = JSON.parse(raw);
          const list = Array.isArray(obj) ? obj : (Array.isArray(obj.plugins) ? obj.plugins : [obj]);
          for (const p of list) {
            if (!p || !p.name || !Array.isArray(p.graph)) { errors.push(`${path.basename(f)}: 缺少 name 或 graph 字段`); continue; }
            const item = {
              id: p.id || `user.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 7)}`,
              name: String(p.name).slice(0, 40),
              author: p.author || '用户导入',
              version: p.version || '1.0.0',
              desc: p.desc || '',
              category: p.category || '导入',
              params: Array.isArray(p.params) ? p.params : [],
              graph: p.graph,
              user: true,
              importedAt: Date.now(),
              source: f
            };
            const installed = settingsStore.get('plugins.installed', []) || [];
            const existIdx = installed.findIndex((x) => x.id === item.id);
            if (existIdx >= 0) installed[existIdx] = { ...installed[existIdx], ...item };
            else installed.push(item);
            settingsStore.set('plugins.installed', installed);
            added.push(item);
          }
        } else if (['.wav', '.ogg', '.mp3', '.flac', '.m4a'].includes(ext)) {
          // 作为脉冲响应导入，生成混响插件
          const safe = path.basename(f).replace(/[\\/:*?"<>|]/g, '_');
          const dest = path.join(DATA_DIR, 'impulse', safe);
          await fsp.mkdir(path.dirname(dest), { recursive: true });
          await fsp.copyFile(f, dest);
          const item = {
            id: `user.ir.${Date.now().toString(36)}`,
            name: `混响 · ${path.basename(f, ext)}`,
            author: '用户导入',
            version: '1.0.0',
            desc: '由导入的脉冲响应文件生成的卷积混响',
            category: '空间',
            params: [{ key: 'mix', label: '湿度', min: 0, max: 100, default: 40, unit: '%' }],
            graph: [{ node: 'ir', type: 'convolver', params: { irFile: dest, mix: '{mix}' } }],
            user: true,
            importedAt: Date.now(),
            source: f
          };
          const installed = settingsStore.get('plugins.installed', []) || [];
          installed.push(item);
          settingsStore.set('plugins.installed', installed);
          added.push(item);
        } else {
          errors.push(`${path.basename(f)}: 不支持的文件类型`);
        }
      } catch (err) { errors.push(`${path.basename(f)}: ${String(err.message || err)}`); }
    }
    settingsStore.save();
    const payload = { installed: settingsStore.get('plugins.installed', []) || [] };
    broadcast('plugins:changed', payload);
    return { canceled: false, added, errors };
  });
  handle('plugins:remove', (e, id) => {
    const installed = (settingsStore.get('plugins.installed', []) || []).filter((p) => p.id !== id || p.builtin);
    settingsStore.set('plugins.installed', installed);
    settingsStore.set('plugins.enabled', (settingsStore.get('plugins.enabled', []) || []).filter((x) => x !== id));
    settingsStore.save();
    return { ok: true, installed };
  });
  handle('plugins:reset', () => {
    settingsStore.set('plugins.installed', PRESETS.BUILTIN_PLUGINS.map((p) => ({ ...p })));
    settingsStore.set('plugins.enabled', []);
    settingsStore.set('plugins.params', {});
    settingsStore.save();
    return { ok: true };
  });
  handle('plugins:openFolder', async () => {
    const dir = path.join(DATA_DIR, 'plugins');
    await fsp.mkdir(dir, { recursive: true });
    shell.openPath(dir);
    return { ok: true, dir };
  });

  // 迷你播放器 / 桌面歌词发来的播放控制命令
  handle('player:command', (e, action) => {
    broadcast('shortcut:action', { action });
    return { ok: true };
  });

  // 窗口控制
  handle('win:minimize', (e) => { BrowserWindow.fromWebContents(e.sender)?.minimize(); return { ok: true }; });
  handle('win:maximize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return { ok: false };
    if (w.isMaximized()) w.unmaximize(); else w.maximize();
    return { ok: true, maximized: w.isMaximized() };
  });
  handle('win:close', (e) => { BrowserWindow.fromWebContents(e.sender)?.close(); return { ok: true }; });
  handle('win:hide', (e) => { BrowserWindow.fromWebContents(e.sender)?.hide(); return { ok: true }; });
  handle('win:isMaximized', (e) => !!BrowserWindow.fromWebContents(e.sender)?.isMaximized());
  handle('win:setOpacity', (e, v) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w) w.setOpacity(Math.min(1, Math.max(0.2, Number(v) || 1)));
    return { ok: true };
  });
  handle('win:setSize', (e, w2, h2) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w) w.setSize(Math.round(w2), Math.round(h2), true);
    return { ok: true };
  });
  handle('win:focusMain', () => { showMain(); return { ok: true }; });

  // 快捷键
  handle('shortcuts:register', () => registerGlobalShortcuts());
  handle('shortcuts:set', (e, scope, action, accel) => {
    settingsStore.set(`shortcuts.${scope}.${action}`, accel || '');
    settingsStore.save();
    if (scope === 'global') registerGlobalShortcuts();
    return settingsStore.get('shortcuts');
  });
  handle('shortcuts:reset', () => {
    settingsStore.set('shortcuts', JSON.parse(JSON.stringify(DEFAULTS.DEFAULT_SETTINGS.shortcuts)));
    settingsStore.save();
    const r = registerGlobalShortcuts();
    return { shortcuts: settingsStore.get('shortcuts'), ...r };
  });
  handle('shortcuts:listRegistered', () => ({
    global: (globalShortcut.getAll() || []).map((s) => s.accelerator)
  }));

  // 对话框 / 系统
  handle('dialog:pickImage', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择背景图片', filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif'] }], properties: ['openFile']
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    return { canceled: false, path: res.filePaths[0] };
  });
  handle('dialog:pickFiles', async (e, kind) => {
    const filters = kind === 'audio'
      ? [{ name: '音频文件', extensions: ['mp3', 'ogg', 'oga', 'm4a', 'flac', 'wav', 'aac', 'opus'] }]
      : [{ name: '所有文件', extensions: ['*'] }];
    const res = await dialog.showOpenDialog(mainWindow, { title: '选择文件', filters, properties: ['openFile', 'multiSelections'] });
    if (res.canceled) return { canceled: true };
    return { canceled: false, paths: res.filePaths };
  });
  handle('dialog:saveFile', async (e, opts) => {
    const res = await dialog.showSaveDialog(mainWindow, opts || {});
    if (res.canceled || !res.filePath) return { canceled: true };
    return { canceled: false, path: res.filePath };
  });
  handle('fs:writeText', async (e, p, text) => { await fsp.writeFile(p, text, 'utf8'); return { ok: true }; });
  handle('sys:createDesktopShortcut', () => createDesktopShortcut());
  handle('sys:openPath', async (e, p) => { await shell.openPath(p); return { ok: true }; });
  handle('sys:openExternal', async (e, url) => { if (/^https?:/i.test(url)) await shell.openExternal(url); return { ok: true }; });
  handle('sys:showItemInFolder', (e, p) => { shell.showItemInFolder(p); return { ok: true }; });
  handle('sys:quit', () => { quitting = true; app.quit(); return { ok: true }; });  handle('sys:restart', () => { quitting = true; app.relaunch(); app.exit(0); });
  handle('sys:setCloseToTray', (e, on) => { settingsStore.set('ui.closeToTray', !!on); settingsStore.save(); ensureTray(); return { ok: true }; });
  handle('sys:mediaKeys', (e, on) => {
    settingsStore.set('shortcuts.globalEnabled', !!on);
    settingsStore.save();
    return registerGlobalShortcuts();
  });
  handle('shell:openDataDir', async () => { shell.openPath(DATA_DIR); return { ok: true, dir: DATA_DIR }; });
  handle('shell:clearCovers', async () => {
    try {
      const files = await fsp.readdir(COVERS_DIR);
      for (const f of files) { try { await fsp.unlink(path.join(COVERS_DIR, f)); } catch { /* ignore */ } }
      return { ok: true, removed: files.length };
    } catch (err) { return { ok: false, error: String(err.message || err) }; }
  });

  // 曲目文件可访问性检查（用于显示失效曲目）
  handle('library:verify', async (e, ids) => {
    const tracks = libraryStore.get('tracks', []);
    const out = {};
    for (const id of ids || []) {
      const t = tracks.find((x) => x.id === id);
      if (!t) { out[id] = false; continue; }
      try { await fsp.access(t.path); out[id] = true; } catch { out[id] = false; }
    }
    return out;
  });
}

function applyLyricsSettings(patch) {
  if (!lyricsWindow || lyricsWindow.isDestroyed()) return;
  const L = settingsStore.get('lyrics', DEFAULTS.DEFAULT_SETTINGS.lyrics);
  if (patch && typeof patch.alwaysOnTop === 'boolean') lyricsWindow.setAlwaysOnTop(patch.alwaysOnTop, 'screen-saver');
  if (patch && typeof patch.clickThrough === 'boolean') lyricsWindow.setIgnoreMouseEvents(patch.clickThrough, { forward: true });
  if (patch && patch.pos && (Number.isFinite(patch.pos.w) || Number.isFinite(patch.pos.h))) {
    const b = lyricsWindow.getBounds();
    lyricsWindow.setBounds({ x: b.x, y: b.y, width: patch.pos.w || b.width, height: patch.pos.h || b.height });
  }
  if (patch && patch.monitor && patch.monitor !== 'primary') {
    const displays = screen.getAllDisplays();
    const idx = parseInt(String(patch.monitor).replace('display-', ''), 10);
    const d = displays[idx];
    if (d) {
      const b = lyricsWindow.getBounds();
      lyricsWindow.setBounds({ x: d.workArea.x + Math.round((d.workArea.width - b.width) / 2), y: d.workArea.y + d.workArea.height - b.height - 90, width: b.width, height: b.height });
    }
  }
  broadcast('lyrics:settings', L);
}

function applyMiniSettings(patch) {
  const M = settingsStore.get('mini', DEFAULTS.DEFAULT_SETTINGS.mini);
  if (patch && typeof patch.visible === 'boolean') toggleMini(patch.visible);
  if (patch && typeof patch.alwaysOnTop === 'boolean' && miniWindow && !miniWindow.isDestroyed()) {
    miniWindow.setAlwaysOnTop(patch.alwaysOnTop, 'floating');
  }
  broadcast('mini:settings', M);
}

/* ------------------------------------------------------------------ */
/* 托盘                                                                */
/* ------------------------------------------------------------------ */
function ensureTray() {
  try {
    if (tray) return;
    const iconPath = path.join(APP_ROOT, 'assets', 'icon.ico');
    const img = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
    tray = new Tray(img);
    tray.setToolTip('Aurora 极光音乐');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => showMain() },
      { label: '播放 / 暂停', click: () => broadcast('shortcut:action', { action: 'playPause' }) },
      { label: '上一首', click: () => broadcast('shortcut:action', { action: 'prev' }) },
      { label: '下一首', click: () => broadcast('shortcut:action', { action: 'next' }) },
      { type: 'separator' },
      { label: '桌面歌词', type: 'checkbox', checked: settingsStore.get('lyrics.desktopEnabled', false), click: (i) => toggleDesktopLyrics(i.checked) },
      { label: '迷你播放器', type: 'checkbox', checked: settingsStore.get('mini.visible', false), click: (i) => toggleMini(i.checked) },
      { type: 'separator' },
      { label: '退出', click: () => { quitting = true; app.quit(); } }
    ]));
    tray.on('double-click', () => showMain());
  } catch { /* 托盘失败不影响使用 */ }
}

/* ------------------------------------------------------------------ */
/* 自检实现                                                             */
/* ------------------------------------------------------------------ */
function runSmokeTest() {
  const wc = mainWindow.webContents;
  const evalJs = async (code) => {
    try { return await wc.executeJavaScript(code, true); }
    catch (err) { smoke.errors.push('eval: ' + String(err && err.message ? err.message : err)); return null; }
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  smokePhase('smoke-start');
  setTimeout(async () => {
    try {
      smokePhase('collecting-boot');
      smoke.boot = await evalJs(`(() => {
        const A = window.App;
        return {
          hasApp: !!A,
          booted: !!(A && A.state && A.state.appInfo),
          settingsLoaded: !!(A && A.settings),
          view: A && A.state ? A.state.view : null,
          navItems: document.querySelectorAll('.nav-item[data-view]').length,
          viewRootChildren: document.getElementById('viewRoot') ? document.getElementById('viewRoot').children.length : -1,
          tracks: A && A.state ? A.state.tracks.length : -1,
          roots: A && A.settings ? (A.settings.library.roots || []) : [],
          engineReady: A && A.engine ? A.engine.ready : null,
          degraded: A && A.engine ? A.engine.degraded : null,
          pluginsInstalled: A && A.settings ? (A.settings.plugins.installed || []).length : -1,
          eqPresets: Object.keys((window.AURORA_PRESETS || {}).EQ_PRESETS || {}).length,
          errors: window.__auroraErrors || []
        };
      })()`);

      // 等待自动扫描完成
      smokePhase('waiting-scan');
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline && (libraryStore.get('tracks', []) || []).length === 0) await sleep(700);
      const tracks = libraryStore.get('tracks', []) || [];
      smoke.scan = {
        count: tracks.length,
        withDuration: tracks.filter((t) => t.duration > 0).length,
        withArtist: tracks.filter((t) => t.artist).length,
        withAlbum: tracks.filter((t) => t.album).length,
        withCover: tracks.filter((t) => t.hasCover).length,
        byFormat: tracks.reduce((a, t) => { a[t.format] = (a[t.format] || 0) + 1; return a; }, {}),
        sample: tracks.slice(0, 3).map((t) => ({ title: t.title, artist: t.artist, album: t.album, dur: t.duration, fmt: t.format, cover: t.hasCover }))
      };
      if (!tracks.length) smoke.errors.push('曲库扫描后仍为空');

      // 标题/歌手顺序校验：对于「A - B」形式的无标签文件名，标题应等于前段 A
      smoke.nameOrder = (() => {
        let titleFirst = 0; let artistFirst = 0; let noDash = 0; const bad = [];
        for (const t of tracks) {
          const base = path.basename(t.path, path.extname(t.path));
          const parts = base.split(/\s+-\s+/);
          if (parts.length < 2) { noDash++; continue; }
          const a = parts[0].trim();
          const b = parts.slice(1).join(' - ').trim();
          if (t.title === a) titleFirst++;
          else if (t.title === b) { artistFirst++; bad.push(`${base} -> title="${t.title}"`); }
        }
        return { total: tracks.length, titleFirst, artistFirst, noDash, suspicious: bad.slice(0, 5) };
      })();
      if (smoke.nameOrder.artistFirst > 0) {
        smoke.errors.push(`标题/歌手可能仍然反了：${smoke.nameOrder.artistFirst} 首（例：${smoke.nameOrder.suspicious.join(' | ')}）`);
      }

      // 歌词解析
      smokePhase('lyrics');
      smoke.lyrics = await evalJs(`(async () => {
        const A = window.App;
        const t = A.state.tracks.find(x => /Refrain|琴师/.test(x.title || '') || /Refrain|琴师/.test(x.name || '')) || A.state.tracks[0];
        if (!t) return { skipped: true };
        const raw = await window.aurora.lyrics.find({ path: t.path, title: t.title, artist: t.artist, name: t.name });
        await A.lyrics.loadFor(t);
        return {
          title: t.title, path: t.path,
          rawErr: raw && raw.__error ? raw.__error : null,
          rawKeys: raw ? Object.keys(raw) : null,
          rawB64: raw && raw.base64 ? raw.base64.length : 0,
          rawPath: raw ? raw.path : null,
          lines: A.lyrics.lines.length, bilingual: A.lyrics.lines.some(l => l.tr),
          source: A.lyrics.sourcePath, first: (A.lyrics.lines[0] || {}).text,
          firstThree: A.lyrics.lines.slice(0, 3).map(l => l.text + (l.tr ? ' / ' + l.tr : ''))
        };
      })()`);

      // 播放 + Web Audio 通路 + 统计
      smokePhase('playback');
      smoke.playback = await evalJs(`(async () => {
        const A = window.App;
        if (!A.state.tracks.length) return { skipped: true };
        A.player.setQueue(A.state.tracks, 0);
        await new Promise(r => setTimeout(r, 5000));
        const st = A.player.state();
        const d = A.engine.decks[0];
        const data = A.engine.frequencyData();
        let sum = 0; if (data) for (let i = 0; i < data.length; i += 32) sum += data[i];
        return {
          track: st.current && st.current.title,
          playing: st.playing, position: st.position, duration: st.duration,
          engineReady: A.engine.ready, degraded: A.engine.degraded,
          analyserSum: sum, deckSrc: d ? d.el.src.slice(0, 60) : null,
          deckPaused: d ? d.el.paused : null,
          deckErr: d && d.el.error ? d.el.error.code + ':' + d.el.error.message : null,
          eqBands: A.engine.eqBands.length,
          pitchNode: !!A.engine.pitchNode,
          plugins: A.settings.plugins.enabled.length
        };
      })()`);

      // 过渡、模式、主题、插件、EQ 冒烟
      smokePhase('features');
      smoke.features = await evalJs(`(async () => {
        const A = window.App;
        const out = { themes: [], transitions: [], errors: [] };
        for (const th of (window.AURORA_DEFAULTS.THEMES || [])) {
          try { await A.saveSettings({ theme: th.id }, { rerender: true }); out.themes.push(th.id + ':ok'); }
          catch (e) { out.themes.push(th.id + ':ERR ' + e.message); }
        }
        await A.saveSettings({ theme: 'glass' }, { rerender: true });
        for (const tr of (window.AURORA_TRANSITIONS ? Object.keys(window.AURORA_TRANSITIONS) : [])) {
          try { await A.player.next({ transition: tr }); await new Promise(r => setTimeout(r, 900)); out.transitions.push(tr + ':pos=' + A.engine.position().toFixed(1)); }
          catch (e) { out.transitions.push(tr + ':ERR ' + e.message); }
        }
        try { A.player.setMode('shuffle'); A.player.setMode('repeat-one'); A.player.setMode('repeat-all'); A.player.setMode('sequential'); out.modes = 'ok'; } catch (e) { out.modes = 'ERR ' + e.message; }
        try { A.setEq({ enabled: true, bands: [6,4,2,0,-2,0,2,4,5,6], preamp: 2 }); out.eq = 'ok'; } catch (e) { out.eq = 'ERR ' + e.message; }
        try { A.setRate(1.25); A.setPitch(3); out.ratePitch = A.engine.rate + '/' + A.engine.pitchSemis; A.setRate(1); A.setPitch(0); } catch (e) { out.ratePitch = 'ERR ' + e.message; }
        try {
          const first = (A.settings.plugins.installed || [])[0];
          if (first) { await A.togglePlugin(first.id, true); out.plugin = first.id + ':on'; await A.togglePlugin(first.id, false); }
        } catch (e) { out.plugin = 'ERR ' + e.message; }
        try { A.setView('stats'); await new Promise(r => setTimeout(r, 400)); A.setView('eq'); await new Promise(r => setTimeout(r, 250)); A.setView('plugins'); await new Promise(r => setTimeout(r, 250)); A.setView('settings'); await new Promise(r => setTimeout(r, 400)); A.setView('now'); await new Promise(r => setTimeout(r, 400)); A.setView('playlists'); await new Promise(r => setTimeout(r, 250)); A.setView('library'); out.views = 'ok'; }
        catch (e) { out.views = 'ERR ' + e.message; }
        out.runtimeErrors = window.__auroraErrors || [];
        return out;
      })()`);

      // 侧栏导航与按钮接线（回归测试：早期版本这里忘了绑定点击事件）
      smokePhase('sidebar');
      smoke.sidebar = await evalJs(`(async () => {
        const A = window.App;
        const out = { nav: [], errors: [] };
        const items = Array.from(document.querySelectorAll('.nav-item[data-view]'));
        out.navItemCount = items.length;
        for (const el of items) {
          const want = el.dataset.view;
          try {
            el.click();
            await new Promise(r => setTimeout(r, 130));
            const root = document.getElementById('viewRoot');
            const viewOk = want === 'playlists' ? (A.state.view === 'playlists' || A.state.view === 'playlist') : A.state.view === want;
            out.nav.push({ view: want, ok: viewOk && !!root && root.children.length > 0, actual: A.state.view, nodes: root ? root.children.length : -1 });
          } catch (e) { out.nav.push({ view: want, ok: false, err: String((e && e.message) || e) }); }
        }
        A.setView('library');
        const origAdd = A.addFolder, origPl = A.createPlaylist;
        let addCalled = false, plCalled = false;
        A.addFolder = () => { addCalled = true; };
        A.createPlaylist = () => { plCalled = true; };
        const addBtn = document.getElementById('addFolder');
        const plBtn = document.getElementById('newPlaylist');
        if (addBtn) addBtn.click(); else out.errors.push('缺少 #addFolder');
        if (plBtn) plBtn.click(); else out.errors.push('缺少 #newPlaylist');
        A.addFolder = origAdd; A.createPlaylist = origPl;
        out.addFolderWired = addCalled;
        out.newPlaylistWired = plCalled;
        out.failed = out.nav.filter(n => !n.ok).map(n => n.view);
        return out;
      })()`);
      if (smoke.sidebar && smoke.sidebar.failed && smoke.sidebar.failed.length) smoke.errors.push('侧栏导航点击无效: ' + smoke.sidebar.failed.join(', '));
      if (smoke.sidebar && !smoke.sidebar.addFolderWired) smoke.errors.push('添加文件夹按钮未接线');
      if (smoke.sidebar && !smoke.sidebar.newPlaylistWired) smoke.errors.push('新建播放列表按钮未接线');

      // 统计写入检查
      smokePhase('stats');
      await sleep(1500);
      const stats = statsStore.get();
      smoke.stats = {
        days: Object.keys(stats.days || {}).length,
        totalMs: (stats.totals || {}).ms || 0,
        trackEntries: Object.keys(stats.tracks || {}).length,
        sample: Object.entries(stats.tracks || {}).slice(0, 3).map(([k, v]) => ({ id: k, ms: v.ms, count: v.count }))
      };
      // 桌面歌词窗口
      smokePhase('lyrics-window');
      try {
        toggleDesktopLyrics(true);
        await sleep(2500);
        smoke.lyricsWindow = {
          created: !!(lyricsWindow && !lyricsWindow.isDestroyed()),
          visible: !!(lyricsWindow && lyricsWindow.isVisible()),
          url: lyricsWindow ? lyricsWindow.webContents.getURL() : null
        };
        const lw = lyricsWindow;
        if (lw) {
          smoke.lyricsWindow.render = await lw.webContents.executeJavaScript(`(() => ({ hasApi: !!window.aurora, lines: (window.__lyLines||0), cur: (document.getElementById('cur')||{}).textContent || '', errs: window.__auroraErrors || [] }))()`).catch((e) => 'eval-fail: ' + e.message);
        }
        toggleDesktopLyrics(false);
      } catch (e) { smoke.errors.push('lyricsWindow: ' + e.message); }
      // 迷你播放器窗口
      try {
        toggleMini(true);
        await sleep(2000);
        smoke.miniWindow = { created: !!(miniWindow && !miniWindow.isDestroyed()), visible: !!(miniWindow && miniWindow.isVisible()) };
        if (miniWindow) smoke.miniWindow.render = await miniWindow.webContents.executeJavaScript(`(() => ({ hasApi: !!window.aurora, title: (document.getElementById('title')||{}).textContent, errs: window.__auroraErrors || [] }))()`).catch((e) => 'eval-fail: ' + e.message);
        toggleMini(false);
      } catch (e) { smoke.errors.push('miniWindow: ' + e.message); }
    } catch (err) {
      smoke.errors.push('smoke-fatal: ' + String(err && err.stack ? err.stack : err));
    }
    smoke.finishedAt = new Date().toISOString();
    smoke.phase = 'done';
    try { fs.writeFileSync(path.join(APP_ROOT, 'smoke-report.json'), JSON.stringify(smoke, null, 2)); } catch { /* ignore */ }
    try { settingsStore.save(); libraryStore.save(); statsStore.save(); } catch { /* ignore */ }
    quitting = true;
    app.exit(smoke.errors.length ? 1 : 0);
  }, 3500);
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */
app.whenReady().then(async () => {
  app.setAppUserModelId('com.aurora.music');
  smokeLog('whenReady');

  // 命令行创建桌面快捷方式（供打包脚本/用户手动调用）： --create-shortcut [--desktop=DIR]
  if (process.argv.includes('--create-shortcut')) {
    const desktopArg = (process.argv.find((a) => a.startsWith('--desktop=')) || '').slice('--desktop='.length);
    const r = createDesktopShortcut(desktopArg ? { desktopDir: desktopArg } : {});
    try {
      fs.writeFileSync(path.join(require('node:os').tmpdir(), 'aurora-shortcut-result.json'), JSON.stringify(r, null, 2));
    } catch { /* ignore */ }
    quitting = true;
    app.exit(r.ok ? 0 : 1);
    return;
  }

  initStores();
  smokeLog('initStores done, dataDir=' + DATA_DIR + ' roots=' + JSON.stringify(settingsStore.get('library.roots')));
  await registerProtocol();
  setupIpc();
  createMainWindow();
  smokeLog('mainWindow created');
  ensureTray();
  registerGlobalShortcuts();

  if (settingsStore.get('lyrics.desktopEnabled', false)) { createLyricsWindow(); }
  if (settingsStore.get('mini.visible', false)) { createMiniWindow(); }

  // 首次运行时在桌面创建快捷方式（方便直接使用）
  if (!settingsStore.get('ui.shortcutCreated', false)) {
    const r = createDesktopShortcut();
    if (r.ok) settingsStore.set('ui.shortcutCreated', true);
    settingsStore.save();
  }

  // 启动时自动扫描（如果配置了曲库且开启自动扫描）
  if (NEEDS_LIBRARY_REBUILD && (settingsStore.get('library.roots', []) || []).length) {
    smokeLog('library rebuild scheduled (meta version changed)');
    setTimeout(() => { doScan(null).catch(() => {}); }, 1200);
  } else if (settingsStore.get('library.autoScan', false)) {
    setTimeout(() => { doScan(null).catch(() => {}); }, 1500);
  }
});

app.on('window-all-closed', () => {
  trace('window-all-closed');
  if (process.platform !== 'darwin') {
    if (!settingsStore?.get('ui.closeToTray', false)) { quitting = true; app.quit(); }
  }
});

app.on('before-quit', () => {
  quitting = true;
  try { settingsStore?.save(); libraryStore?.save(); statsStore?.save(); playlistsStore?.save(); } catch { /* ignore */ }
  try { globalShortcut.unregisterAll(); } catch { /* ignore */ }
});

app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); else showMain(); });

process.on('uncaughtException', (err) => {
  trace('uncaughtException ' + (err && err.stack ? err.stack : err));
  try { console.error('[Aurora] uncaughtException:', err); } catch { /* ignore */ }
});
