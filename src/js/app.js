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
      onChange: () => { if (App.state.view === 'now') renderLyricsBox(); syncOverlays(true); }
    });
    App.player.applySettings(App.settings);

    App.player.on('track', ({ track }) => {
      updateNowPlayingUi();
      loadLyricsFor(track);
      if (App.state.view === 'library') markPlayingRow();
      syncOverlays(true);
    });
    App.player.on('state', () => { updatePlayButton(); syncOverlays(false); });
    App.player.on('time', () => { updateProgress(); });
    App.player.on('mode', () => { updateModeButton(); syncOverlays(false); });
    App.player.on('deck', (e) => {
      if (e.type === 'ended') { /* 由 onEnded 处理 */ }
      if (e.type === 'error' && e.deck && e.deck.track) {
        U.toast(`无法播放：${e.deck.track.title || e.deck.track.name}`, 'err');
        setTimeout(() => App.player.next(), 800);
      }
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
    if (opts.rerender !== false && ['settings', 'eq', 'plugins'].includes(App.state.view)) App.render();
    syncOverlays(true);
    return App.settings;
  }
  App.saveSettings = saveSettings;

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

  App.render = function render() {
    const host = $('#viewRoot');
    if (!host) return;
    const scrollTop = (host.querySelector('.view-body') || {}).scrollTop || 0;
    host.innerHTML = '';
    let el;
    switch (App.state.view) {
      case 'now': el = window.Views.nowPlaying(App); break;
      case 'playlists': el = window.Views.playlists(App); break;
      case 'stats': el = window.Panels.stats(App); break;
      case 'eq': el = window.Panels.eq(App); break;
      case 'plugins': el = window.Panels.plugins(App); break;
      case 'settings': el = window.Panels.settings(App); break;
      default: el = window.Views.library(App);
    }
    el.classList.add('fade-in');
    host.appendChild(el);
    const vb = host.querySelector('.view-body');
    if (vb && scrollTop) vb.scrollTop = scrollTop;
    $$('.nav-item[data-view]').forEach((n) => n.classList.toggle('active', n.dataset.view === App.state.view || (App.state.view === 'playlist' && n.dataset.view === 'playlists')));
    updateCounts();
    if (App.state.view === 'now') renderLyricsBox();
  };

  App.setView = function (v) {
    App.state.view = v;
    App.settings.ui.lastView = v;
    api.settings.set('ui.lastView', v);
    App.render();
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
    if (App.state.view === 'favorites' || App.state.view === 'library') App.render();
    else updateCounts();
    U.toast(t.favorite ? '已加入收藏 ♥' : '已取消收藏', 'ok', 1400);
  };

  function markPlayingRow() {
    const cur = App.player.current;
    $$('.track-row').forEach((r) => r.classList.toggle('playing', !!cur && r.dataset.id === cur.id));
  }

  /* ================================ 歌词 ================================ */
  async function loadLyricsFor(track) {
    await App.lyrics.loadFor(track);
    if (App.state.view === 'now') renderLyricsBox();
    syncOverlays(true);
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

  function syncOverlays(full) {
    const st = App.player.state();
    const t = st.current;
    const payload = {
      full: !!full,
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
      lines: full ? App.lyrics.lines.map((l) => ({ t: l.t, text: l.text, tr: l.tr, isCJK: l.isCJK })) : undefined,
      settings: { lyrics: App.settings.lyrics, mini: App.settings.mini },
      degraded: st.degraded
    };
    api.player.syncLyrics(payload).catch(() => {});
    api.player.syncMini(payload).catch(() => {});
  }

  /* ================================ 标题栏 / 搜索 ================================ */
  function wireTitlebar() {
    $('#winMin').onclick = () => api.app.minimize();
    $('#winMax').onclick = () => api.app.maximize();
    $('#winClose').onclick = () => api.app.close();
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
    $('#btnDesktopLyrics').onclick = () => App.setDesktopLyrics(!App.settings.lyrics.desktopEnabled);
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
    $('#btnDesktopLyrics').classList.toggle('fav-on', !!App.settings.lyrics.desktopEnabled);
    $('#btnMini').classList.toggle('fav-on', !!App.settings.mini.visible);
    $('#btnVisualizer').classList.toggle('fav-on', !$('#floatPanel').classList.contains('hidden'));
    $('#volume').style.setProperty('--fill', `${$('#volume').value}%`);
  }

  function updateNowPlayingUi() {
    const t = App.player.current;
    const cover = $('#npCover');
    if (t && t.hasCover) {
      cover.classList.remove('ph');
      cover.style.backgroundImage = `url("aurora://local/cover?id=${t.id}")`;
      cover.textContent = '';
    } else {
      cover.classList.add('ph');
      cover.style.backgroundImage = '';
      cover.textContent = '♪';
    }
    $('#npTitle').textContent = t ? (t.title || t.name) : '未播放';
    $('#npArtist').textContent = t ? `${t.artist || '未知歌手'}${t.album ? ' · ' + t.album : ''}` : '选择一首歌开始';
    $('#npFormat').textContent = t ? `${(t.format || '').toUpperCase()}${t.bitrate ? ' · ' + Math.round(t.bitrate / 1000) + 'k' : ''}` : '—';
    const played = t ? App.trackPlayedMs(t.id) : 0;
    $('#npPlayed').textContent = `已听 ${U.fmtMs(played)}`;
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
              el.classList.toggle('karaoke', i === App.lyrics.current && App.settings.lyrics.karaoke);
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
      syncOverlays(false);
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
    await api.library.reorder(ids);
    api.settings.set('ui.sortKey', 'manual');
    updateCounts();
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
    if (App.state.view === 'eq') App.render();
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
    if (App.state.view === 'plugins') App.render();
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
  App.setDesktopLyrics = async function (on) {
    const r = await api.lyrics.toggle(on);
    App.settings.lyrics.desktopEnabled = r.enabled;
    updateQuickButtons();
    if (App.state.view === 'settings') App.render();
    syncOverlays(true);
    U.toast(r.enabled ? '桌面歌词已开启' : '桌面歌词已关闭', 'ok', 1400);
  };
  App.lockLyrics = async function (on) {
    await api.lyrics.lock(on);
    App.settings.lyrics.locked = on;
    if (App.state.view === 'settings') App.render();
  };
  App.pickLyricsMonitor = async function () {
    const info = await api.app.info();
    const box = ce('div', {});
    box.appendChild(ce('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '8px' }, text: '选择桌面歌词显示在哪块屏幕（多显示器时有效）' }));
    for (const opt of [{ v: 'primary', t: '主显示器' }, { v: 'display-0', t: '显示器 1' }, { v: 'display-1', t: '显示器 2' }, { v: 'display-2', t: '显示器 3' }]) {
      box.appendChild(ce('button', { class: 'btn sm', style: { margin: '4px' }, text: opt.t, onclick: async () => {
        await saveSettings({ lyrics: { ...App.settings.lyrics, monitor: opt.v } });
        m.close();
      } }));
    }
    const m = U.modal('桌面歌词显示器', null, box, []);
  };

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
  function wireShortcuts() {
    document.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
      const S = App.settings.shortcuts.inApp || {};
      if (e.key === 'Escape') { closePopover(); return; }
      if (typing) {
        if (e.key === 'Escape') e.target.blur();
        return;
      }
      for (const [action, accel] of Object.entries(S)) {
        if (!accel) continue;
        if (U.matchHotkey(e, accel)) {
          e.preventDefault();
          runAction(action);
          return;
        }
      }
      // 单键快捷（无修饰键）也支持
      if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); runAction('playPause'); }
      else if (e.key === 'ArrowRight' && !e.ctrlKey) { e.preventDefault(); runAction('seekForward'); }
      else if (e.key === 'ArrowLeft' && !e.ctrlKey) { e.preventDefault(); runAction('seekBackward'); }
      else if (e.key === 'ArrowUp' && !e.ctrlKey) { e.preventDefault(); runAction('volumeUp'); }
      else if (e.key === 'ArrowDown' && !e.ctrlKey) { e.preventDefault(); runAction('volumeDown'); }
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
      case 'toggleDesktopLyrics': App.setDesktopLyrics(!App.settings.lyrics.desktopEnabled); break;
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

  App.setShortcut = async function (scope, action, accel) {
    App.settings.shortcuts[scope][action] = accel;
    await api.settings.set(`shortcuts.${scope}.${action}`, accel);
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
    api.on('lyrics:settings', () => { /* 桌面歌词窗口自行处理 */ });
    window.addEventListener('beforeunload', () => { App.player.flushStats({ reason: 'quit' }); });
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
    App.render();
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
    await saveSettings({ background: { ...App.settings.background, type: 'image', value: r.path } });
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
