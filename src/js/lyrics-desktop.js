/**
 * Aurora 极光音乐 —— 桌面歌词浮层
 */
(function () {
  'use strict';
  const U = window.U;
  const api = window.aurora;
  const $ = (s) => document.querySelector(s);

  const el = {
    root: $('#root'), cur: $('#cur'), tr: $('#tr'), nxt: $('#nxt'), empty: $('#empty'),
    bar: $('#bar'), tools: $('#tools'), settings: $('#settings'),
    btnPlay: $('#btnPlay'), btnLock: $('#btnLock'), btnTop: $('#btnTop')
  };

  let payload = null;
  let lines = [];
  let curIdx = -1;
  let L = {};
  let gotPayload = false;   // 是否已经收到过同步数据（没收到前不要显示「暂无歌词」）
  let settingsKey = '';     // 上一次应用的外观设置指纹
  let linesKey = '';        // 上一次应用的歌词指纹
  let preludeText = '';     // 前奏期正在显示的那句
  // 性能计数：用来验证「不会每秒反复重建 DOM / 反复改窗口大小」
  window.__perf = { sync: 0, linesApplied: 0, rendered: 0, resizes: 0 };

  function applySettings(s) {
    if (!s) return;
    L = s;
    document.documentElement.dataset.theme = (payload && payload.settings && payload.settings.theme) || 'glass';
    if (L.accent) document.documentElement.style.setProperty('--accent', L.accent);
    const sh = L.shadow || {};
    const stroke = L.stroke || {};
    const shadowCss = sh.enabled ? `${sh.x || 0}px ${sh.y || 2}px ${sh.blur || 12}px ${rgba(sh.color || '#000', sh.opacity === undefined ? 0.85 : sh.opacity)}` : 'none';
    const base = {
      fontSize: `${L.fontSize || 34}px`,
      fontWeight: String(L.weight || 700),
      textAlign: L.align || 'center',
      textShadow: shadowCss,
      color: L.color || '#fff',
      opacity: String(L.opacity === undefined ? 0.96 : L.opacity),
      webkitTextStroke: stroke.enabled ? `${stroke.width || 1.2}px ${stroke.color || '#000'}` : '0px transparent',
      lineHeight: `${(L.fontSize || 34) * 1.28}px`
    };
    Object.assign(el.cur.style, base);
    Object.assign(el.tr.style, base, { fontSize: `${Math.round((L.fontSize || 34) * 0.62)}px`, webkitTextStroke: stroke.enabled ? `${(stroke.width || 1.2) * 0.7}px ${stroke.color || '#000'}` : '0px transparent' });
    Object.assign(el.nxt.style, base, { fontSize: `${Math.round((L.fontSize || 34) * 0.66)}px`, opacity: '0.5' });
    el.cur.style.fontFamily = L.cnFont || '';
    el.tr.style.fontFamily = L.cnFont || '';
    el.nxt.style.fontFamily = L.cnFont || '';
    el.root.style.gap = `${L.lineGap || 14}px`;
    el.root.style.background = 'transparent';
    el.btnLock.classList.toggle('on', !!L.locked);
    el.btnLock.textContent = L.locked ? '🔒' : '🔓';
    el.btnTop.classList.toggle('on', L.alwaysOnTop !== false);
    el.bar.classList.toggle('hidden', !L.showProgressBar);
    el.nxt.classList.toggle('hidden', L.showNextLine === false);
    el.tr.classList.toggle('hidden', L.showTranslation === false);
    el.root.classList.toggle('locked', !!L.locked);
    scheduleResize();
  }

  function rgba(hex, a) {
    const h = String(hex).replace('#', '');
    const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const n = parseInt(f || '000000', 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  function setLines(newLines) {
    lines = newLines || [];
    curIdx = -1;
    preludeText = '';
    renderLine(true);
  }

  function renderLine(force) {
    const i = payload ? payload.lyricIndex : -1;
    const active = lines[i];
    if (!active) {
      if (!lines.length) {
        el.cur.classList.add('hidden'); el.tr.classList.add('hidden'); el.nxt.classList.add('hidden');
        if (!gotPayload) {
          // 还没收到任何数据：先什么都不显示，避免误报「暂无歌词」
          el.empty.classList.add('hidden');
          return;
        }
        el.empty.classList.remove('hidden');
        el.empty.textContent = payload && payload.title ? `♪ ${payload.title} — 暂无歌词` : '等待播放…';
        return;
      }
      // 还没唱到第一句（前奏）：把第一句当作「即将开始」显示，避免整屏空白
      el.empty.classList.add('hidden');
      el.cur.classList.add('hidden');
      el.tr.classList.add('hidden');
      // 注意：同步消息里的字段是 position（秒），不是 current
      const wanted = (payload && payload.duration && lines[0]) ? lines[0].text : '';
      if (wanted) {
        if (preludeText !== wanted) {
          preludeText = wanted;
          el.nxt.textContent = wanted;
          el.nxt.style.fontFamily = lines[0].isCJK ? (L.cnFont || '') : (L.enFont || '');
          scheduleResize();
        }
        el.nxt.classList.remove('hidden');
      } else {
        el.nxt.classList.add('hidden');
      }
      return;
    }
    el.empty.classList.add('hidden');
    el.cur.classList.remove('hidden');
    if (curIdx !== i || force) {
      curIdx = i;
      window.__perf.rendered++;
      el.cur.innerHTML = '';
      const src = document.createElement('span');
      src.className = 'src';
      src.textContent = active.text;
      el.cur.appendChild(src);
      el.cur.style.fontFamily = active.isCJK ? (L.cnFont || '') : (L.enFont || '');
      if (active.tr && L.showTranslation !== false) {
        el.tr.innerHTML = '';
        const t = document.createElement('span');
        t.className = 'tr-text';
        t.textContent = active.tr;
        el.tr.appendChild(t);
        el.tr.classList.remove('hidden');
      } else el.tr.classList.add('hidden');

      const nx = lines[i + 1];
      if (nx && L.showNextLine !== false) {
        el.nxt.textContent = nx.text;
        el.nxt.classList.remove('hidden');
        el.nxt.style.fontFamily = nx.isCJK ? (L.cnFont || '') : (L.enFont || '');
      } else el.nxt.classList.add('hidden');
      scheduleResize();
    }
    // 卡拉OK染色
    if (L.karaoke !== false) {
      const p = Math.round((payload.lyricProgress || 0) * 1000) / 10;
      // 唱过的部分用主题色；还没唱的部分压暗（纯白在深色壁纸上反而比主题色更抢眼）
      const unsung = `color-mix(in srgb, ${L.color || '#ffffff'} 52%, transparent)`;
      el.cur.style.background = `linear-gradient(90deg, ${L.activeColor || '#7c5cff'} ${p}%, ${unsung} ${p}%)`;
      el.cur.style.webkitBackgroundClip = 'text';
      el.cur.style.backgroundClip = 'text';
      el.cur.style.webkitTextFillColor = 'transparent';
    } else {
      el.cur.style.background = 'none';
      el.cur.style.webkitTextFillColor = L.activeColor || '#fff';
    }
  }

  let resizeTimer = null;
  function scheduleResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const needed = el.root.scrollHeight + 24;
      const cur = window.innerHeight;
      if (Math.abs(needed - cur) > 10) {
        window.__perf.resizes++;
        api.app.setSize(window.innerWidth, Math.max(110, Math.min(480, needed)));
      }
    }, 160);
  }

  api.on('lyrics:sync', (p) => {
    if (!p) return;
    gotPayload = true;
    payload = p;
    window.__perf.sync++;
    // 外观设置只在真的变了时才应用：applySettings 末尾会校正窗口高度，
    // 如果每次同步都调用，透明浮层会被每秒 4 次改尺寸 —— 观感就是「一卡一卡」。
    if (p.settings && p.settings.lyrics) {
      const key = JSON.stringify(p.settings.lyrics);
      if (key !== settingsKey) { settingsKey = key; applySettings(p.settings.lyrics); }
    }
    if (p.settings && p.settings.theme) document.documentElement.dataset.theme = p.settings.theme;
    // 歌词正文同样只在内容变化时才重建 DOM
    if (p.lines) {
      const key = `${p.lines.length}|${p.lines[0] ? p.lines[0].text : ''}|${p.lyricVersion || ''}`;
      if (key !== linesKey) { linesKey = key; window.__perf.linesApplied++; setLines(p.lines); }
    }
    renderLine(false);
    el.btnPlay.textContent = p.playing ? '⏸' : '▶';
    if (L.showProgressBar && p.duration) el.bar.style.width = `${Math.min(100, (p.position / p.duration) * 100)}%`;
  });

  api.on('lyrics:settings', (s) => { if (s) { applySettings(s); renderLine(true); } });
  api.on('shortcut:action', () => { /* 主窗口已处理 */ });

  el.btnPlay.onclick = () => api.player.command('playPause');
  document.querySelector('#btnPrev').onclick = () => api.player.command('prev');
  document.querySelector('#btnNext').onclick = () => api.player.command('next');
  document.querySelector('#btnClose').onclick = () => api.lyrics.toggle(false);
  el.btnLock.onclick = async () => {
    const next = !L.locked;
    L.locked = next;
    await api.lyrics.lock(next);
    applySettings(L);
  };
  el.btnTop.onclick = async () => {
    const next = !(L.alwaysOnTop !== false);
    L.alwaysOnTop = next;
    await api.lyrics.setAlwaysOnTop(next);
    applySettings(L);
  };

  /* ---------------- 内置 QUICK 设置面板 ---------------- */
  const btnSettings = document.querySelector('#btnSettings');
  btnSettings.onclick = () => {
    el.settings.classList.toggle('open');
    if (el.settings.classList.contains('open')) buildSettings();
  };

  async function patchLyrics(patch) {
    L = { ...L, ...patch };
    applySettings(L);
    renderLine(true);
    await api.lyrics.update({ ...L, ...patch });
  }

  function srow(label, control, valueText) {
    const r = document.createElement('div');
    r.className = 'srow';
    const l = document.createElement('label');
    l.textContent = label;
    r.appendChild(l);
    r.appendChild(control);
    if (valueText) { const v = document.createElement('span'); v.className = 'val'; v.textContent = valueText; r.appendChild(v); }
    return r;
  }

  function range(min, max, step, value, onInput) {
    const i = document.createElement('input');
    i.type = 'range'; i.min = min; i.max = max; i.step = step; i.value = value;
    i.oninput = () => onInput(Number(i.value));
    return i;
  }
  function color(value, onInput) {
    const i = document.createElement('input');
    i.type = 'color'; i.value = value || '#ffffff';
    i.oninput = () => onInput(i.value);
    return i;
  }
  function check(on, onChange) {
    const b = document.createElement('button');
    b.className = `sbtn${on ? ' primary' : ''}`;
    b.textContent = on ? '已开启' : '已关闭';
    b.onclick = () => onChange(!on);
    return b;
  }

  function buildSettings() {
    const box = el.settings;
    box.innerHTML = '';
    const h = document.createElement('div');
    h.className = 'shead';
    h.textContent = '歌词外观 · 快捷设置';
    box.appendChild(h);

    box.appendChild(srow('字号', range(14, 90, 1, L.fontSize || 34, (v) => patchLyrics({ fontSize: v })), `${L.fontSize || 34}px`));
    box.appendChild(srow('行间距', range(0, 60, 1, L.lineGap || 14, (v) => patchLyrics({ lineGap: v })), `${L.lineGap || 14}px`));
    box.appendChild(srow('不透明度', range(0.15, 1, 0.01, L.opacity === undefined ? 0.96 : L.opacity, (v) => patchLyrics({ opacity: v })), `${Math.round((L.opacity || 0.96) * 100)}%`));
    box.appendChild(srow('字重', range(300, 900, 100, L.weight || 700, (v) => patchLyrics({ weight: Number(v) })), String(L.weight || 700)));
    box.appendChild(srow('常规色', color(L.color, (v) => patchLyrics({ color: v }))));
    box.appendChild(srow('当前色', color(L.activeColor, (v) => patchLyrics({ activeColor: v }))));

    const alignSel = document.createElement('select');
    for (const [v, t] of [['left', '左对齐'], ['center', '居中'], ['right', '右对齐']]) {
      const o = document.createElement('option'); o.value = v; o.textContent = t; o.selected = (L.align || 'center') === v; alignSel.appendChild(o);
    }
    alignSel.onchange = () => patchLyrics({ align: alignSel.value });
    box.appendChild(srow('对齐', alignSel));

    box.appendChild(srow('阴影', check(L.shadow && L.shadow.enabled, (v) => patchLyrics({ shadow: { ...(L.shadow || {}), enabled: v } }))));
    box.appendChild(srow('阴影色', color((L.shadow && L.shadow.color) || '#000000', (v) => patchLyrics({ shadow: { ...(L.shadow || {}), color: v } }))));
    box.appendChild(srow('阴影模糊', range(0, 40, 1, (L.shadow && L.shadow.blur) || 12, (v) => patchLyrics({ shadow: { ...(L.shadow || {}), blur: v } }))));
    box.appendChild(srow('阴影 X', range(-20, 20, 1, (L.shadow && L.shadow.x) || 0, (v) => patchLyrics({ shadow: { ...(L.shadow || {}), x: v } }))));
    box.appendChild(srow('阴影 Y', range(-20, 20, 1, (L.shadow && L.shadow.y) || 2, (v) => patchLyrics({ shadow: { ...(L.shadow || {}), y: v } }))));
    box.appendChild(srow('描边', check(L.stroke && L.stroke.enabled, (v) => patchLyrics({ stroke: { ...(L.stroke || {}), enabled: v } }))));
    box.appendChild(srow('描边色', color((L.stroke && L.stroke.color) || '#000000', (v) => patchLyrics({ stroke: { ...(L.stroke || {}), color: v } }))));
    box.appendChild(srow('描边宽', range(0, 6, 0.1, (L.stroke && L.stroke.width) || 1.2, (v) => patchLyrics({ stroke: { ...(L.stroke || {}), width: v } }))));
    box.appendChild(srow('翻译', check(L.showTranslation !== false, (v) => patchLyrics({ showTranslation: v }))));
    box.appendChild(srow('下一句', check(L.showNextLine !== false, (v) => patchLyrics({ showNextLine: v }))));
    box.appendChild(srow('卡拉OK', check(L.karaoke !== false, (v) => patchLyrics({ karaoke: v }))));
    box.appendChild(srow('进度条', check(!!L.showProgressBar, (v) => patchLyrics({ showProgressBar: v }))));
    box.appendChild(srow('鼠标穿透', check(!!L.clickThrough, async (v) => { L.clickThrough = v; await api.lyrics.setClickThrough(v); applySettings(L); })));

    const btns = document.createElement('div');
    btns.className = 'srow';
    const b1 = document.createElement('button'); b1.className = 'sbtn'; b1.textContent = '↺ 重置位置';
    b1.onclick = () => api.lyrics.resetPos();
    const b2 = document.createElement('button'); b2.className = 'sbtn'; b2.textContent = '打开完整设置';
    b2.onclick = () => api.app.focusMain();
    btns.appendChild(b1); btns.appendChild(b2);
    box.appendChild(btns);
  }

  document.addEventListener('contextmenu', (e) => { e.preventDefault(); el.settings.classList.toggle('open'); if (el.settings.classList.contains('open')) buildSettings(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') el.settings.classList.remove('open'); });

  // 初始拉取设置
  api.settings.get().then((s) => { if (s && s.lyrics) applySettings(s.lyrics); });
  // 窗口刚加载好，主动索要一次歌词（否则可能错过开窗时的那条同步消息）
  api.lyrics.requestSync().catch(() => {});
  window.addEventListener('DOMContentLoaded', () => { api.lyrics.requestSync().catch(() => {}); });
})();
