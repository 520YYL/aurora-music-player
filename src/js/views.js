/**
 * Aurora 极光音乐 —— 视图渲染（曲库 / 正在播放 / 播放列表）
 */
(function () {
  'use strict';
  const U = window.U;
  const { ce } = U;

  function coverUrl(track) {
    // 在线曲目的封面是主进程代理出来的地址，直接用它
    if (track && track.coverUrl) return track.coverUrl;
    if (track && track.hasCover) return U.coverUrlOf(track.id);
    return null;
  }
  function coverEl(track, cls) {
    const url = coverUrl(track);
    if (url) return ce('img', { class: cls, src: url, loading: 'lazy', alt: '' });
    return ce('div', { class: `${cls} ph`, text: '♪' });
  }

  function fmtBadge(track) {
    const fmt = (track.format || track.ext || '').toUpperCase();
    const lossless = track.lossless ? ' lossless' : '';
    return ce('span', { class: `badge-fmt${lossless}`, text: fmt, title: `${track.codec || fmt} ${track.bitrate ? Math.round(track.bitrate / 1000) + ' kbps' : ''} ${track.sampleRate ? (track.sampleRate / 1000) + ' kHz' : ''}` });
  }

  /* ================================================================== */
  /* 曲库视图                                                            */
  /* ================================================================== */
  function library(app) {
    const wrap = ce('div', { class: 'col', style: { height: '100%' } });
    const s = app.settings;
    const list = app.visibleTracks();
    // 只有「我的收藏」页才额外列出在线收藏
    const onlineFavs = app.state.view === 'favorites' ? (app.state.onlineFavs || []) : [];
    const titleMap = {
      library: ['全部音乐', `${list.length} 首 · 来自 ${(app.state.settings.library.roots || []).length} 个文件夹`],
      favorites: ['我的收藏', onlineFavs.length ? `${list.length} 首本地 · ${onlineFavs.length} 首在线` : `${list.length} 首`],
      recent: ['最近播放', `${list.length} 首`],
      playlist: [app.currentPlaylistName(), `${list.length} 首`]
    };
    const [t, sub] = titleMap[app.state.view] || ['音乐库', ''];
    const head = ce('div', { class: 'view-head' }, [
      ce('div', {}, [ce('h1', { text: t }), ce('div', { class: 'sub', text: sub })])
    ]);
    wrap.appendChild(head);

    // 工具条
    const tb = ce('div', { class: 'toolbar' });
    tb.appendChild(ce('button', { class: 'btn primary sm', html: '🔄 扫描曲库', onclick: () => app.rescan() }));
    tb.appendChild(ce('button', { class: 'btn sm', html: '📁 添加文件夹', onclick: () => app.addFolder() }));
    tb.appendChild(ce('div', { class: 'sep' }));
    tb.appendChild(ce('button', { class: 'btn sm', html: '▶ 播放全部', onclick: () => app.playAll() }));
    // 手动换封面：作用于选中的那一首，没选中就是正在播放的那首
    tb.appendChild(ce('button', {
      class: 'btn sm', html: '🖼 添加歌曲封面',
      title: '给选中的歌曲（或正在播放的歌曲）设置一张封面图',
      onclick: () => app.setTrackCover()
    }));
    if (app.state.view === 'playlist') {
      tb.appendChild(ce('button', { class: 'btn sm', html: '💾 导出', onclick: () => app.exportPlaylist() }));
      tb.appendChild(ce('button', { class: 'btn sm', html: '✏️ 重命名', onclick: () => app.renamePlaylist() }));
    }
    tb.appendChild(ce('div', { class: 'sep' }));
    const sortSel = ce('select', { class: 'btn sm', style: { padding: '5px 8px' }, onchange: (e) => app.setSort(e.target.value) });
    for (const [k, label] of [['manual', '自定义排序'], ['title', '标题'], ['artist', '歌手'], ['album', '专辑'], ['duration', '时长'], ['playedMs', '我的累计听歌时长'], ['playCount', '播放次数'], ['addedAt', '添加时间'], ['format', '格式'], ['path', '文件路径']]) {
      sortSel.appendChild(ce('option', { value: k, text: label, selected: s.ui.sortKey === k }));
    }
    tb.appendChild(ce('span', { class: 'muted', style: { fontSize: '12px' }, text: '排序' }));
    tb.appendChild(sortSel);
    tb.appendChild(ce('button', { class: 'btn icon sm', text: s.ui.sortDir === 'asc' ? '↑' : '↓', title: '升序/降序', onclick: () => app.toggleSortDir() }));
    tb.appendChild(ce('div', { class: 'sep' }));
    tb.appendChild(ce('button', { class: 'btn icon sm', text: s.ui.viewMode === 'list' ? '▦' : '☰', title: '列表 / 网格', onclick: () => app.toggleViewMode() }));
    tb.appendChild(ce('button', { class: 'btn icon sm', text: '🎲', title: '打乱顺序', onclick: () => app.shuffleOrder() }));
    if (app.state.selection.size) {
      tb.appendChild(ce('div', { class: 'sep' }));
      tb.appendChild(ce('span', { class: 'chip on', text: `已选 ${app.state.selection.size}` }));
      tb.appendChild(ce('button', { class: 'btn sm', text: '加入播放列表', onclick: () => app.addSelectionToPlaylist() }));
      tb.appendChild(ce('button', { class: 'btn sm danger', text: '从库中移除', onclick: () => app.removeSelection() }));
      tb.appendChild(ce('button', { class: 'btn sm ghost', text: '取消选择', onclick: () => { app.state.selection.clear(); app.render(); } }));
    }
    wrap.appendChild(tb);

    const body = ce('div', { class: 'view-body' });
    wrap.appendChild(body);

    const cols = '34px 34px minmax(160px, 2.6fr) minmax(110px, 1.5fr) 62px 60px 108px 84px 78px';

    /** 「我的收藏」页：本地收藏列表下面再接一段「在线收藏」（哔哩哔哩） */
    function appendOnlineFavs() {
      if (!onlineFavs.length) return;
      body.appendChild(ce('div', {
        style: {
          marginTop: '18px', padding: '10px 4px 8px', fontSize: '12px',
          fontWeight: '600', opacity: '.72', borderTop: '1px solid rgba(255,255,255,.08)'
        },
        text: `在线收藏 · ${onlineFavs.length} 首（来自哔哩哔哩）`
      }));
      const fh = ce('div', { class: 'track-head', style: { '--cols': cols } });
      for (const label of ['#', '', '标题', 'UP主', '格式', '时长', '来源', '', '操作']) {
        fh.appendChild(ce('div', { text: label }));
      }
      body.appendChild(fh);
      const box = ce('div', { class: 'track-list' });
      const frag2 = document.createDocumentFragment();
      onlineFavs.forEach((t2, i) => frag2.appendChild(onlineRow(app, t2, i, cols, onlineFavs)));
      box.appendChild(frag2);
      body.appendChild(box);
    }

    if (!list.length && !onlineFavs.length) {
      body.appendChild(ce('div', { class: 'empty' }, [
        ce('div', { class: 'big', text: '🎧' }),
        ce('h3', { text: app.state.search ? '没有找到匹配的歌曲' : '曲库还是空的' }),
        ce('p', { html: app.state.search ? '换个关键词试试，或清空搜索框。' : '点击「添加文件夹」选择你的音乐目录，支持 MP3 / OGG / M4A / FLAC / WAV / AAC。' }),
        ce('button', { class: 'btn primary', text: '📁 添加音乐文件夹', onclick: () => app.addFolder() })
      ]));
      return wrap;
    }

    if (s.ui.viewMode === 'grid') {
      const grid = ce('div', { class: 'grid-cards' });
      for (const t2 of list) {
        const card = ce('div', { class: 'card panel', onclick: () => app.playTrack(t2), oncontextmenu: (e) => app.contextMenu(e, t2) }, [
          coverEl(t2, 'cv'),
          ce('div', { class: 'nm', text: t2.title || t2.name }),
          ce('div', { class: 'ar', text: `${t2.artist || '未知歌手'} · ${U.fmtTime((t2.duration || 0) / 1000)}` })
        ]);
        card.ondblclick = () => app.playTrack(t2);
        grid.appendChild(card);
      }
      body.appendChild(grid);
      appendOnlineFavs();
      return wrap;
    }

    // 列表
    const head2 = ce('div', { class: 'track-head', style: { '--cols': cols } });
    const colDefs = [
      ['#', null], ['', null], ['标题', 'title'], ['专辑', 'album'], ['格式', 'format'],
      ['时长', 'duration'], ['累计听歌', 'playedMs'], ['播放次数', 'playCount'], ['操作', null]
    ];
    for (const [label, key] of colDefs) {
      const d = ce('div', { text: label });
      if (key) {
        if (s.ui.sortKey === key) d.classList.add('sorted');
        if (s.ui.sortKey === key && s.ui.sortDir === 'desc') d.classList.add('desc');
        d.onclick = () => app.setSort(key);
        d.title = '点击排序';
      }
      head2.appendChild(d);
    }
    body.appendChild(head2);

    const listEl = ce('div', { class: 'track-list' });
    const frag = document.createDocumentFragment();
    list.forEach((t2, i) => frag.appendChild(row(app, t2, i, cols)));
    listEl.appendChild(frag);
    body.appendChild(listEl);

    app.sortable = window.DragSort.makeSortable(listEl, {
      itemSelector: '.track-row',
      // 不限制抓手：整行都可以按住拖动排序（♥ 等按钮除外），
      // 这样不用去瞄准那个很小的 ⠿ 图标
      scrollParent: body,
      onReorder: (ids) => app.applyManualOrder(ids)
    });

    appendOnlineFavs();

    return wrap;
  }

  function row(app, t, i, cols) {
    const playing = app.player.current && app.player.current.id === t.id;
    const el = ce('div', {
      class: `track-row${playing ? ' playing' : ''}${app.state.selection.has(t.id) ? ' selected' : ''}`,
      'data-id': t.id,
      draggable: 'true',
      style: { '--cols': cols }
    });
    el.appendChild(ce('div', { class: 't-idx' }, [
      ce('span', { class: 'num', text: playing ? '♪' : String(i + 1) }),
      ce('span', { class: 'play-mini', text: '▶', onclick: (e) => { e.stopPropagation(); app.playTrack(t); } })
    ]));
    el.appendChild(ce('div', { class: 't-drag', text: '⠿', title: '拖动排序' }));
    el.appendChild(ce('div', { class: 't-main' }, [
      coverEl(t, 't-cover'),
      ce('div', { class: 'grow', style: { minWidth: 0 } }, [
        ce('div', { class: 't-title', text: t.title || t.name, title: t.path }),
        ce('div', { class: 't-sub', text: t.artist || '未知歌手' })
      ])
    ]));
    el.appendChild(ce('div', { class: 't-cell', text: t.album || '—', title: t.album || '' }));
    const fmtCell = ce('div', { class: 't-cell' });
    fmtCell.appendChild(fmtBadge(t));
    el.appendChild(fmtCell);
    el.appendChild(ce('div', { class: 't-cell', text: U.fmtTime((t.duration || 0) / 1000) }));
    const playedMs = app.trackPlayedMs(t.id);
    el.appendChild(ce('div', { class: 't-cell', text: U.fmtMs(playedMs), title: `累计听歌 ${U.fmtLong(playedMs)}` }));
    el.appendChild(ce('div', { class: 't-cell', text: `${t.playCount || 0} 次` }));
    const actions = ce('div', { class: 't-actions' }, [
      ce('button', { class: `btn icon ghost${t.favorite ? ' fav-on' : ''}`, text: t.favorite ? '♥' : '♡', title: '收藏 (Ctrl+D)', onclick: (e) => { e.stopPropagation(); app.toggleFavorite(t.id); } }),
      // 用 span 而不是 button：Chromium 里 button 上按住拖动不会触发 HTML5 拖拽事件
      ce('span', {
        class: 'btn icon ghost t-menu', text: '☰',
        title: '按住上下拖动可调整顺序 · 单击打开菜单',
        onclick: (e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); app.contextMenuAt(r.left - 150, r.bottom + 4, t); }
      })
    ]);
    el.appendChild(actions);

    el.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey) {
        if (app.state.selection.has(t.id)) app.state.selection.delete(t.id); else app.state.selection.add(t.id);
        app.render();
        return;
      }
      if (e.shiftKey && app.state.lastClickedId) {
        const list = app.visibleTracks();
        const a = list.findIndex((x) => x.id === app.state.lastClickedId);
        const b = list.findIndex((x) => x.id === t.id);
        if (a >= 0 && b >= 0) {
          for (let k = Math.min(a, b); k <= Math.max(a, b); k++) app.state.selection.add(list[k].id);
          app.render();
          return;
        }
      }
      app.state.selection.clear();
      app.state.lastClickedId = t.id;
      app.playTrackInList(t);
    });
    el.addEventListener('contextmenu', (e) => app.contextMenu(e, t));
    return el;
  }

  /* ================================================================== */
  /* 正在播放 / 歌词视图                                                  */
  /* ================================================================== */
  function nowPlaying(app) {
    const t = app.player.current;
    const wrap = ce('div', { class: 'view-body pad', style: { height: '100%' } });
    const np = ce('div', { class: 'now-playing' });

    const left = ce('div', { class: 'np-left' });
    left.appendChild(coverEl(t || {}, 'np-cover'));
    const info = ce('div', { class: 'np-info' });
    info.appendChild(ce('h2', { text: t ? (t.title || t.name) : '未播放' }));
    info.appendChild(ce('div', { class: 'ar', text: t ? `${t.artist || '未知歌手'}${t.album ? ' · ' + t.album : ''}` : '点击曲库中的歌曲开始播放' }));
    if (t) {
      const meta = ce('div', { class: 'row', style: { marginTop: '10px', flexWrap: 'wrap', gap: '6px' } }, [
        fmtBadge(t),
        t.online ? ce('span', { class: 'chip', text: '在线播放' }) : null,
        ce('span', { class: 'chip', text: U.fmtTime((t.duration || 0) / 1000) }),
        ce('span', { class: 'chip', text: `${t.bitrate ? Math.round(t.bitrate / 1000) + ' kbps' : '—'}` }),
        ce('span', { class: 'chip', text: `${t.sampleRate ? (t.sampleRate / 1000).toFixed(1) + ' kHz' : '—'}` }),
        ce('span', { class: 'chip', text: t.channels === 2 ? '立体声' : (t.channels === 1 ? '单声道' : '—') }),
        ce('span', { class: 'chip', id: 'npCumulative', text: `累计 ${U.fmtMs(app.trackLivePlayedMs(t.id))}` })
      ]);
      info.appendChild(meta);
      // 在线曲目没有本地文件，只保留云端相关的操作
      const opsList = t.online ? [
        ce('button', {
          class: `btn sm${t.favorite ? ' fav-on' : ''}`,
          text: t.favorite ? '♥ 已收藏' : '♡ 收藏',
          title: '收藏到「我的收藏」 (Ctrl+D)',
          onclick: () => app.toggleOnlineFavorite(t)
        }),
        ce('button', {
          class: 'btn sm', text: '🌐 在 B 站中打开',
          onclick: () => window.aurora.app.openExternal('https://www.bilibili.com/video/' + encodeURIComponent(t.videoId))
        }),
        ce('button', { class: 'btn sm', text: app.lyrics.sourcePath ? '🔄 重新载入歌词' : '🔍 查找歌词', onclick: () => app.reloadLyrics(true) })
      ] : [
        ce('button', { class: 'btn sm', text: '📂 所在文件夹', onclick: () => window.aurora.library.showInFolder(t.path) }),
        ce('button', { class: 'btn sm', text: '📝 导入歌词', onclick: () => app.importLyrics() }),
        ce('button', { class: 'btn sm', text: '✏️ 编辑歌词', onclick: () => app.editLyrics() }),
        ce('button', { class: 'btn sm', text: app.lyrics.sourcePath ? '🔄 重新载入歌词' : '🔍 查找歌词', onclick: () => app.reloadLyrics(true) })
      ];
      const ops = ce('div', { class: 'row', style: { marginTop: '12px', gap: '8px', flexWrap: 'wrap' } }, opsList);
      info.appendChild(ops);
    }
    left.appendChild(info);
    np.appendChild(left);

    const right = ce('div', { class: 'np-right' });
    const lbox = ce('div', { class: 'lyrics-box', id: 'lyricsBox' });
    right.appendChild(lbox);
    np.appendChild(right);
    wrap.appendChild(np);

    window.Lyrics.renderTo(lbox, app.lyrics, { onSeek: (s) => app.player.seek(s) });
    requestAnimationFrame(() => window.Lyrics.scrollToActive(lbox, false));
    return wrap;
  }

  /* ================================================================== */
  /* 在线音乐视图（哔哩哔哩公开接口）                                      */
  /* ================================================================== */
  function onlineRow(app, t, i, cols, list) {
    const playing = app.player.current && app.player.current.id === t.id;
    const el = ce('div', {
      class: `track-row${playing ? ' playing' : ''}`,
      'data-id': t.id,
      style: { '--cols': cols }
    });
    el.appendChild(ce('div', { class: 't-idx' }, [
      ce('span', { class: 'num', text: playing ? '♪' : String(i + 1) }),
      ce('span', { class: 'play-mini', text: '▶', onclick: (e) => { e.stopPropagation(); app.playOnlineAt(i, list); } })
    ]));
    el.appendChild(ce('div', { class: 't-drag' }));
    el.appendChild(ce('div', { class: 't-main' }, [
      coverEl(t, 't-cover'),
      ce('div', { class: 'grow', style: { minWidth: 0 } }, [
        ce('div', { class: 't-title', text: t.title, title: t.title }),
        ce('div', { class: 't-sub', text: t.artist })
      ])
    ]));
    el.appendChild(ce('div', { class: 't-cell', text: t.album || '—', title: t.album || '' }));
    const fmtCell = ce('div', { class: 't-cell' });
    fmtCell.appendChild(fmtBadge(t));
    el.appendChild(fmtCell);
    el.appendChild(ce('div', { class: 't-cell', text: U.fmtTime((t.duration || 0) / 1000) }));
    el.appendChild(ce('div', { class: 't-cell', text: '在线' }));
    el.appendChild(ce('div', { class: 't-cell' }));
    el.appendChild(ce('div', { class: 't-actions' }, [
      ce('button', {
        class: `btn icon ghost btn-fav${t.favorite ? ' fav-on' : ''}`,
        text: t.favorite ? '♥' : '♡', title: '收藏 (Ctrl+D)',
        onclick: (e) => { e.stopPropagation(); app.toggleOnlineFavorite(t); }
      }),
      ce('button', {
        class: 'btn icon ghost', text: '▶', title: '播放',
        onclick: (e) => { e.stopPropagation(); app.playOnlineAt(i, list); }
      })
    ]));
    el.addEventListener('click', () => app.playOnlineAt(i, list));
    return el;
  }

  function online(app) {
    const st = app.state.online || { query: '', loading: false, error: '', tracks: [] };
    const wrap = ce('div', { class: 'col', style: { height: '100%' } });

    const sub = st.error ? '搜索出错了'
      : st.loading ? '正在搜索…'
        : st.query ? `“${st.query}” · ${st.tracks.length} 首`
          : '在上方搜索框输入歌名或歌手，例如：周杰伦 晴天';
    wrap.appendChild(ce('div', { class: 'view-head' }, [
      ce('div', {}, [ce('h1', { text: '在线音乐' }), ce('div', { class: 'sub', text: sub })])
    ]));

    const tb = ce('div', { class: 'toolbar' });
    tb.appendChild(ce('button', {
      class: 'btn primary sm', html: '🔍 搜索在线音乐',
      onclick: () => { const s = document.querySelector('#search'); if (s) { s.focus(); s.select(); } }
    }));
    if (st.tracks.length) {
      tb.appendChild(ce('button', { class: 'btn sm', html: '▶ 播放全部结果', onclick: () => app.playOnlineAt(0, st.tracks) }));
    }
    tb.appendChild(ce('div', { class: 'sep' }));
    tb.appendChild(ce('span', { class: 'muted', style: { fontSize: '12px' }, text: '来自哔哩哔哩 · 无需 API Key · 播放时实时解析音频流' }));
    wrap.appendChild(tb);

    const body = ce('div', { class: 'view-body' });
    wrap.appendChild(body);

    if (st.loading) {
      body.appendChild(ce('div', { class: 'empty' }, [
        ce('div', { class: 'big', text: '⏳' }),
        ce('h3', { text: '正在搜索…' }),
        ce('p', { text: st.query })
      ]));
      return wrap;
    }
    if (st.error) {
      body.appendChild(ce('div', { class: 'empty' }, [
        ce('div', { class: 'big', text: '⚠️' }),
        ce('h3', { text: '在线搜索失败' }),
        ce('p', { text: st.error }),
        ce('button', { class: 'btn primary', text: '重试', onclick: () => app.onlineSearch(st.query) })
      ]));
      return wrap;
    }
    if (!st.tracks.length) {
      body.appendChild(ce('div', { class: 'empty' }, [
        ce('div', { class: 'big', text: '🌐' }),
        ce('h3', { text: st.query ? '没有找到匹配的歌曲' : '搜索在线音乐' }),
        ce('p', { html: st.query ? '换个关键词试试，或清空搜索框重新输入。' : '在顶部搜索框输入关键词（例如「周杰伦 晴天」）后按回车，即可搜索在线歌曲。<br>结果会显示歌名、歌手、UP主、封面和时长，点击即可播放，播放时自动按需解析音频流。' })
      ]));
      return wrap;
    }

    const cols = '34px 34px minmax(160px, 2.6fr) minmax(110px, 1.5fr) 62px 60px 108px 84px 78px';
    const head = ce('div', { class: 'track-head', style: { '--cols': cols } });
    for (const label of ['#', '', '标题', 'UP主', '格式', '时长', '来源', '', '操作']) {
      head.appendChild(ce('div', { text: label }));
    }
    body.appendChild(head);

    const listEl = ce('div', { class: 'track-list' });
    const frag = document.createDocumentFragment();
    st.tracks.forEach((t, i) => frag.appendChild(onlineRow(app, t, i, cols, st.tracks)));
    listEl.appendChild(frag);
    body.appendChild(listEl);
    return wrap;
  }

  /* ================================================================== */
  /* 播放列表视图                                                         */
  /* ================================================================== */
  function playlists(app) {
    const wrap = ce('div', { class: 'col', style: { height: '100%' } });
    wrap.appendChild(ce('div', { class: 'view-head' }, [
      ce('div', {}, [ce('h1', { text: '播放列表' }), ce('div', { class: 'sub', text: `${app.state.playlists.length} 个列表` })])
    ]));
    wrap.appendChild(ce('div', { class: 'toolbar' }, [
      ce('button', { class: 'btn primary sm', text: '＋ 新建播放列表', onclick: () => app.createPlaylist() }),
      ce('button', { class: 'btn sm', text: '📥 导入 JSON', onclick: () => app.importPlaylist() })
    ]));
    const body = ce('div', { class: 'view-body' });
    if (!app.state.playlists.length) {
      body.appendChild(ce('div', { class: 'empty' }, [
        ce('div', { class: 'big', text: '📚' }),
        ce('h3', { text: '还没有播放列表' }),
        ce('p', { text: '新建一个播放列表，把喜欢的歌拖进去。' })
      ]));
    } else {
      const grid = ce('div', { class: 'grid-cards' });
      for (const pl of app.state.playlists) {
        const first = app.state.tracks.find((t) => t.id === (pl.ids || [])[0]);
        const card = ce('div', { class: 'card panel', onclick: () => app.openPlaylist(pl.id), oncontextmenu: (e) => app.playlistContextMenu(e, pl) }, [
          first ? coverEl(first, 'cv') : ce('div', { class: 'cv ph', text: '📚' }),
          ce('div', { class: 'nm', text: pl.name }),
          ce('div', { class: 'ar', text: `${(pl.ids || []).filter((id) => app.state.tracks.some((t) => t.id === id)).length} 首` })
        ]);
        grid.appendChild(card);
      }
      body.appendChild(grid);
    }
    wrap.appendChild(body);
    return wrap;
  }

  window.Views = { library, nowPlaying, playlists, online, coverEl, coverUrl, fmtBadge };
})();
