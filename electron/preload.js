'use strict';
/**
 * 极光音乐 —— 预加载脚本（contextBridge 安全桥）
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

const listeners = new Map();
function on(channel, cb) {
  const wrapped = (_e, payload) => { try { cb(payload); } catch (err) { console.error(err); } };
  ipcRenderer.on(channel, wrapped);
  listeners.set(cb, { channel, wrapped });
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
    listeners.delete(cb);
  };
}

function mediaUrl(p) {
  return `aurora://local/media?p=${encodeURIComponent(p)}`;
}
function bgUrl(p) {
  return `aurora://local/bg?p=${encodeURIComponent(p)}`;
}
function assetUrl(rel) {
  return `aurora://local/asset/${encodeURIComponent(rel)}`;
}

contextBridge.exposeInMainWorld('aurora', {
  app: {
    info: () => invoke('app:info'),
    minimize: () => invoke('win:minimize'),
    maximize: () => invoke('win:maximize'),
    close: () => invoke('win:close'),
    hide: () => invoke('win:hide'),
    isMaximized: () => invoke('win:isMaximized'),
    setOpacity: (v) => invoke('win:setOpacity', v),
    setSize: (w, h) => invoke('win:setSize', w, h),
    focusMain: () => invoke('win:focusMain'),
    quit: () => invoke('sys:quit'),
    restart: () => invoke('sys:restart'),
    createDesktopShortcut: () => invoke('sys:createDesktopShortcut'),
    openPath: (p) => invoke('sys:openPath', p),
    openExternal: (u) => invoke('sys:openExternal', u),
    showItemInFolder: (p) => invoke('sys:showItemInFolder', p),
    openDataDir: () => invoke('shell:openDataDir'),
    getPathForFile: (file) => {
      try { return webUtils.getPathForFile(file); } catch { return null; }
    },
    mediaUrl, bgUrl, assetUrl
  },
  player: {
    command: (action) => invoke('player:command', action),
    syncMini: (payload) => invoke('mini:sync', payload)
  },
  settings: {
    get: () => invoke('settings:get'),
    set: (k, v) => invoke('settings:set', k, v),
    merge: (patch) => invoke('settings:merge', patch),
    reset: () => invoke('settings:reset')
  },
  library: {
    get: () => invoke('library:get'),
    scan: (roots) => invoke('library:scan', roots),
    pickFolder: () => invoke('library:pickFolder'),
    addRoots: (roots) => invoke('library:addRoots', roots),
    removeRoot: (root) => invoke('library:removeRoot', root),
    updateTrack: (id, patch) => invoke('library:updateTrack', id, patch),
    reorder: (ids) => invoke('library:reorder', ids),
    removeTrack: (id) => invoke('library:removeTrack', id),
    deleteFile: (id) => invoke('library:deleteFile', id),
    showInFolder: (p) => invoke('library:showInFolder', p),
    verify: (ids) => invoke('library:verify', ids),
    covers: { get: (id) => invoke('covers:get', id), stats: () => invoke('covers:stats'), clear: () => invoke('shell:clearCovers') }
  },
  lyrics: {
    find: (track) => invoke('lyrics:find', track),
    import: (id) => invoke('lyrics:import', id),
    saveFor: (name, base64) => invoke('lyrics:saveFor', name, base64),
    list: () => invoke('lyrics:list'),
    // 桌面歌词浮层
    toggleDesktop: (force) => invoke('lyricsWin:toggle', force),
    update: (patch) => invoke('lyricsWin:update', patch),
    setAlwaysOnTop: (on) => invoke('lyricsWin:setAlwaysOnTop', on),
    resetPos: () => invoke('lyricsWin:resetPos'),
    sync: (payload) => invoke('lyricsWin:sync', payload),
    getBounds: () => invoke('lyricsWin:getBounds'),
    // 浮层 / 迷你窗口开窗后主动索要一次同步
    requestSync: () => invoke('overlay:requestSync')
  },
  cover: {
    pickFor: (id) => invoke('cover:pickFor', id)
  },
  // 在线音乐（哔哩哔哩 / 聚合音源，均为公开接口，无需 API Key / 无需服务器）
  online: {
    search: (query, limit) => invoke('online:search', query, limit),
    // 「所有音乐」分栏：QQ音乐 + 酷我 + 网易云 聚合搜索
    searchAll: (query, limit) => invoke('online:searchAll', query, limit),
    // source 省略或为 'bilibili' 时走哔哩哔哩通道。
    // QQ 音乐只给元数据不给直链，所以额外把「歌名 + 歌手 + 时长」编进 q= 参数，
    // 主进程靠它去酷我/网易云匹配同一首歌（这样收藏里的 QQ 歌曲重启后也能播）。
    streamUrl: (videoId, source, hint) => {
      const s = source && source !== 'bilibili' ? `&s=${encodeURIComponent(source)}` : '';
      let extra = '';
      if (source === 'qq' && hint && hint.title) {
        const raw = [hint.title, hint.artist || '', Math.round(Number(hint.duration) || 0)].join('\u0001');
        extra = `&q=${Buffer.from(raw, 'utf8').toString('base64url')}`;
      }
      return `aurora://local/stream?v=${encodeURIComponent(videoId)}${s}${extra}`;
    },
    thumbUrl: (u) => (u ? `aurora://local/thumb?u=${encodeURIComponent(u)}` : ''),
    // 封面地址无法直接拼出来的音源（网易云），交给主进程按 id 解析
    thumbRef: (source, id) => (source && id ? `aurora://local/thumb?s=${encodeURIComponent(source)}&i=${encodeURIComponent(id)}` : ''),
    // 在线收藏（存在 userData/online-favorites.json）
    favorites: () => invoke('online:favorites'),
    saveFavorites: (list) => invoke('online:setFavorites', list)
  },
  debug: {
    windows: () => invoke('debug:windows')
  },
  mini: {
    toggle: (force) => invoke('mini:toggle', force),
    update: (patch) => invoke('mini:update', patch),
    sync: (payload) => invoke('mini:sync', payload)
  },
  stats: {
    add: (entries) => invoke('stats:add', entries),
    summary: () => invoke('stats:summary'),
    raw: () => invoke('stats:raw'),
    reset: () => invoke('stats:reset'),
    exportFile: () => invoke('stats:export')
  },
  playlists: {
    get: () => invoke('playlists:get'),
    save: (list) => invoke('playlists:save', list),
    exportFile: (payload) => invoke('playlists:export', payload)
  },
  plugins: {
    list: () => invoke('plugins:list'),
    setEnabled: (id, on) => invoke('plugins:setEnabled', id, on),
    setParams: (id, p) => invoke('plugins:setParams', id, p),
    importFile: () => invoke('plugins:import'),
    remove: (id) => invoke('plugins:remove', id),
    reset: () => invoke('plugins:reset'),
    openFolder: () => invoke('plugins:openFolder')
  },
  shortcuts: {
    register: () => invoke('shortcuts:register'),
    set: (scope, action, accel) => invoke('shortcuts:set', scope, action, accel),
    reset: () => invoke('shortcuts:reset'),
    listRegistered: () => invoke('shortcuts:listRegistered'),
    setMediaKeys: (on) => invoke('sys:mediaKeys', on)
  },
  dialog: {
    pickImage: () => invoke('dialog:pickImage'),
    pickFiles: (kind) => invoke('dialog:pickFiles', kind),
    saveFile: (opts) => invoke('dialog:saveFile', opts),
    writeText: (p, t) => invoke('fs:writeText', p, t)
  },
  on,
  send: (channel, payload) => {
    const allowed = [];
    if (allowed.includes(channel)) ipcRenderer.send(channel, payload);
  }
});
