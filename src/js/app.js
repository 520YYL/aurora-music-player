/**
 * Aurora 极光音乐 —— 应用主控（状态、事件、视图调度、快捷键、歌词同步）
 */
(function () {
  'use strict';
  const U = window.U;
  const { $, $$, ce } = U;
  const D = window.AURORA_DEFAULTS;
  const api = window.aurora;

  const App = {
    settings: null,
    player: null,
    engine: null,
    lyrics: null,
    sortable: null,
    viz: null,
    miniEq: null,
    state: {
      view: 'library',
      tracks: [],
      search: '',
      sortKey: 'manual',
      sortDir: 'asc',
      viewMode: 'list',
      selection: new Set(),
      lastClickedId: null,
      playlists: [],
      playlistId: null,
      stats: {},
      appInfo: null,
      coverStats: null,
      settings: null
    }
  };
  window.App = App;

  /* ================================ 初始化 ================================ */
  async function boot() {
    App.state.appInfo = await api.app.info();
    App.settings = await api.settings.get();
    App.state.settings = App.settings;
    App.state.stats = await api.stats.summary();
    const lib = await api.library.get();
    App.state.tracks = lib.tracks || [];
    App.state.playlists = await api.playlists.get();
    App.settings.__dataDir = App.state.appInfo.dataDir;

    // 从设置恢复 UI 状态
    App.state.view = App.settings.ui.lastView || 'library';
    if (App.state.view === 'now') App.state.view = 'library';
    App.state.sortKey = App.settings.ui.sortKey || 'manual';
    App.state.sortDir = App.settings.ui.sortDir || 'asc';
    App.state.viewMode = App.settings.ui.viewMode || 'list';

    buildEngine();
    applySettingsToDom();
    wireTitlebar();
    wireSidebar();
    wirePlayerBar();
    wireSearch();
    wireShortcuts();
    wireIpcEvents();
    wireFloatPanel();
    wireDropImport();

    await ensurePlugins();
    App.render();
    updateCounts();
    updateNowPlayingUi();

    // 把上次退出时听的那首歌装回播放器，这样重开就能直接点播放接着听
    await App.restoreLastPlayback();
    App._lastPlaybackTimer = setInterval(saveLastPlayback, 4000);

    if (!App.state.tracks.length) {
      setTimeout(() => { if (!App.state.tracks.length) startScan(); }, 600);
    }

    api.stats.summary().then((s) => { App.state.stats = s; if (App.state.view === 'stats') App.render(); });
    api.library.covers.stats().then((c) => { App.state.coverStats = c; });

    // 定时刷新统计视图
    setInterval(async () => {
      if (App.state.view === 'stats') {
        App.state.stats = await api.stats.summary();
        App.render();
      }
    }, 30000);
  }

  function buildEngine() {
    App.player = new window.Player(new window.AudioEngine({}));
    App.engine = App.player.engine;
    App.lyrics = new window.Lyrics.LyricsController({
      onChange: () => { if (App.state.view === 'now') renderLyricsBox(); syncOverlays(); }
    });
    App.player.applySettings(App.settings);

    App.player.on('track', ({ track }) => {
      updateNowPlayingUi();
      loadLyricsFor(track);
      syncOverlays(true);   // 切歌立刻把新歌词推到桌面歌词窗，别等下一次 250ms 轮询
      saveLastPlayback();   // 切歌立刻记下来，避免退出时来不及写
      if (App.state.view === 'library') markPlayingRow();
      // 正在播放页是整页快照：切歌时必须重绘，否则封面/标题/累计会一直停在上一首
      if (App.state.view === 'now') App.render();
      syncOverlays();
    });
    App.player.on('state', () => { updatePlayButton(); syncOverlays(); });
    App.player.on('time', () => { lastPos.id = App.player.current ? App.player.current.id : null; lastPos.pos = App.engine.position(); updateProgress(); });
    App.player.on('mode', () => { updateModeButton(); syncOverlays(); });
    App.player.on('deck', (e) => {
      if (e.type !== 'error' || !e.deck) return;
      const t = e.deck.track;
      if (!t) return;
      const isActive = App.engine.active === e.deck.index;
      const isCurrent = !!(App.player.current && t.id === App.player.current.id);
      // 记录所有解码器报错（便于自检与排查）
      (window.__auroraDeckErrors = window.__auroraDeckErrors || []).push({
        at: Date.now(), deck: e.deck.index, code: e.errorCode, msg: e.error,
        track: t.title || t.name, isActive, isCurrent
      });
      // 只有「当前正在播放的那一路 + 仍然是当前这首歌 + 不是切源导致的中断」
      // 才算真正的播放失败。否则旧解码器被换源/停止时的报错会把用户刚点的歌顶掉。
      if (!isActive || !isCurrent) return;
      if (e.errorCode === 1) return;   // MEDIA_ERR_ABORTED：切换音源时的正常中断
      // 播放中途出错（例如 seek 失败）不应该直接跳歌，那会把用户正在听的歌顶掉；
      // 只有「一开始就播不出来」才自动跳过。
      const pos = App.engine.position();
      if (pos > 1.5) {
        U.toast(`「${t.title || t.name}」播放出错（${e.error || '未知原因'}），已停在当前位置`, 'err', 4000);
        return;
      }
      U.toast(`无法播放：${t.title || t.name}`, 'err');
      setTimeout(() => App.player.next(), 800);
    });
  }

  /* ================================ 设置应用 ================================ */
  function applySettingsToDom() {
    const s = App.settings;
    const html = document.documentElement;
    html.dataset.theme = s.theme || 'glass';
    html.style.setProperty('--accent', s.accent);
    html.style.setProperty('--accent2', s.accent2);
    const radius = s.theme === 'flat' ? Math.min(8, s.radius) : (s.theme === 'neumorph' ? Math.max(16, s.radius) : s.radius);
    html.style.setProperty('--radius', `${radius}px`);
    if (s.fontFamily) html.style.setProperty('--font', s.fontFamily);
    document.body.className = `density-${s.density || 'cozy'}`;

    const bg = s.background || {};
    const layer = $('#bg-layer');
    const dim = $('#bg-dim');
    const anim = $('#bg-anim');
    layer.style.opacity = '0';
    if (bg.type === 'image' && bg.value) {
      layer.style.backgroundImage = `url("${api.app.bgUrl(bg.value)}")`;
      layer.style.backgroundSize = bg.fit || 'cover';
      layer.style.filter = `blur(${bg.blur || 0}px) saturate(${bg.saturate || 1})`;
      layer.style.opacity = '1';
      anim.classList.add('hidden');
    } else if (bg.type === 'color' && bg.value) {
      layer.style.backgroundImage = 'none';
      document.body.style.background = bg.value;
      layer.style.opacity = '0';
      anim.classList.add('hidden');
    } else if (bg.type === 'none') {
      layer.style.backgroundImage = 'none';
      layer.style.opacity = '0';
      anim.classList.add('hidden');
    } else {
      layer.style.backgroundImage = 'none';
      layer.style.opacity = '0';
      document.body.style.background = '';
      anim.classList.toggle('hidden', s.animatedBg === false);
    }
    dim.style.opacity = bg.type === 'image' ? String(bg.dim || 0) : '0';

    // 音量条 / 进度条初始
    const vol = $('#volume');
    vol.value = String(Math.round((s.playback.volume || 0.8) * 100));
    vol.style.setProperty('--fill', `${vol.value}%`);
    updateModeButton();
    updatePlayButton();
    updateRateButton();
    updateQuickButtons();
  }

  async function saveSettings(patch, opts = {}) {
    App.settings = await api.settings.merge(patch);
    App.state.settings = App.settings;
    App.settings.__dataDir = App.state.appInfo ? App.state.appInfo.dataDir : '';
    applySettingsToDom();
    App.player.applySettings(App.settings);
    if (opts.rerender === true && ['settings', 'eq', 'plugins'].includes(App.state.view)) App.render();
    syncOverlays();
    return App.settings;
  }
  App.saveSettings = saveSettings;

  /* ================================ 上次播放 ================================ */
  /**
   * 记住「上次在听哪首、听到哪」。
   * 存到 settings._lastPlayback；下划线开头，设置页不展示。
   * 与 playback.rememberPosition 互不影响：那个是「续播到上次位置」的可选项，
   * 这个只负责把歌装回播放器，让重开软件后直接点播放就能接着听。
   *
   * 触发点：切歌（player 的 track 事件）、每 4 秒定时、以及退出前。
   * 注意「只加载不播放」的恢复路径不会触发 track 事件，所以恢复完成后要手动存一次。
   */
  const lastPos = { id: null, pos: 0 };

  function saveLastPlayback() {
    if (App._quitting) return;
    const t = App.player.current;
    if (!t || !t.id) return;
    // 用节流缓存的位置：它由播放器的 time 事件持续更新，比直接读引擎更可靠
    const pos = lastPos.id === t.id ? lastPos.pos : App.engine.position();
    // 太靠前或已经放完的位置没意义，记 0 就行
    const dur = App.engine.duration();
    const keep = Number.isFinite(pos) && pos > 1 && (!dur || pos < dur - 3) ? Math.round(pos * 10) / 10 : 0;
    const next = { id: t.id, position: keep, at: Date.now() };
    const prev = App.settings._lastPlayback;
    // 同一首歌、位置差不到 2 秒就不重复写盘
    if (prev && prev.id === next.id && Math.abs((prev.position || 0) - keep) < 2) return;
    App.settings._lastPlayback = next;
    api.settings.set('_lastPlayback', next);
  }

  /**
   * 启动时把上次那首歌装回播放器。
   * 只加载不自动播放：Electron 在「用户没交互过」时 play() 可能被拦，
   * 静默失败反而让人以为坏了；留一首已就绪的歌，点一下播放即可。
   */
  App.restoreLastPlayback = async function () {
    const last = App.settings._lastPlayback;
    if (!last || !last.id) return null;
    const track = App.state.tracks.find((t) => t.id === last.id);
    if (!track) {
      // 歌已经从曲库里没了（删了文件/移除了目录）：清掉记录，免得每次启动都白找
      App.settings._lastPlayback = null;
      api.settings.set('_lastPlayback', null);
      return null;
    }
    const list = App.visibleTracks();
    const inList = list.some((t) => t.id === track.id);
    const queue = inList ? list : App.state.tracks.slice();
    const idx = Math.max(0, queue.findIndex((t) => t.id === track.id));

    // 用 autoplay:false 装队列 —— 这不会触发 player 的 track 事件，
    // 所以下面必须自己把引擎、界面、记录都对齐，否则界面显示「未播放」而队列却指向这首歌。
    App.player.setQueue(queue, idx, { autoplay: false });
    await App.engine.ensure();
    App.engine.setSource(track, App.engine.active);
    App.player.current = track;
    App.engine.currentTrackId = track.id;
    App.player.index = idx;

    const pos = Number(last.position) || 0;
    if (pos > 1) App.engine.seek(pos, App.engine.active);
    lastPos.id = track.id;
    lastPos.pos = pos > 1 ? pos : 0;

    // 元数据到位后再对齐一次位置（刚 setSource 时 duration 还是 0，seek 可能被丢掉）
    if (pos > 1) {
      const seekWhenReady = (tries = 0) => {
        if (App.player.current && App.player.current.id !== track.id) return;
        if (App.engine.duration() > 0 || tries > 12) { App.player.seek(pos); updateProgress(); return; }
        setTimeout(() => seekWhenReady(tries + 1), 250);
      };
      setTimeout(seekWhenReady, 300);
    }

    updateNowPlayingUi();
    App.render();
    saveLastPlayback();
    U.toast(`已载入上次播放：${track.title || track.name}${pos > 2 ? ` · ${U.fmtTime(pos)}` : ''}`, 'ok', 2600);
    return track;
  };

  /* ================================ 视图调度 ================================ */
  App.visibleTracks = function visibleTracks() {
    let list = App.state.tracks.slice();
    const q = App.state.search.trim().toLowerCase();
    if (App.state.view === 'favorites') list = list.filter((t) => t.favorite);
    else if (App.state.view === 'recent') list = list.filter((t) => t.lastPlayedAt > 0).sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0));
    else if (App.state.view === 'playlist') {
      const pl = App.state.playlists.find((p) => p.id === App.state.playlistId);
      const ids = new Set(pl ? pl.ids || [] : []);
      list = list.filter((t) => ids.has(t.id));
      if (pl && pl.order) {
        const pos = new Map(pl.order.map((id, i) => [id, i]));
        list.sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
      }
    }
    if (q) {
      list = list.filter((t) => `${t.title} ${t.artist} ${t.album} ${t.format} ${t.name}`.toLowerCase().includes(q));
    }
    const key = App.state.sortKey;
    if (key && key !== 'manual') {
      const dir = App.state.sortDir === 'desc' ? -1 : 1;
      list.sort((a, b) => {
        let va = a[key]; let vb = b[key];
        if (key === 'playedMs') { va = App.trackPlayedMs(a.id); vb = App.trackPlayedMs(b.id); }
        if (typeof va === 'string' || typeof vb === 'string') {
          va = String(va || ''); vb = String(vb || '');
          return va.localeCompare(vb, 'zh-Hans-CN') * dir;
        }
        return ((va || 0) - (vb || 0)) * dir;
      });
    }
    return list;
  };

  App.currentPlaylistName = function () {
    const pl = App.state.playlists.find((p) => p.id === App.state.playlistId);
    return pl ? pl.name : '播放列表';
  };

  App.trackPlayedMs = function (id) {
    const s = App.state.stats || {};
    return (s.tracks && s.tracks[id] && s.tracks[id].ms) || 0;
  };

  /**
   * 实时累计听歌时长 = 已落盘的部分 + 本次还没写入磁盘的部分。
   * 统计每 5 秒才写一次磁盘，所以直接读 trackPlayedMs 会「卡住不动」。
   */
  App.trackLivePlayedMs = function (id) {
    const base = App.trackPlayedMs(id);
    const p = App.player;
    const pending = p && p.current && p.current.id === id ? (p._pendingMs || 0) : 0;
    return base + pending;
  };

  App.render = function render() {
    const host = $('#viewRoot');
    if (!host) return;
    const scrollTop = (host.querySelector('.view-body') || {}).scrollTop || 0;
    host.innerHTML = '';
    let el;
    switch (App.state.view) {
      case 'now': el = window.Views.nowPlaying(App); break;
      case 'subtitle': el = window.Views.subtitle(App); break;
      case 'playlists': el = window.Views.playlists(App); break;
      case 'stats': el = window.Panels.stats(App); break;
      case 'eq': el = window.Panels.eq(App); break;
      case 'plugins': el = window.Panels.plugins(App); break;
      case 'settings': el = window.Panels.settings(App); break;
      default: el = window.Views.library(App);
    }
    el.classList.remove('fade-in');
    host.appendChild(el);
    const vb = host.querySelector('.view-body');
    if (vb && scrollTop) vb.scrollTop = scrollTop;
    $$('.nav-item[data-view]').forEach((n) => n.classList.toggle('active', n.dataset.view === App.state.view || (App.state.view === 'playlist' && n.dataset.view === 'playlists')));
    const subBtn = $('#btnSubtitle');
    if (subBtn) subBtn.classList.toggle('fav-on', App.state.view === 'subtitle');
    updateCounts();
    if (App.state.view === 'now') renderLyricsBox();
  };

  App.setView = function (v) {
    App.state.view = v;
    App.settings.ui.lastView = v;
    api.settings.set('ui.lastView', v);
    App.render();
  };

  /** 字幕 / 放映模式开关（Ctrl+Space，可在设置里改） */
  App.toggleSubtitle = function (force) {
    const to = typeof force === 'boolean' ? force : App.state.view !== 'subtitle';
    App.setView(to ? 'subtitle' : 'now');
    return to;
  };

  function renderLyricsBox() {
    const box = $('#lyricsBox');
    if (!box) return;
    window.Lyrics.renderTo(box, App.lyrics, { onSeek: (s) => App.player.seek(s) });
    window.Lyrics.scrollToActive(box, false);
  }

  function updateCounts() {
    const all = App.state.tracks;
    $('#cntAll').textContent = String(all.length);
    $('#cntFav').textContent = String(all.filter((t) => t.favorite).length);
    $('#cntPl').textContent = String(App.state.playlists.length);

    // 侧栏根目录
    const box = $('#rootsList');
    box.innerHTML = '';
    for (const r of App.settings.library.roots || []) {
      const name = r.split(/[\\/]/).filter(Boolean).pop() || r;
      box.appendChild(ce('div', { class: 'nav-item', title: r, onclick: () => App.rescan(r) }, [
        ce('span', { class: 'ic', text: '📁' }),
        ce('span', { class: 'grow ellipsis', style: { fontSize: '12.5px' }, text: name }),
        ce('span', { class: 'del', text: '✕', title: '移除', onclick: (e) => { e.stopPropagation(); App.removeRoot(r); } })
      ]));
    }
    // 播放列表
    const plBox = $('#playlistNav');
    plBox.innerHTML = '';
    for (const pl of App.state.playlists) {
      plBox.appendChild(ce('div', {
        class: `nav-item${App.state.view === 'playlist' && App.state.playlistId === pl.id ? ' active' : ''}`,
        onclick: () => App.openPlaylist(pl.id),
        oncontextmenu: (e) => App.playlistContextMenu(e, pl)
      }, [
        ce('span', { class: 'ic', text: '🎵' }),
        ce('span', { class: 'grow ellipsis', style: { fontSize: '12.5px' }, text: pl.name }),
        ce('span', { class: 'count', text: String((pl.ids || []).length) })
      ]));
    }
  }

  /* ================================ 播放 ================================ */
  App.playTrackInList = function (track) {
    const list = App.visibleTracks();
    App.player.setQueue(list, Math.max(0, list.findIndex((t) => t.id === track.id)));
  };

  App.playTrack = async function (track) {
    if (!App.state.tracks.some((t) => t.id === track.id)) App.state.tracks.push(track);
    const inQueue = App.player.queue.some((t) => t.id === track.id);
    if (inQueue) await App.player.playById(track.id);
    else App.playTrackInList(track);
  };

  App.playAll = function () {
    const list = App.visibleTracks();
    if (!list.length) return;
    App.player.setQueue(list, 0);
  };

  App.toggleFavorite = async function (id) {
    const t = App.state.tracks.find((x) => x.id === id);
    if (!t) return;
    t.favorite = !t.favorite;
    await api.library.updateTrack(id, { favorite: t.favorite });
    if (App.player.current && App.player.current.id === id) {
      App.player.current.favorite = t.favorite;
      updateFavButton();
    }
    if (App.state.view === 'favorites') {
      App.render();                       // 收藏页需要让这一行消失
    } else {
      // 其它页面只改这一行的 ♥，不重建整个列表（避免闪烁）
      const row = document.querySelector(`.track-row[data-id="${id}"]`);
      if (row) {
        const fav = row.querySelector('.t-actions button');
        if (fav) { fav.textContent = t.favorite ? '♥' : '♡'; fav.classList.toggle('fav-on', !!t.favorite); }
      }
      updateCounts();
    }
    U.toast(t.favorite ? '已加入收藏 ♥' : '已取消收藏', 'ok', 1400);
  };

  function markPlayingRow() {
    const cur = App.player.current;
    $$('.track-row').forEach((r) => r.classList.toggle('playing', !!cur && r.dataset.id === cur.id));
  }

  /* ================================ 封面 ================================ */
  /**
   * 手动给歌曲设置封面。
   * 作用对象：优先「当前选中的那一首」，没有选中就作用于「正在播放的那首」。
   */
  App.setTrackCover = async function (explicitId) {
    let id = explicitId;
    if (!id) {
      if (App.state.selection.size === 1) id = Array.from(App.state.selection)[0];
      else if (App.state.selection.size > 1) { U.toast(`已选中 ${App.state.selection.size} 首，请只选一首再换封面`, 'err'); return; }
      else if (App.player.current) id = App.player.current.id;
    }
    if (!id) { U.toast('请先选中一首歌，或播放一首歌', 'err'); return; }
    const track = App.state.tracks.find((t) => t.id === id);
    if (!track) { U.toast('未找到这首歌', 'err'); return; }

    const r = await api.cover.pickFor(id);
    if (!r || r.canceled) return;
    if (!r.ok) { U.toast('设置封面失败：' + (r.error || '未知错误'), 'err', 5000); return; }

    // 同一个 URL 会被 Chromium 缓存，换封面后必须让 URL 变一下，否则看到的还是旧图
    U.bumpCover(id);
    track.hasCover = true;
    track.coverCustom = true;
    if (App.player.current && App.player.current.id === id) App.player.current.hasCover = true;

    updateNowPlayingUi();
    App.render();
    U.toast(`封面已更新（原图 ${r.sourceSize}）`, 'ok', 3000);
  };

  /* ================================ 歌词 ================================ */
  async function loadLyricsFor(track) {
    await App.lyrics.loadFor(track);
    if (App.state.view === 'now') renderLyricsBox();
    syncOverlays();
  }

  App.reloadLyrics = async function () {
    if (!App.player.current) return;
    await App.lyrics.loadFor(App.player.current);
    renderLyricsBox();
    U.toast(App.lyrics.lines.length ? `已载入 ${App.lyrics.lines.length} 行歌词` : '没有找到歌词文件', App.lyrics.lines.length ? 'ok' : 'err');
  };

  App.importLyrics = async function () {
    if (!App.player.current) { U.toast('请先播放一首歌', 'err'); return; }
    const res = await api.lyrics.import(App.player.current.id);
    if (res.canceled) return;
    if (res.error) { U.toast('导入失败：' + res.error, 'err'); return; }
    const text = window.Lyrics.decodeBuffer(res.base64);
    App.lyrics.setText(text, res.path);
    renderLyricsBox();
    U.toast('歌词已导入', 'ok');
  };

  App.editLyrics = function () {
    const track = App.player.current;
    const ta = ce('textarea', { style: { width: '100%', height: '340px', fontFamily: 'var(--mono)', fontSize: '12.5px', lineHeight: '1.6' }, spellcheck: 'false' });
    ta.value = App.lyrics.raw || '';
    const box = ce('div', {}, [
      ce('div', { class: 'muted', style: { fontSize: '12px', marginBottom: '8px' }, html: '格式：<span class="mono">[mm:ss.xx]歌词内容</span>，支持中英双语（同一时间点两行会自动合并为主行 + 翻译）。' }),
      ta
    ]);
    const save = ce('button', {
      class: 'btn primary', text: '保存到歌词目录',
      onclick: async () => {
        const name = `${(track && (track.artist ? track.artist + ' - ' : '') + (track.title || track.name || 'lyrics'))}.lrc`;
        const b64 = btoa(unescape(encodeURIComponent(ta.value)));
        const r = await api.lyrics.saveFor(name, b64);
        if (r.ok) {
          App.lyrics.setText(ta.value, r.path);
          renderLyricsBox();
          U.toast('歌词已保存', 'ok');
          m.close();
        } else U.toast('保存失败：' + r.error, 'err');
      }
    });
    const apply = ce('button', {
      class: 'btn', text: '仅本次应用',
      onclick: () => { App.lyrics.setText(ta.value); renderLyricsBox(); m.close(); }
    });
    const m = U.modal('编辑歌词', track ? `${track.title || track.name}` : '', box, [apply, save]);
  };

  const DESKTOP_SYNC_MS = 250;      // 桌面歌词窗的目标刷新率（4Hz）
  const DESKTOP_FULL_MS = 2000;     // 歌词全文的兜底重发间隔
  const SPEC_BARS = 40;             // 推给浮层的频谱柱数
  let _lastDesktopSync = 0;
  let _lastDesktopLinesKey = '';
  let _lastDesktopFullAt = 0;

  /**
   * 把 analyser 的频谱降采样成几十根柱子推给浮层。
   * 低频分辨率按指数分布加密（低频 bin 本来就少，线性取样会让低频柱几乎不动），
   * 每根柱子取区间平均，避免柱子乱跳。
   */
  function downsampledSpectrum(bars) {
    const data = App.engine.frequencyData();
    if (!data || !data.length) return null;
    const out = new Array(bars);
    const N = data.length;
    const start = 1;
    const usable = Math.max(1, Math.floor(N * 0.72));   // 高频基本是空的，别浪费柱子
    const gain = 1.05 * (Number(App.settings.lyrics && App.settings.lyrics.specGain) || 1);
    for (let i = 0; i < bars; i++) {
      let a = start + Math.pow(i / bars, 1.9) * (usable - start);
      let b = start + Math.pow((i + 1) / bars, 1.9) * (usable - start);
      a = Math.max(start, Math.min(N - 1, Math.floor(a)));
      b = Math.max(a + 1, Math.min(N, Math.ceil(b)));
      let sum = 0;
      for (let k = a; k < b; k++) sum += data[k];
      out[i] = Math.min(1, (sum / (b - a) / 255) * gain);
    }
    return out;
  }

  /** 低频/整体能量，用来驱动封面脉动与光晕强度 */
  function spectrumEnergy(spec) {
    if (!spec) return { bass: 0, level: 0 };
    const n = spec.length;
    let bass = 0;
    const bn = Math.max(1, Math.round(n * 0.28));
    for (let i = 0; i < bn; i++) bass += spec[i];
    bass /= bn;
    let level = 0;
    for (let i = 0; i < n; i++) level += spec[i];
    level /= n;
    return { bass, level };
  }

  /**
   * 桌面歌词窗的同步。
   * 与迷你播放器分开：歌词正文有 1~2KB，没必要每 250ms 都在 IPC 上传一遍，
   * 只在「歌词整体变了」时带上，平时只发进度。
   *
   * 但「变了才发」单独用会漏：浮层窗口可能在歌词推过之后才被创建（或用户重开），
   * 它就永远等不到正文，一直显示「暂无歌词」。所以再加一条兜底：
   * 每隔 DESKTOP_FULL_MS 无条件带一次全文，让任何时刻新建的窗口都能在两秒内补齐。
   * （这条 bug 我踩过一次，自检也没抓到——因为自检场景里窗口早就存在了。）
   */
  function syncDesktopLyrics() {
    const st = App.player.state();
    const t = st.current;
    const key = `${App.lyrics.lines.length}|${App.lyrics.sourcePath || ''}|${App.lyrics.title || ''}`;
    const now = performance.now();
    const keyChanged = key !== _lastDesktopLinesKey;
    const dueFull = now - _lastDesktopFullAt >= DESKTOP_FULL_MS;
    const payload = {
      title: t ? (t.title || t.name) : '',
      artist: t ? (t.artist || '') : '',
      album: t ? (t.album || '') : '',
      hasCover: !!(t && t.hasCover),
      coverId: t ? t.id : null,
      playing: st.playing,
      position: st.position,
      duration: st.duration,
      // 播放速率：桌面歌词窗用它把位置在两次同步之间往前插值，
      // 否则逐字光带只能跟着 4Hz 的同步一跳一跳地走（看着帧率很低）
      rate: App.engine.rate,
      mode: st.mode,
      lyricIndex: App.lyrics.current,
      lyricProgress: App.lyrics.progress(st.position),
      settings: { theme: App.settings.theme, lyrics: App.settings.lyrics },
      degraded: st.degraded
    };

    // 频谱：只在浮层开着「节奏」效果时才推，省掉无用的 IPC
    const lyrCfg = App.settings.lyrics || {};
    if (lyrCfg.specStyle && lyrCfg.specStyle !== 'none') {
      const spec = downsampledSpectrum(SPEC_BARS);
      if (spec) {
        const e = spectrumEnergy(spec);
        payload.spec = spec.join(',');
        payload.bass = Math.round(e.bass * 100) / 100;
        payload.level = Math.round(e.level * 100) / 100;
      }
    }
    if (keyChanged || dueFull) {
      _lastDesktopLinesKey = key;
      _lastDesktopFullAt = now;
      payload.lyricVersion = key;
      payload.lines = App.lyrics.lines.map((l) => ({ t: l.t, text: l.text, tr: l.tr, isCJK: l.isCJK }));
    }
    api.lyrics.sync(payload).catch(() => {});
  }

  function syncOverlays(force) {
    const st = App.player.state();
    const t = st.current;
    // 歌词正文每次都带上：浮层/迷你窗口可能是在歌词载入「之后」才被创建的，
    // 只发一次的 full 消息会丢掉，导致它们永远显示「暂无歌词」。
    // 37 行歌词约 1~2KB，4Hz 的同步量可以忽略。
    const lines = App.lyrics.lines.map((l) => ({ t: l.t, text: l.text, tr: l.tr, isCJK: l.isCJK }));
    const payload = {
      full: true,
      lyricVersion: App.lyrics.sourcePath || App.lyrics.title || '',
      title: t ? (t.title || t.name) : '',
      artist: t ? (t.artist || '') : '',
      album: t ? (t.album || '') : '',
      hasCover: !!(t && t.hasCover),
      coverId: t ? t.id : null,
      playing: st.playing,
      position: st.position,
      duration: st.duration,
      mode: st.mode,
      lyricIndex: App.lyrics.current,
      lyricProgress: App.lyrics.progress(st.position),
      lines,
      settings: { mini: App.settings.mini },
      degraded: st.degraded
    };
    api.player.syncMini(payload).catch(() => {});

    // 桌面歌词：限频到 4Hz，其余情况（切歌、改设置）用 force 立刻推一次
    const now = performance.now();
    if (force || now - _lastDesktopSync >= DESKTOP_SYNC_MS) {
      _lastDesktopSync = now;
      syncDesktopLyrics();
    }
  }

  // 桌面歌词开关（独立置顶浮层，可在设置里改快捷键）
  App.toggleDesktopLyrics = async function (force) {
    const cur = !!(App.settings.lyrics && App.settings.lyrics.desktopEnabled);
    let next;
    // 主进程的 toggle 只认调用时的状态，为了幂等这里自己算目标值再传过去
    if (typeof force === 'boolean') next = force;
    else next = !cur;
    const r = await api.lyrics.toggleDesktop(next);
    const enabled = !!(r && typeof r.enabled === 'boolean' ? r.enabled : next);
    App.settings.lyrics = { ...(App.settings.lyrics || {}), desktopEnabled: enabled };
    updateQuickButtons();
    syncOverlays(true);
    U.toast(enabled ? '桌面歌词已开启' : '桌面歌词已关闭', 'ok', 1400);
    return enabled;
  };

  /* ================================ 标题栏 / 搜索 ================================ */
  function wireTitlebar() {
    $('#winMin').onclick = () => api.app.minimize();
    $('#winMax').onclick = () => api.app.maximize();
    $('#winClose').onclick = () => api.app.close();
    const sub = $('#btnSubtitle');
    if (sub) sub.onclick = () => App.toggleSubtitle();
    const dl = $('#btnDesktopLyrics');
    if (dl) dl.onclick = () => App.toggleDesktopLyrics();
  }

  /** 左侧导航栏 + 「添加文件夹」/「新建播放列表」按钮 */
  function wireSidebar() {
    $$('.nav-item[data-view]').forEach((item) => {
      const view = item.dataset.view;
      item.onclick = () => {
        if (view === 'playlists') {
          if (App.state.playlistId) App.openPlaylist(App.state.playlistId);
          else App.setView('playlists');
          return;
        }
        App.setView(view);
      };
    });
    const add = $('#addFolder');
    if (add) {
      add.onclick = (e) => { e.stopPropagation(); App.addFolder(); };
      add.style.cursor = 'pointer';
    }
    const np = $('#newPlaylist');
    if (np) {
      np.onclick = (e) => { e.stopPropagation(); App.createPlaylist(); };
      np.style.cursor = 'pointer';
    }
  }

  function wireSearch() {
    const inp = $('#search');
    const clear = $('#searchClear');
    inp.addEventListener('input', U.debounce(() => {
      App.state.search = inp.value;
      clear.classList.toggle('hidden', !inp.value);
      if (!['library', 'favorites', 'recent', 'playlist'].includes(App.state.view)) App.setView('library');
      else App.render();
    }, 160));
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { inp.value = ''; App.state.search = ''; clear.classList.add('hidden'); App.render(); inp.blur(); }
    });
    clear.onclick = () => { inp.value = ''; App.state.search = ''; clear.classList.add('hidden'); App.render(); };
  }

  /* ================================ 播放栏 ================================ */
  function wirePlayerBar() {
    $('#btnPlay').onclick = () => App.player.toggle();
    $('#btnNext').onclick = () => App.player.next();
    $('#btnPrev').onclick = () => App.player.prev();
    $('#btnShuffle').onclick = () => App.player.setMode(App.player.mode === 'shuffle' ? 'sequential' : 'shuffle');
    $('#btnRepeat').onclick = () => App.player.cycleMode();
    $('#btnFav').onclick = () => { if (App.player.current) App.toggleFavorite(App.player.current.id); };
    $('#npCover').onclick = () => App.setView('now');
    $('#btnMute').onclick = () => setMuted(!App.engine.muted);
    $('#btnEqQuick').onclick = () => App.setView('eq');
    $('#btnPluginQuick').onclick = () => App.setView('plugins');
    $('#btnMini').onclick = () => api.mini.toggle();
    $('#btnVisualizer').onclick = () => toggleFloatPanel();
    $('#btnRate').onclick = (e) => openRatePopover(e.currentTarget);
    $('#btnTransition').onclick = (e) => openTransitionPopover(e.currentTarget);

    const vol = $('#volume');
    vol.addEventListener('input', () => { setVolume(Number(vol.value) / 100); });

    // 进度条
    const pbar = $('#pbar');
    const seekTo = (e) => {
      const r = pbar.getBoundingClientRect();
      const ratio = U.clamp((e.clientX - r.left) / r.width, 0, 1);
      const dur = App.engine.duration();
      if (dur) { App.player._scrubbing = false; App.player.seek(ratio * dur); updateProgress(); }
    };
    pbar.addEventListener('pointerdown', (e) => {
      App.player._scrubbing = true;
      pbar.setPointerCapture(e.pointerId);
      seekTo(e);
      const move = (ev) => {
        const r = pbar.getBoundingClientRect();
        const ratio = U.clamp((ev.clientX - r.left) / r.width, 0, 1);
        const dur = App.engine.duration();
        if (dur) { $('#pFill').style.width = `${ratio * 100}%`; $('#pKnob').style.left = `${ratio * 100}%`; $('#tCur').textContent = U.fmtTime(ratio * dur); }
      };
      const up = (ev) => {
        seekTo(ev);
        App.player._scrubbing = false;
        pbar.removeEventListener('pointermove', move);
        pbar.removeEventListener('pointerup', up);
      };
      pbar.addEventListener('pointermove', move);
      pbar.addEventListener('pointerup', up);
    });

    App.miniEq = window.makeMiniEq($('#miniEq'), App.engine, 5);
  }

  function setVolume(v) {
    App.engine.setVolume(v);
    App.settings.playback.volume = v;
    App.settings.playback.muted = false;
    api.settings.set('playback.volume', v);
    api.settings.set('playback.muted', false);
    const vol = $('#volume');
    vol.value = String(Math.round(v * 100));
    vol.style.setProperty('--fill', `${vol.value}%`);
    updateQuickButtons();
  }
  App.setVolume = setVolume;

  function setMuted(m) {
    App.engine.setMuted(m);
    App.settings.playback.muted = m;
    api.settings.set('playback.muted', m);
    updateQuickButtons();
  }

  App.setRate = function (v) {
    App.engine.setRate(v);
    App.settings.playback.rate = v;
    api.settings.set('playback.rate', v);
    updateRateButton();
  };
  App.setPitch = function (v) {
    App.engine.setPitchSemitones(v);
    App.settings.playback.pitch = v;
    api.settings.set('playback.pitch', v);
    updateRateButton();
  };

  function updatePlayButton() {
    const st = App.player.state();
    const b = $('#btnPlay');
    b.textContent = st.playing && !App.engine.isPaused() ? '⏸' : '▶';
  }
  function updateModeButton() {
    const m = App.player.mode;
    const map = { sequential: ['🔁', '顺序播放'], 'repeat-all': ['🔁', '列表循环'], 'repeat-one': ['🔂', '单曲循环'], shuffle: ['🔀', '随机播放'] };
    const [icon, label] = map[m] || map.sequential;
    const b = $('#btnShuffle');
    const r = $('#btnRepeat');
    if (m === 'shuffle') { b.classList.add('fav-on'); b.textContent = '🔀'; r.textContent = '🔁'; }
    else { b.classList.remove('fav-on'); b.textContent = '🔀'; r.textContent = icon; }
    r.title = `循环模式：${label}（Ctrl+R）`;
    b.title = `随机播放（Ctrl+S）`;
  }
  function updateRateButton() {
    const b = $('#btnRate');
    const r = App.engine.rate; const p = App.engine.pitchSemis;
    b.textContent = `${r.toFixed(2).replace(/0$/, '').replace(/\.$/, '')}×${p ? ` ${p > 0 ? '+' : ''}${p}♯` : ''}`;
    b.title = `速度 ${r.toFixed(2)}× · 变调 ${p} 半音 · ${App.engine.preservePitch ? '变速不变调' : '变速变调'}`;
  }
  function updateQuickButtons() {
    $('#btnMute').textContent = App.engine.muted || App.engine.volume === 0 ? '🔇' : (App.engine.volume < 0.45 ? '🔉' : '🔊');
    $('#btnMini').classList.toggle('fav-on', !!App.settings.mini.visible);
    const dl = $('#btnDesktopLyrics');
    if (dl) dl.classList.toggle('fav-on', !!(App.settings.lyrics && App.settings.lyrics.desktopEnabled));
    $('#btnVisualizer').classList.toggle('fav-on', !$('#floatPanel').classList.contains('hidden'));
    $('#volume').style.setProperty('--fill', `${$('#volume').value}%`);
  }

  /** 只在实际文本变化时才写 DOM，避免每秒多次重排 */
  function updatePlayedChips() {
    const t = App.player.current;
    const text = `累计 ${U.fmtMs(t ? App.trackLivePlayedMs(t.id) : 0)}`;
    const cum = $('#npCumulative');
    if (cum && cum.textContent !== text) cum.textContent = text;
    const bar = $('#npPlayed');
    const barText = `已听 ${U.fmtMs(t ? App.trackLivePlayedMs(t.id) : 0)}`;
    if (bar && bar.textContent !== barText) bar.textContent = barText;
  }

  function updateNowPlayingUi() {
    const t = App.player.current;
    const cover = $('#npCover');
    if (t && t.hasCover) {
      cover.classList.remove('ph');
      cover.style.backgroundImage = `url("${U.coverUrlOf(t.id)}")`;
      cover.textContent = '';
    } else {
      cover.classList.add('ph');
      cover.style.backgroundImage = '';
      cover.textContent = '♪';
    }
    $('#npTitle').textContent = t ? (t.title || t.name) : '未播放';
    $('#npArtist').textContent = t ? `${t.artist || '未知歌手'}${t.album ? ' · ' + t.album : ''}` : '选择一首歌开始';
    $('#npFormat').textContent = t ? `${(t.format || '').toUpperCase()}${t.bitrate ? ' · ' + Math.round(t.bitrate / 1000) + 'k' : ''}` : '—';
    const played = t ? App.trackLivePlayedMs(t.id) : 0;
    $('#npPlayed').textContent = `已听 ${U.fmtMs(played)}`;
    const cum0 = $('#npCumulative');
    if (cum0) cum0.textContent = `累计 ${U.fmtMs(played)}`;
    updateFavButton();
    updatePlayButton();
    document.title = t ? `${t.title || t.name} - ${t.artist || '未知歌手'} · Aurora 极光音乐` : 'Aurora 极光音乐';
    updateProgress();
  }
  function updateFavButton() {
    const t = App.player.current;
    const b = $('#btnFav');
    b.textContent = t && t.favorite ? '♥' : '♡';
    b.classList.toggle('fav-on', !!(t && t.favorite));
  }

  function updateProgress() {
    const pos = App.engine.position();
    const dur = App.engine.duration();
    const ratio = dur ? U.clamp(pos / dur, 0, 1) : 0;
    $('#pFill').style.width = `${ratio * 100}%`;
    $('#pKnob').style.left = `${ratio * 100}%`;
    const buf = dur ? U.clamp(App.engine.buffered() / dur, 0, 1) : 0;
    $('#pBuffered').style.width = `${buf * 100}%`;
    $('#tCur').textContent = U.fmtTime(pos);
    $('#tDur').textContent = U.fmtTime(dur);
    $('#vizTime').textContent = U.fmtTime(pos);
    updatePlayedChips();

    // 歌词同步
    if (App.lyrics.lines.length) {
      const changed = App.lyrics.update(pos);
      if (App.state.view === 'now') {
        if (changed) {
          const box = $('#lyricsBox');
          if (box) {
            $$('.ly-line', box).forEach((el, i) => {
              el.classList.toggle('active', i === App.lyrics.current);
              el.classList.toggle('past', i < App.lyrics.current);
              el.classList.toggle('karaoke', i === App.lyrics.current);
            });
            window.Lyrics.scrollToActive(box, true);
          }
        }
        const act = $('#lyricsBox .ly-line.active');
        if (act) act.style.setProperty('--p', `${(App.lyrics.progress(pos) * 100).toFixed(1)}%`);
      }
    }
    if (Date.now() - (App._lastOverlay || 0) > 240) {
      App._lastOverlay = Date.now();
      syncOverlays();
    }
  }

  /* ================================ 速度 / 过渡浮层 ================================ */
  function openRatePopover(anchor) {
    closePopover();
    const P = App.settings.playback;
    const box = ce('div', { class: 'popover', style: { position: 'fixed', minWidth: '290px' } });
    box.appendChild(ce('div', { style: { fontWeight: '700', fontSize: '12.5px', marginBottom: '6px' }, text: '播放速度' }));
    const rateVal = ce('span', { class: 'mono', style: { minWidth: '54px', textAlign: 'right' }, text: `${App.engine.rate.toFixed(2)}×` });
    const rInp = ce('input', { type: 'range', min: 0.5, max: 3, step: 0.05, value: App.engine.rate, style: { flex: 1 } });
    rInp.oninput = () => { rateVal.textContent = `${Number(rInp.value).toFixed(2)}×`; App.setRate(Number(rInp.value)); };
    box.appendChild(ce('div', { class: 'row', style: { gap: '8px' } }, [rInp, rateVal]));
    box.appendChild(ce('div', { class: 'row', style: { gap: '6px', margin: '6px 0 10px' } }, [0.75, 1, 1.25, 1.5, 2].map((v) =>
      ce('button', { class: 'chip', text: `${v}×`, onclick: () => { App.setRate(v); rInp.value = String(v); rateVal.textContent = `${v}×`; } }))));

    box.appendChild(ce('div', { style: { fontWeight: '700', fontSize: '12.5px', marginBottom: '6px' }, text: '变调（半音）' }));
    const pVal = ce('span', { class: 'mono', style: { minWidth: '54px', textAlign: 'right' }, text: `${App.engine.pitchSemis > 0 ? '+' : ''}${App.engine.pitchSemis}` });
    const pInp = ce('input', { type: 'range', min: -12, max: 12, step: 1, value: App.engine.pitchSemis, style: { flex: 1 } });
    pInp.oninput = () => { pVal.textContent = `${pInp.value > 0 ? '+' : ''}${pInp.value}`; App.setPitch(Number(pInp.value)); };
    box.appendChild(ce('div', { class: 'row', style: { gap: '8px' } }, [pInp, pVal]));
    box.appendChild(ce('div', { class: 'row', style: { gap: '6px', marginTop: '6px' } }, [
      ce('button', { class: 'chip', text: '原调', onclick: () => { App.setPitch(0); pInp.value = '0'; pVal.textContent = '0'; } }),
      ce('button', { class: 'chip', text: '升 2 半音', onclick: () => { App.setPitch(2); pInp.value = '2'; pVal.textContent = '+2'; } }),
      ce('button', { class: 'chip', text: '降 2 半音', onclick: () => { App.setPitch(-2); pInp.value = '-2'; pVal.textContent = '-2'; } })
    ]));
    box.appendChild(ce('div', { class: 'divider' }));
    box.appendChild(ce('div', { class: 'row', style: { justifyContent: 'space-between', fontSize: '12.5px' } }, [
      ce('span', { text: '变速不变调' }),
      window.Panels.sw(App.engine.preservePitch, (v) => { App.engine.setPreservePitch(v); App.settings.playback.preservePitch = v; api.settings.set('playback.preservePitch', v); })
    ]));
    showPopover(box, anchor);
  }

  function openTransitionPopover(anchor) {
    closePopover();
    const P = App.settings.playback;
    const box = ce('div', { class: 'popover', style: { position: 'fixed', minWidth: '280px' } });
    box.appendChild(ce('div', { style: { fontWeight: '700', fontSize: '12.5px', marginBottom: '8px' }, text: '切歌过渡效果' }));
    for (const t of D.TRANSITIONS) {
      const on = P.transition === t.id;
      box.appendChild(ce('div', { class: 'line', style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px', borderRadius: '8px', cursor: 'pointer', background: on ? 'color-mix(in srgb, var(--accent) 20%, transparent)' : '' }, onclick: () => { saveSettings({ playback: { ...P, transition: t.id } }, { rerender: false }); closePopover(); } }, [
        ce('span', { text: on ? '◉' : '○' }),
        ce('div', { class: 'grow' }, [ce('div', { style: { fontSize: '12.5px', fontWeight: '600' }, text: t.name }), ce('div', { class: 'muted', style: { fontSize: '11px' }, text: t.desc })]),
        ce('button', { class: 'btn sm ghost', text: '试听', onclick: (e) => { e.stopPropagation(); App.player.next({ transition: t.id }); } })
      ]));
    }
    box.appendChild(ce('div', { class: 'divider' }));
    const durVal = ce('span', { class: 'mono', style: { minWidth: '48px', textAlign: 'right' }, text: `${(P.transitionMs / 1000).toFixed(1)}s` });
    const dInp = ce('input', { type: 'range', min: 200, max: 5000, step: 100, value: P.transitionMs, style: { flex: 1 } });
    dInp.oninput = () => { durVal.textContent = `${(Number(dInp.value) / 1000).toFixed(1)}s`; saveSettings({ playback: { ...App.settings.playback, transitionMs: Number(dInp.value) } }, { rerender: false }); };
    box.appendChild(ce('div', { class: 'row', style: { gap: '8px' } }, [ce('span', { style: { fontSize: '12px' }, text: '时长' }), dInp, durVal]));
    showPopover(box, anchor);
  }

  let popoverEl = null;
  function showPopover(box, anchor) {
    closePopover();
    document.body.appendChild(box);
    const r = anchor.getBoundingClientRect();
    const bw = box.getBoundingClientRect().width;
    let left = Math.min(window.innerWidth - bw - 12, Math.max(12, r.left + r.width / 2 - bw / 2));
    let top = r.top - box.getBoundingClientRect().height - 12;
    if (top < 60) top = r.bottom + 12;
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    popoverEl = box;
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  }
  function outside(e) { if (popoverEl && !popoverEl.contains(e.target)) closePopover(); }
  function closePopover() {
    if (popoverEl) { popoverEl.remove(); popoverEl = null; document.removeEventListener('pointerdown', outside, true); }
  }

  /* ================================ 上下文菜单 ================================ */
  App.contextMenu = function (e, track) {
    e.preventDefault();
    App.contextMenuAt(e.clientX, e.clientY, track);
  };
  App.contextMenuAt = function (x, y, track) {
    closePopover();
    const items = [
      ['▶ 播放', () => App.playTrack(track)],
      ['⏭ 下一首播放', () => { const i = App.player.currentIndex; App.player.queue.splice(i + 1, 0, track); U.toast('已插入下一首'); }],
      ['＋ 加入队列末尾', () => { App.player.queue.push(track); U.toast('已加入队列'); }],
      ['♥ 收藏 / 取消', () => App.toggleFavorite(track.id)],
      null,
      ['📝 导入歌词', () => { App.player.playTrack(track).then(() => App.importLyrics()); }],
      ['✏️ 编辑歌词', () => { App.player.playTrack(track).then(() => App.editLyrics()); }],
      ['📂 打开所在文件夹', () => api.library.showInFolder(track.path)],
      ['ℹ️ 查看文件信息', () => showFileInfo(track)],
      null,
      ['📚 加入播放列表…', () => addToPlaylistDialog(track)],
      ['🗑 从曲库移除', () => { api.library.removeTrack(track.id); App.state.tracks = App.state.tracks.filter((t) => t.id !== track.id); App.render(); }],
      ['🗑 删除文件（移到回收站）', () => U.confirmBox('删除文件', `确定把「${track.title || track.name}」移到回收站吗？`, '删除', async () => {
        const r = await api.library.deleteFile(track.id);
        if (r.ok) { App.state.tracks = App.state.tracks.filter((t) => t.id !== track.id); App.render(); U.toast('已移到回收站', 'ok'); }
        else U.toast('删除失败：' + r.error, 'err');
      })]
    ];
    const box = ce('div', { class: 'popover', style: { position: 'fixed', left: `${Math.min(x, window.innerWidth - 240)}px`, top: `${Math.min(y, window.innerHeight - 420)}px`, minWidth: '220px', padding: '6px' } });
    for (const it of items) {
      if (!it) { box.appendChild(ce('div', { class: 'divider', style: { margin: '4px 0' } })); continue; }
      box.appendChild(ce('div', { class: 'line', style: { padding: '7px 10px', borderRadius: '8px', cursor: 'pointer', fontSize: '12.5px' }, text: it[0], onclick: () => { closePopover(); it[1](); } }))
        .addEventListener('mouseenter', (ev) => { ev.currentTarget.style.background = 'var(--hover)'; });
    }
    document.body.appendChild(box);
    popoverEl = box;
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  };

  function showFileInfo(t) {
    const rows = [
      ['标题', t.title], ['歌手', t.artist], ['专辑', t.album], ['流派', t.genre], ['年份', t.year],
      ['格式', `${(t.format || '').toUpperCase()} ${t.lossless ? '(无损)' : ''}`], ['编码', t.codec], ['比特率', t.bitrate ? `${Math.round(t.bitrate / 1000)} kbps` : '—'],
      ['采样率', t.sampleRate ? `${(t.sampleRate / 1000).toFixed(1)} kHz` : '—'], ['声道', t.channels], ['时长', U.fmtTime((t.duration || 0) / 1000)],
      ['文件大小', U.fmtSize(t.size)], ['累计听歌', U.fmtLong(App.trackPlayedMs(t.id))], ['播放次数', `${t.playCount || 0} 次`],
      ['最近播放', t.lastPlayedAt ? U.fmtDateTime(t.lastPlayedAt) : '从未'], ['文件路径', t.path]
    ];
    const box = ce('div', {}, rows.map(([k, v]) => ce('div', { class: 'row', style: { padding: '6px 0', borderBottom: '1px dashed var(--border)', fontSize: '12.5px' } }, [
      ce('span', { class: 'muted', style: { width: '90px', flex: 'none' }, text: k }),
      ce('span', { class: 'mono', style: { wordBreak: 'break-all' }, text: String(v === undefined || v === null || v === '' ? '—' : v) })
    ])));
    U.modal('文件信息', t.name, box, [ce('button', { class: 'btn', text: '打开所在文件夹', onclick: () => api.library.showInFolder(t.path) })]);
  }

  function addToPlaylistDialog(track) {
    const box = ce('div', {});
    if (!App.state.playlists.length) box.appendChild(ce('div', { class: 'muted', text: '还没有播放列表，先新建一个。' }));
    for (const pl of App.state.playlists) {
      box.appendChild(ce('button', { class: 'btn sm', style: { margin: '4px' }, text: pl.name, onclick: async () => {
        if (!pl.ids.includes(track.id)) { pl.ids.push(track.id); await api.playlists.save(App.state.playlists); U.toast(`已加入「${pl.name}」`, 'ok'); }
        m.close();
      } }));
    }
    const m = U.modal('加入播放列表', track.title || track.name, box, []);
  }

  App.playlistContextMenu = function (e, pl) {
    e.preventDefault();
    closePopover();
    const box = ce('div', { class: 'popover', style: { position: 'fixed', left: `${Math.min(e.clientX, window.innerWidth - 240)}px`, top: `${Math.min(e.clientY, window.innerHeight - 260)}px`, minWidth: '200px', padding: '6px' } });
    const items = [
      ['▶ 播放', () => App.openPlaylist(pl.id, true)],
      ['✏️ 重命名', () => App.renamePlaylist(pl.id)],
      ['📤 导出 JSON', () => App.exportPlaylist(pl.id)],
      ['🗑 删除列表', () => U.confirmBox('删除播放列表', `确定删除「${pl.name}」吗？（不会删除文件）`, '删除', async () => {
        App.state.playlists = App.state.playlists.filter((p) => p.id !== pl.id);
        await api.playlists.save(App.state.playlists);
        if (App.state.playlistId === pl.id) App.setView('library');
        App.render(); updateCounts();
      })]
    ];
    for (const [label, fn] of items) {
      const d = ce('div', { class: 'line', style: { padding: '7px 10px', borderRadius: '8px', cursor: 'pointer', fontSize: '12.5px' }, text: label });
      d.onmouseenter = () => { d.style.background = 'var(--hover)'; };
      d.onclick = () => { closePopover(); fn(); };
      box.appendChild(d);
    }
    document.body.appendChild(box);
    popoverEl = box;
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  };

  App.openPlaylist = function (id, autoplay) {
    App.state.playlistId = id;
    App.setView('playlist');
    if (autoplay) {
      const list = App.visibleTracks();
      if (list.length) App.player.setQueue(list, 0);
    }
  };
  App.createPlaylist = async function () {
    const inp = ce('input', { placeholder: '播放列表名称', style: { width: '100%' } });
    const m = U.modal('新建播放列表', '创建后可在曲目右键菜单里添加歌曲', inp, [
      ce('button', { class: 'btn', text: '取消', onclick: () => m.close() }),
      ce('button', { class: 'btn primary', text: '创建', onclick: async () => {
        const name = inp.value.trim() || `播放列表 ${App.state.playlists.length + 1}`;
        App.state.playlists.push({ id: `pl_${Date.now().toString(36)}`, name, ids: [], order: [], createdAt: Date.now() });
        await api.playlists.save(App.state.playlists);
        m.close(); App.render(); updateCounts();
      } })
    ]);
    setTimeout(() => inp.focus(), 50);
  };
  App.renamePlaylist = function (id) {
    const pl = App.state.playlists.find((p) => p.id === id);
    if (!pl) return;
    const inp = ce('input', { value: pl.name, style: { width: '100%' } });
    const m = U.modal('重命名播放列表', null, inp, [
      ce('button', { class: 'btn', text: '取消', onclick: () => m.close() }),
      ce('button', { class: 'btn primary', text: '保存', onclick: async () => {
        pl.name = inp.value.trim() || pl.name; await api.playlists.save(App.state.playlists); m.close(); App.render(); updateCounts();
      } })
    ]);
  };
  App.exportPlaylist = function (id) {
    const pl = App.state.playlists.find((p) => p.id === (id || App.state.playlistId));
    if (!pl) return;
    const tracks = (pl.ids || []).map((tid) => App.state.tracks.find((t) => t.id === tid)).filter(Boolean).map((t) => ({ title: t.title, artist: t.artist, album: t.album, path: t.path }));
    api.playlists.exportFile({ name: pl.name, createdAt: Date.now(), tracks });
  };
  App.importPlaylist = async function () {
    const res = await api.dialog.pickFiles('all');
    if (res.canceled) return;
    let added = 0;
    for (const f of res.paths) {
      try {
        const txt = await (await fetch(api.app.mediaUrl(f))).text();
        const obj = JSON.parse(txt);
        const tracks = obj.tracks || obj;
        if (!Array.isArray(tracks)) continue;
        const ids = tracks.map((t) => t.path && App.state.tracks.find((x) => x.path === t.path)).filter(Boolean).map((t) => t.id);
        App.state.playlists.push({ id: `pl_${Date.now().toString(36)}_${added}`, name: obj.name || `导入 ${added + 1}`, ids, createdAt: Date.now() });
        added++;
      } catch (err) { U.toast('导入失败：' + (err.message || err), 'err'); }
    }
    await api.playlists.save(App.state.playlists);
    App.render(); updateCounts();
    if (added) U.toast(`已导入 ${added} 个播放列表`, 'ok');
  };

  /* ================================ 排序 / 扫描 ================================ */
  App.setSort = function (key) {
    if (App.state.sortKey === key) App.state.sortDir = App.state.sortDir === 'asc' ? 'desc' : 'asc';
    else { App.state.sortKey = key; App.state.sortDir = 'asc'; }
    App.settings.ui.sortKey = App.state.sortKey;
    App.settings.ui.sortDir = App.state.sortDir;
    api.settings.merge({ ui: { sortKey: App.state.sortKey, sortDir: App.state.sortDir } });
    App.render();
  };
  App.toggleSortDir = function () { App.setSort(App.state.sortKey); };
  App.toggleViewMode = function () {
    App.state.viewMode = App.state.viewMode === 'list' ? 'grid' : 'list';
    App.settings.ui.viewMode = App.state.viewMode;
    api.settings.set('ui.viewMode', App.state.viewMode);
    App.render();
  };
  App.shuffleOrder = async function () {
    const list = App.visibleTracks();
    for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
    await App.applyManualOrder(list.map((t) => t.id));
    U.toast('已打乱顺序', 'ok');
  };
  App.applyManualOrder = async function (ids) {
    const map = new Map(App.state.tracks.map((t) => [t.id, t]));
    const rest = App.state.tracks.filter((t) => !ids.includes(t.id));
    App.state.tracks = [...ids.map((id) => map.get(id)).filter(Boolean), ...rest];
    App.state.sortKey = 'manual';
    App.settings.ui.sortKey = 'manual';
    api.settings.set('ui.sortKey', 'manual');
    await api.library.reorder(ids);
    // 重绘一次：让「排序」下拉同步显示「自定义排序」，并把左侧序号刷新
    App.render();
  };

  App.addFolder = async function () {
    const res = await api.library.pickFolder();
    if (res.canceled || !res.paths.length) return;
    const roots = Array.from(new Set([...(App.settings.library.roots || []), ...res.paths]));
    await saveSettings({ library: { ...App.settings.library, roots } }, { rerender: false });
    await startScan();
  };
  App.removeRoot = async function (root) {
    const r = await api.library.removeRoot(root);
    App.settings.library.roots = r.roots;
    App.state.tracks = r.tracks || [];
    App.render();
    U.toast('已移除文件夹', 'ok');
  };
  App.rescan = async function (root) {
    if (root) {
      const roots = Array.from(new Set([...(App.settings.library.roots || []), root]));
      await saveSettings({ library: { ...App.settings.library, roots } }, { rerender: false });
    }
    await startScan();
  };

  let scanModal = null;
  async function startScan() {
    const roots = App.settings.library.roots || [];
    if (!roots.length) { App.addFolder(); return; }
    const bar = ce('i');
    const msg = ce('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '10px' }, text: '正在准备…' });
    const body = ce('div', {}, [
      ce('div', { style: { fontSize: '13px' }, text: `扫描目录：${roots.join(' 、 ')}` }),
      ce('div', { class: 'scan-bar' }, [bar]),
      msg
    ]);
    const cancelBtn = ce('button', { class: 'btn', text: '后台运行', onclick: () => { if (scanModal) scanModal.close(); scanModal = null; } });
    scanModal = U.modal('正在扫描曲库', '首次扫描需要读取每首歌的标签与封面，请稍候', body, [cancelBtn]);
    const off = api.on('scan:progress', (p) => {
      if (p.percent) bar.style.width = `${p.percent}%`;
      msg.textContent = p.message || '';
    });
    const res = await api.library.scan(roots);
    off();
    if (scanModal) { scanModal.close(); scanModal = null; }
    if (res && res.ok) {
      App.state.tracks = res.tracks || [];
      U.toast(`扫描完成，共 ${res.count} 首（用时 ${(res.elapsedMs / 1000).toFixed(1)}s）`, 'ok');
      App.render();
    } else if (res && res.error) {
      U.toast('扫描失败：' + res.error, 'err');
    }
  }

  App.removeSelection = async function () {
    for (const id of App.state.selection) await api.library.removeTrack(id);
    App.state.tracks = App.state.tracks.filter((t) => !App.state.selection.has(t.id));
    App.state.selection.clear();
    App.render();
  };
  App.addSelectionToPlaylist = function () {
    if (!App.state.playlists.length) { App.createPlaylist(); return; }
    const box = ce('div', {});
    for (const pl of App.state.playlists) {
      box.appendChild(ce('button', { class: 'btn sm', style: { margin: '4px' }, text: pl.name, onclick: async () => {
        for (const id of App.state.selection) if (!pl.ids.includes(id)) pl.ids.push(id);
        await api.playlists.save(App.state.playlists);
        U.toast(`已加入「${pl.name}」`, 'ok');
        m.close(); updateCounts();
      } }));
    }
    const m = U.modal('加入播放列表', `已选 ${App.state.selection.size} 首`, box, []);
  };

  /* ================================ 均衡器 / 插件 ================================ */
  App.setEq = function (patch) {
    const next = { ...App.settings.eq, ...patch };
    App.settings.eq = next;
    api.settings.set('eq', next);
    App.engine.setEqGains(next.bands || []);
    App.engine.setPreamp(next.preamp || 0);
    App.engine.setEqEnabled(!!next.enabled);
    // 不做整页重绘：EQ 拖动中重建 DOM 会直接打断拖动，并且画面会闪
    syncOverlays();
  };
  App.setEqBand = function (i, v) {
    App.settings.eq.bands[i] = v;
    App.settings.eq.preset = '自定义';
    App.engine.setEqBand(i, v);
    api.settings.set('eq', App.settings.eq);
  };
  App.saveEqPreset = function () {
    const inp = ce('input', { placeholder: '预设名称', style: { width: '100%' } });
    const m = U.modal('保存均衡器预设', '保存当前 10 段设置与前置放大', inp, [
      ce('button', { class: 'btn', text: '取消', onclick: () => m.close() }),
      ce('button', { class: 'btn primary', text: '保存', onclick: async () => {
        const name = inp.value.trim() || `预设 ${Object.keys(App.settings.eq.customPresets || {}).length + 1}`;
        const custom = { ...(App.settings.eq.customPresets || {}), [name]: { bands: App.settings.eq.bands.slice(), preamp: App.settings.eq.preamp } };
        await saveSettings({ eq: { ...App.settings.eq, customPresets: custom, preset: name } });
        m.close();
        U.toast('预设已保存', 'ok');
      } })
    ]);
  };
  App.exportEq = function () {
    U.download('aurora-eq.json', JSON.stringify({ bands: App.settings.eq.bands, preamp: App.settings.eq.preamp, freqs: D.EQ_FREQS }, null, 2));
  };

  async function ensurePlugins() {
    const list = await api.plugins.list();
    if (!list.installed || !list.installed.length) {
      App.settings.plugins.installed = PR().BUILTIN_PLUGINS.map((p) => ({ ...p }));
      await api.settings.set('plugins.installed', App.settings.plugins.installed);
    } else {
      // 确保内置插件都在（版本升级后补充新增的内置插件）
      const builtins = PR().BUILTIN_PLUGINS;
      const ids = new Set(list.installed.map((p) => p.id));
      const missing = builtins.filter((b) => !ids.has(b.id));
      if (missing.length) {
        App.settings.plugins.installed = [...list.installed, ...missing.map((p) => ({ ...p }))];
        await api.settings.set('plugins.installed', App.settings.plugins.installed);
      }
    }
    await applyPlugins();
  }
  function PR() { return window.AURORA_PRESETS; }

  async function applyPlugins() {
    const installed = App.settings.plugins.installed || [];
    const enabled = App.settings.plugins.enabled || [];
    const params = App.settings.plugins.params || {};
    const chain = enabled.map((id) => installed.find((p) => p.id === id)).filter(Boolean)
      .map((p) => ({ descriptor: p, params: { ...defaultsOf(p), ...(params[p.id] || {}) } }));
    await App.engine.ensure();
    await App.engine.setPlugins(chain);
  }
  function defaultsOf(p) {
    const o = {};
    for (const prm of p.params || []) o[prm.key] = prm.default;
    return o;
  }

  App.togglePlugin = async function (id, on) {
    const enabled = new Set(App.settings.plugins.enabled || []);
    if (on) enabled.add(id); else enabled.delete(id);
    App.settings.plugins.enabled = Array.from(enabled);
    await api.settings.set('plugins.enabled', App.settings.plugins.enabled);
    await applyPlugins();
    // 只更新这一张卡片的高亮，不重建整个插件页（避免闪烁）
    const card = document.querySelector(`.plugin-card[data-plugin-id="${id}"]`);
    if (card) card.classList.toggle('on', !!on);
    U.toast(on ? '音效已启用' : '音效已关闭', 'ok', 1200);
  };
  App.setPluginParam = async function (id, key, value) {
    const params = App.settings.plugins.params || {};
    params[id] = { ...(params[id] || {}), [key]: value };
    App.settings.plugins.params = params;
    api.settings.set('plugins.params', params);
    App.engine.updatePluginParams(id, { ...defaultsOf(App.settings.plugins.installed.find((p) => p.id === id) || { params: [] }), ...params[id] });
  };
  App.removePlugin = async function (id) {
    const r = await api.plugins.remove(id);
    App.settings.plugins.installed = r.installed || [];
    await applyPlugins();
    App.render();
  };
  App.resetPlugins = async function () {
    await api.plugins.reset();
    App.settings = await api.settings.get();
    App.settings.__dataDir = App.state.appInfo.dataDir;
    await applyPlugins();
    App.render();
    U.toast('已恢复内置插件', 'ok');
  };
  App.importPlugins = async function () {
    const r = await api.plugins.importFile();
    if (r.canceled) return;
    App.settings = await api.settings.get();
    App.settings.__dataDir = App.state.appInfo.dataDir;
    await applyPlugins();
    App.render();
    if (r.added && r.added.length) U.toast(`已导入 ${r.added.length} 个音效插件`, 'ok');
    if (r.errors && r.errors.length) U.toast(`部分文件导入失败：${r.errors[0]}`, 'err', 5000);
  };

  /* ================================ 歌词窗口 / 迷你播放器 ================================ */
  /* ================================ 浮动可视化面板 ================================ */
  function wireFloatPanel() {
    const panel = $('#floatPanel');
    const saved = App.settings.ui.floatPanelPos || null;
    if (saved) { panel.style.left = `${saved.x}px`; panel.style.top = `${saved.y}px`; panel.style.right = 'auto'; }
    else { panel.style.right = '24px'; panel.style.top = '96px'; }
    window.DragSort.makeDraggable(panel, panel.querySelector('.fp-head'), {
      onMove: (r) => { App.settings.ui.floatPanelPos = { x: r.left, y: r.top }; api.settings.set('ui.floatPanelPos', { x: r.left, y: r.top }); }
    });
    $('#vizClose').onclick = () => toggleFloatPanel(false);
    $('#vizStyle').onchange = (e) => { if (App.viz) App.viz.setMode(e.target.value); api.settings.set('ui.vizStyle', e.target.value); };
    $('#vizStyle').value = App.settings.ui.vizStyle || 'bars';
    App.viz = new window.Visualizer($('#vizCanvas'), App.engine);
    App.viz.setMode(App.settings.ui.vizStyle || 'bars');
    App.viz.start();
    App.player.on('track', () => { $('#vizTitle').textContent = App.player.current ? (App.player.current.title || App.player.current.name) : '未播放'; });
  }
  function toggleFloatPanel(force) {
    const panel = $('#floatPanel');
    const show = typeof force === 'boolean' ? force : panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !show);
    updateQuickButtons();
    if (show) { App.viz.resize(); App.viz.start(); }
  }

  /* ================================ 快捷键 ================================ */
  /**
   * 应用内快捷键已整体下架（用户要求），这里只保留一组固定的键盘操作。
   * 全局快捷键仍然走主进程的 globalShortcut，在设置页里配。
   */
  function wireShortcuts() {
    document.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
      if (e.key === 'Escape') {
        closePopover();
        // 字幕 / 放映模式下 Esc 直接退出（其它视图没有任何副作用）
        if (App.state.view === 'subtitle') App.setView('now');
        else if (typing) e.target.blur();
        return;
      }
      if (typing) return;
      if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); runAction('playPause'); }
      else if (e.key === 'ArrowRight' && !e.ctrlKey) { e.preventDefault(); runAction('seekForward'); }
      else if (e.key === 'ArrowLeft' && !e.ctrlKey) { e.preventDefault(); runAction('seekBackward'); }
      else if (e.key === 'ArrowUp' && !e.ctrlKey) { e.preventDefault(); runAction('volumeUp'); }
      else if (e.key === 'ArrowDown' && !e.ctrlKey) { e.preventDefault(); runAction('volumeDown'); }
      else if (e.key === '/' && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); runAction('search'); }
    });
  }

  function runAction(action) {
    if (typeof action === 'string' && action.startsWith('seekRatio:')) {
      const ratio = parseFloat(action.slice(10));
      const dur = App.engine.duration();
      if (dur && Number.isFinite(ratio)) App.player.seek(U.clamp(ratio, 0, 1) * dur);
      return;
    }
    switch (action) {
      case 'playPause': App.player.toggle(); break;
      case 'next': App.player.next(); break;
      case 'prev': App.player.prev(); break;
      case 'stop': App.player.stop(); break;
      case 'volumeUp': setVolume(U.clamp(App.engine.volume + 0.05, 0, 1)); break;
      case 'volumeDown': setVolume(U.clamp(App.engine.volume - 0.05, 0, 1)); break;
      case 'mute': setMuted(!App.engine.muted); break;
      case 'seekForward': App.player.seekRelative(5); break;
      case 'seekBackward': App.player.seekRelative(-5); break;
      case 'toggleMini': api.mini.toggle().then((r) => { App.settings.mini.visible = r.visible; updateQuickButtons(); }); break;
      case 'toggleMain': api.app.focusMain(); break;
      case 'shuffle': App.player.setMode(App.player.mode === 'shuffle' ? 'sequential' : 'shuffle'); break;
      case 'repeat': App.player.cycleMode(); break;
      case 'favorite': if (App.player.current) App.toggleFavorite(App.player.current.id); break;
      case 'search': $('#search').focus(); $('#search').select(); break;
      case 'theme': cycleTheme(); break;
      case 'eq': App.setView('eq'); break;
      case 'stats': App.setView('stats'); break;
      default: break;
    }
  }
  function cycleTheme() {
    const ids = D.THEMES.map((t) => t.id);
    const i = ids.indexOf(App.settings.theme);
    const next = ids[(i + 1) % ids.length];
    saveSettings({ theme: next }, { rerender: false });
    U.toast(`主题：${D.THEMES.find((t) => t.id === next).name}`, 'ok', 1500);
  }

  /**
   * 设置 / 清除一个快捷键。
   * 传空值表示「清除」——此时把这个键从配置里**删掉**，而不是写成空字符串。
   * 写空字符串的话，主进程里那条「空值补回默认」的兜底逻辑会在重启后把它复活，
   * 用户看到的现象就是「清掉的快捷键自己又回来了」。
   */
  App.setShortcut = async function (scope, action, accel) {
    const next = { ...((App.settings.shortcuts && App.settings.shortcuts[scope]) || {}) };
    const value = String(accel == null ? '' : accel).trim();
    if (value) next[action] = value;
    else delete next[action];
    App.settings.shortcuts[scope] = next;
    await saveSettings({ shortcuts: { ...App.settings.shortcuts, [scope]: next } }, { rerender: false });
    if (scope === 'global') {
      const r = await api.shortcuts.register();
      if (r.failed && r.failed.length) U.toast(`部分全局快捷键被占用：${r.failed.map((f) => f.accel).join(', ')}`, 'err', 4000);
    }
    App.render();
  };
  App.resetShortcuts = async function () {
    const r = await api.shortcuts.reset();
    App.settings.shortcuts = r.shortcuts;
    App.render();
    U.toast('快捷键已恢复默认', 'ok');
  };
  App.checkShortcuts = async function () {
    const r = await api.shortcuts.listRegistered();
    U.modal('全局快捷键占用检查', `当前系统已注册 ${r.global.length} 个全局快捷键`, ce('div', { class: 'mono', style: { fontSize: '12px', lineHeight: '1.9' }, text: r.global.join('\n') || '（无）' }), []);
  };

  /* ================================ 拖放导入 ================================ */
  function wireDropImport() {
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, stop, false));
    document.addEventListener('drop', async (e) => {
      const files = Array.from(e.dataTransfer.files || []);
      if (!files.length) return;
      const paths = [];
      for (const f of files) {
        try { const p = api.app.getPathForFile(f); if (p) paths.push(p); } catch { /* ignore */ }
      }
      if (!paths.length) return;
      const audioExts = ['.mp3', '.ogg', '.oga', '.m4a', '.flac', '.wav', '.aac', '.opus'];
      const dirs = new Set();
      for (const p of paths) {
        const lower = p.toLowerCase();
        if (audioExts.some((x) => lower.endsWith(x))) dirs.add(p.replace(/[\\/][^\\/]*$/, ''));
        else dirs.add(p);
      }
      const roots = Array.from(new Set([...(App.settings.library.roots || []), ...dirs]));
      await saveSettings({ library: { ...App.settings.library, roots } }, { rerender: false });
      U.toast(`已添加 ${dirs.size} 个位置，开始扫描…`, 'ok');
      await startScan();
    });
  }

  /* ================================ IPC 事件 ================================ */
  function wireIpcEvents() {
    api.on('library:updated', (payload) => {
      App.state.tracks = payload.tracks || [];
      App.render();
    });
    api.on('settings:changed', (patch) => {
      if (!patch) return;
      api.settings.get().then((s) => {
        App.settings = s;
        App.settings.__dataDir = App.state.appInfo.dataDir;
        App.state.settings = s;
        applySettingsToDom();
        App.player.applySettings(s);
        if (App.state.view === 'settings') App.render();
      });
    });
    api.on('stats:updated', (s) => {
      App.state.stats = s;
      if (App.state.view === 'stats') App.render();
      if (App.player.current) updateNowPlayingUi();
    });
    api.on('plugins:changed', async () => {
      App.settings = await api.settings.get();
      App.settings.__dataDir = App.state.appInfo.dataDir;
      await applyPlugins();
      if (App.state.view === 'plugins') App.render();
    });
    api.on('shortcut:action', ({ action }) => runAction(action));
    // 浮层/迷你窗口刚加载好时主动索要一次，避免开窗瞬间的空白
    api.on('overlay:request-sync', () => syncOverlays());
    window.addEventListener('beforeunload', () => {
      App._quitting = true;
      saveLastPlayback();
      App.player.flushStats({ reason: 'quit' });
    });
    // beforeunload 里发出的 IPC 不保证送达，pagehide 再补一次
    window.addEventListener('pagehide', () => { App._quitting = true; saveLastPlayback(); });
    window.addEventListener('aurora:degraded', () => {
      U.toast('音频引擎已切换为直通模式（均衡器/插件/变调暂不可用）', 'err', 6000);
    });
  }

  /* ================================ 数据操作 ================================ */
  App.exportStats = async function () {
    const r = await api.stats.exportFile();
    if (r.ok) U.toast('统计已导出：' + r.path, 'ok', 5000);
    else if (r.error) U.toast('导出失败：' + r.error, 'err');
  };
  App.resetStats = function () {
    U.confirmBox('重置听歌统计', '将清空所有每日 / 每月 / 每年听歌时长与每首歌累计时长，此操作不可撤销。', '确定重置', async () => {
      await api.stats.reset();
      App.state.stats = await api.stats.summary();
      App.render();
      U.toast('统计已重置', 'ok');
    });
  };
  App.clearCovers = async function () {
    const r = await api.library.covers.clear();
    const c = await api.library.covers.stats();
    App.state.coverStats = c;
    App.render();
    U.toast(`已清理 ${(r && r.removed) || 0} 个封面缓存`, 'ok');
  };
  App.createShortcut = async function () {
    const r = await api.app.createDesktopShortcut();
    if (r.ok) U.toast('桌面快捷方式已创建：' + r.path, 'ok', 5000);
    else U.toast('创建失败：' + (r.error || '未知错误'), 'err');
  };
  App.setCloseToTray = async function (on) {
    App.settings.ui.closeToTray = on;
    await api.settings.set('ui.closeToTray', on);
    await api.app.setCloseToTray(on);
  };
  App.resetSettings = function () {
    U.confirmBox('恢复默认设置', '将恢复所有外观 / 播放 / 歌词 / 快捷键设置（曲库与统计不受影响）。', '恢复默认', async () => {
      App.settings = await api.settings.reset();
      App.settings.__dataDir = App.state.appInfo.dataDir;
      applySettingsToDom();
      App.player.applySettings(App.settings);
      await applyPlugins();
      App.render();
      U.toast('已恢复默认设置', 'ok');
    });
  };
  App.pickBackground = async function () {
    const r = await api.dialog.pickImage();
    if (r.canceled) return;
    // 这里需要重绘：背景图片那一行要多出预览缩略图
    await saveSettings({ background: { ...App.settings.background, type: 'image', value: r.path } }, { rerender: true });
    U.toast('背景已更新', 'ok');
  };

  /* ================================ 启动 ================================ */
  window.addEventListener('DOMContentLoaded', () => {
    boot().catch((err) => {
      console.error(err);
      U.toast('初始化失败：' + (err && err.message ? err.message : err), 'err', 8000);
    });
  });
})();
