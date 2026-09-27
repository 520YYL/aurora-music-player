/**
 * Aurora 极光音乐 —— 迷你播放器（音频浮动板块）
 */
(function () {
  'use strict';
  const api = window.aurora;
  const $ = (s) => document.querySelector(s);

  let payload = null;
  let lines = [];
  let M = {};

  const vizBars = [];
  const viz = $('#viz');
  for (let i = 0; i < 22; i++) { const b = document.createElement('i'); viz.appendChild(b); vizBars.push(b); }
  let vizRaf = null;
  let fakePhase = 0;

  function tickViz() {
    vizRaf = requestAnimationFrame(tickViz);
    if (!payload || !payload.playing) {
      fakePhase += 0.03;
      for (let i = 0; i < vizBars.length; i++) {
        const v = (Math.sin(fakePhase + i * 0.5) + 1) / 2 * 0.25 + 0.06;
        vizBars[i].style.height = `${3 + v * 20}px`;
      }
      return;
    }
    fakePhase += 0.09;
    for (let i = 0; i < vizBars.length; i++) {
      const v = (Math.sin(fakePhase + i * 0.7) * Math.sin(fakePhase * 0.37 + i)) ** 2;
      const h = 3 + Math.min(1, Math.abs(v) * 1.6 + 0.15) * 20;
      vizBars[i].style.height = `${h}px`;
    }
  }
  tickViz();

  function applySettings(m) {
    if (!m) return;
    M = m;
    viz.classList.toggle('off', m.showVisualizer === false);
    document.getElementById('wrap').style.opacity = String(m.opacity === undefined ? 0.94 : m.opacity);
  }

  api.on('mini:sync', (p) => {
    if (!p) return;
    payload = p;
    if (p.settings && p.settings.mini) applySettings(p.settings.mini);
    if (p.settings && p.settings.theme) document.documentElement.dataset.theme = p.settings.theme;
    const cover = $('#cover');
    if (p.hasCover && p.coverId) {
      cover.textContent = '';
      cover.style.backgroundImage = `url("aurora://local/cover?id=${p.coverId}")`;
      cover.style.backgroundSize = 'cover';
    } else {
      cover.style.backgroundImage = '';
      cover.textContent = '♪';
    }
    $('#title').textContent = p.title || '未播放';
    $('#artist').textContent = p.artist || (p.album || 'Aurora 极光音乐');
    $('#play').textContent = p.playing ? '⏸' : '▶';
    $('#time').textContent = `${window.U.fmtTime(p.position)} / ${window.U.fmtTime(p.duration)}`;
    const ratio = p.duration ? Math.min(1, p.position / p.duration) : 0;
    $('#fill').style.width = `${ratio * 100}%`;
    const modeMap = { sequential: '🔁', 'repeat-all': '🔁', 'repeat-one': '🔂', shuffle: '🔀' };
    $('#mode').textContent = modeMap[p.mode] || '🔁';
    if (p.lines && p.lines.length) {
      const l = p.lines[p.lyricIndex];
      $('#lyric').textContent = l ? l.text : '';
    } else if (p.full) $('#lyric').textContent = '';
  });

  api.on('mini:settings', (m) => applySettings(m));

  $('#play').onclick = () => api.player.command('playPause');
  $('#next').onclick = () => api.player.command('next');
  $('#prev').onclick = () => api.player.command('prev');
  $('#mode').onclick = () => api.player.command('repeat');
  $('#dl').onclick = () => api.player.command('toggleDesktopLyrics');
  $('#main').onclick = () => api.app.focusMain();
  $('#expand').onclick = () => api.app.focusMain();
  $('#close').onclick = () => api.mini.toggle(false);
  $('#pbar').onclick = (e) => {
    // 迷你窗口无法直接 seek，发送 10% 步进命令
    const r = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - r.left) / r.width;
    if (payload && payload.duration) {
      $('#fill').style.width = `${ratio * 100}%`;
      api.player.command(`seekRatio:${ratio.toFixed(4)}`);
    }
  };
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  api.settings.get().then((s) => { if (s && s.mini) applySettings(s.mini); });
})();
