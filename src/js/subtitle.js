/**
 * Aurora 极光音乐 —— 字幕 / 放映视图
 *
 * 一整页沉浸式字幕：模糊专辑封面马赛克打底 + 居中大字歌词 + 卡拉OK 逐字染色。
 * 不依赖任何设置项，主题令牌全部走 CSS 变量。
 * 生命周期：App.render() 每次重建视图都会新建一个实例；节点被移除后自绘循环自动停止。
 */
(function () {
  'use strict';

  const U = window.U;
  const { ce } = U;

  const MAX_TILES = 60;

  function subtitle(app) {
    const player = app.player;
    const lyrics = app.lyrics;
    const eng = app.engine;

    const wrap = ce('div', { class: 'subtitle-view' });

    /* ---------------- 背景：专辑封面马赛克 ---------------- */
    const bg = ce('div', { class: 'sub-bg' });
    const mosaic = ce('div', { class: 'sub-mosaic' });
    const covers = (app.state.tracks || []).filter((t) => t.hasCover);
    for (let i = 0; i < MAX_TILES; i++) {
      const t = covers.length ? covers[i % covers.length] : null;
      const cell = ce('i');
      if (t) cell.style.backgroundImage = `url("${U.coverUrlOf(t.id)}")`;
      cell.style.animationDelay = `${(-(i * 1.37) % 44).toFixed(1)}s`;
      mosaic.appendChild(cell);
    }
    bg.appendChild(mosaic);
    bg.appendChild(ce('div', { class: 'sub-bgblur' }));
    bg.appendChild(ce('div', { class: 'sub-scrim' }));
    wrap.appendChild(bg);

    const glow = ce('div', { class: 'sub-glow' });
    wrap.appendChild(glow);

    /* ---------------- 顶栏：曲目信息 / 时间 / 操作 ---------------- */
    const cur = player.current;
    const clock = ce('div', { class: 'sub-clock' });
    const playBtn = ce('button', { class: 'sub-icon', title: '播放 / 暂停（空格）' });
    const head = ce('header', { class: 'sub-head' }, [
      ce('div', { class: 'sub-meta' }, [
        ce('div', { class: 'sub-kicker', text: '字幕 · 放映' }),
        ce('div', { class: 'sub-title', text: cur ? (cur.title || cur.name) : '未播放' }),
        ce('div', { class: 'sub-artist', text: cur ? `${cur.artist || '未知歌手'}${cur.album ? ' · ' + cur.album : ''}` : '选择一首歌开始' })
      ]),
      ce('div', { class: 'sub-tools' }, [
        clock,
        ce('button', {
          class: 'sub-icon', title: '上一首', text: '⏮',
          onclick: () => player.prev()
        }),
        playBtn,
        ce('button', {
          class: 'sub-icon', title: '下一首', text: '⏭',
          onclick: () => player.next()
        }),
        ce('button', {
          class: 'sub-icon', title: '退出字幕模式（Esc）', text: '✕',
          onclick: () => app.setView('now')
        })
      ])
    ]);
    wrap.appendChild(head);
    function paintPlay() {
      const playing = player.playing && !eng.isPaused();
      playBtn.textContent = playing ? '⏸' : '▶';
    }
    playBtn.onclick = () => player.toggle();
    paintPlay();

    /* ---------------- 歌词主体 ---------------- */
    const stage = ce('div', { class: 'sub-stage' });
    const column = ce('div', { class: 'sub-column' });
    stage.appendChild(column);
    wrap.appendChild(stage);

    const empty = ce('div', { class: 'sub-empty' });
    empty.appendChild(ce('div', { class: 'big', text: '🎤' }));
    empty.appendChild(ce('h3', { text: '暂无歌词' }));
    empty.appendChild(ce('p', { text: '把同名 .lrc 文件放到歌曲旁边，或到「正在播放」页点「导入歌词」。' }));
    stage.appendChild(empty);

    /* ---------------- 底栏：进度 ---------------- */
    const fill = ce('i', { id: 'subFill' });
    const tCur = ce('span', { text: '0:00' });
    const tDur = ce('span', { text: '0:00' });
    const footTitle = ce('div', { class: 'sub-ftext ellipsis', text: cur ? (cur.title || cur.name) : '' });
    const foot = ce('footer', { class: 'sub-foot' }, [
      ce('div', { class: 'sub-frow' }, [tCur, ce('div', { class: 'sub-bar' }, [fill]), tDur]),
      ce('div', { class: 'sub-frow sub-fmeta' }, [footTitle, ce('span', { class: 'sub-hint', text: '空格 播放/暂停 · ← → 快进 · Esc 退出' })])
    ]);
    wrap.appendChild(foot);

    /* ---------------- 歌词行 DOM ---------------- */
    const refs = [];
    let lastKey = null;
    let lastIndex = -2;

    function lyricKey() {
      const first = lyrics.lines[0] || {};
      return `${lyrics.lines.length}|${lyrics.sourcePath || ''}|${lyrics.title || ''}|${first.t || 0}|${first.text || ''}`;
    }

    // 长行按进度用「滑动窗口」推进：保留句首一段完整文字，之后再往右滚。
    // 这样短句整句稳定显示，长句也不会因为截断而丢内容。
    function chunk(t) {
      const s = String(t || '').trim();
      if (!s) return [];
      if (s.length <= 22) return [s];
      const win = 17;
      const step = 12;
      const out = [s.length <= 30 ? s : s.slice(0, win)];
      for (let i = win; i < s.length; i += step) out.push('…' + s.slice(i - 3, i - 3 + win));
      return out;
    }

    function build(l) {
      column.innerHTML = '';
      refs.length = 0;
      if (!l) {
        column.classList.add('hidden');
        empty.classList.remove('hidden');
        return;
      }
      column.classList.remove('hidden');
      empty.classList.add('hidden');
      const frag = document.createDocumentFragment();
      lyrics.lines.forEach((line, i) => {
        const el = ce('div', { class: `sub-line${line.isCJK ? ' zh' : ' en'}`, 'data-i': i });
        el.appendChild(ce('span', { class: 'sub-src', text: line.text }));
        if (line.tr) el.appendChild(ce('span', { class: 'sub-tr', text: line.tr }));
        frag.appendChild(el);
        refs.push({ el, src: el.querySelector('.sub-src'), chunks: chunk(line.text), lastChunk: -1 });
      });
      column.appendChild(frag);
      lastIndex = -2;
    }

    /* ---------------- 每帧刷新 ---------------- */
    function frame() {
      // 视图已被替换掉：停止自绘，避免离开页面后还在跑 rAF
      if (!wrap.isConnected) return;
      requestAnimationFrame(frame);

      const pos = eng.position();
      const dur = eng.duration();
      paintPlay();
      clock.textContent = U.fmtTimeTight(pos);

      tCur.textContent = U.fmtTimeTight(pos);
      tDur.textContent = U.fmtTimeTight(dur);
      fill.style.width = `${dur ? U.clamp(pos / dur, 0, 1) * 100 : 0}%`;
      glow.classList.toggle('on', player.playing && !eng.isPaused());

      if (!lyrics.lines.length) {
        if (lastKey !== '') { build(null); lastKey = ''; }
        return;
      }

      // 歌词整体换了（切歌 / 重新导入）才重建 DOM，否则每帧只改 class 与染色
      const key = `${player.current ? player.current.id : ''}|${lyricKey()}`;
      if (key !== lastKey) { build(lyrics.lines[0]); lastKey = key; }

      // 注意：lyrics.update() 被调用时会推进「当前行」索引，而播放器的 time 事件
      // 每帧也会调它一次。两次调用的时间点略有差异时，先调的一方会把索引推进，
      // 后调的一方拿到 changed=false —— 此时如果用索引去取行首时间算进度，
      // 就会和上一行的行首时间比，染色时机会偏。
      // 所以这里不依赖返回值，统一按「本次实际求得的索引」重算。
      const idx = lyrics.indexAt(pos);
      lyrics.current = idx;
      if (idx !== lastIndex) {
        refs.forEach((r, i) => {
          r.el.classList.toggle('active', i === idx);
          r.el.classList.toggle('past', i < idx);
        });
        lastIndex = idx;
      }

      const active = refs[idx];
      if (active) {
        // 整句按播放进度分段落推进：长句一段段浮现，比逐字硬切染色干净得多
        const p = lyrics.progress(pos);
        const n = active.chunks.length;
        // p 可能略小于 0（advance 与帧时间不同步），此时保持第一段，不要显示成"还没唱就跳段"
        const ci = U.clamp(Math.floor(Math.max(0, p) * n), 0, n - 1);
        if (ci !== active.lastChunk) {
          active.lastChunk = ci;
          active.src.textContent = active.chunks[ci];
        }
        // 把唱到的那一行推到接近垂直居中的位置
        const maxShift = Math.max(0, (column.scrollHeight - stage.clientHeight) / 2 + 96);
        const shift = U.clamp(active.el.offsetTop - stage.clientHeight * 0.34, -maxShift, maxShift);
        column.style.transform = `translate3d(0, ${-shift}px, 0)`;
      }
    }

    requestAnimationFrame(frame);
    return wrap;
  }

  window.Views = window.Views || {};
  window.Views.subtitle = subtitle;
})();
