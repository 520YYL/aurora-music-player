/**
 * Aurora 极光音乐 —— 面板视图（听歌统计 / 均衡器 / 音效插件 / 设置）
 */
(function () {
  'use strict';
  const U = window.U;
  const { ce } = U;
  const D = window.AURORA_DEFAULTS;
  const PR = window.AURORA_PRESETS;

  // 统计页当前可见的图表重画函数（窗口缩放 / 进出全屏时重画，避免被拉伸变形）
  let statsRedraw = null;
  window.addEventListener('resize', () => { if (typeof statsRedraw === 'function') statsRedraw(); });

  /* -------------------------- 通用小工具 -------------------------- */
  function section(title, desc) {
    const el = ce('div', { class: 'set-sec panel' });
    el.appendChild(ce('h3', { text: title }));
    if (desc) el.appendChild(ce('div', { class: 'desc', text: desc }));
    return el;
  }
  function setRow(label, sub, controls) {
    const ctl = ce('div', { class: 'ctl' });
    for (const c of [].concat(controls || [])) if (c) ctl.appendChild(c);
    return ce('div', { class: 'set-row' }, [
      ce('div', { class: 'lbl' }, [ce('span', { text: label }), sub ? ce('small', { text: sub }) : null]),
      ctl
    ]);
  }
  function slider(min, max, step, value, oninput, fmt) {
    const wrap = ce('div', { class: 'row', style: { flex: 1, gap: '8px', maxWidth: '420px' } });
    const val = ce('span', { class: 'mono', style: { minWidth: '58px', fontSize: '12px', textAlign: 'right' }, text: fmt ? fmt(value) : value });
    const inp = ce('input', { type: 'range', min, max, step, value, style: { flex: 1 } });
    const paint = () => { inp.style.setProperty('--fill', `${((inp.value - min) / (max - min)) * 100}%`); };
    inp.addEventListener('input', () => { val.textContent = fmt ? fmt(inp.value) : inp.value; paint(); oninput(Number(inp.value)); });
    paint();
    wrap.appendChild(inp); wrap.appendChild(val);
    return wrap;
  }
  function sw(on, onchange) {
    const s = ce('div', { class: `switch${on ? ' on' : ''}` });
    s.onclick = () => { const n = !s.classList.contains('on'); s.classList.toggle('on', n); onchange(n); };
    return s;
  }
  function select(options, value, onchange) {
    const s = ce('select', { onchange: (e) => onchange(e.target.value) });
    for (const o of options) s.appendChild(ce('option', { value: o.value, text: o.label, selected: String(o.value) === String(value) }));
    return s;
  }
  function colorInput(value, onchange) {
    const i = ce('input', { type: 'color', value: value || '#ffffff', style: { width: '46px', height: '30px', padding: '2px', cursor: 'pointer' } });
    i.addEventListener('input', () => onchange(i.value));
    return i;
  }

  /* ================================================================== */
  /* 听歌统计                                                            */
  /* ================================================================== */
  function stats(app) {
    const wrap = ce('div', { class: 'col', style: { height: '100%' } });
    const sum = app.state.stats || {};
    wrap.appendChild(ce('div', { class: 'view-head' }, [
      ce('div', {}, [
        ce('h1', { text: '听歌统计' }),
        ce('div', { class: 'sub', text: sum.firstDay ? `自 ${sum.firstDay} 开始记录，共 ${sum.activeDays || 0} 个有效听歌日` : '开始听歌后这里会记录每一天' })
      ]),
      ce('div', { class: 'grow' }),
      ce('button', { class: 'btn sm', text: '📤 导出数据', onclick: () => app.exportStats() }),
      ce('button', { class: 'btn sm danger', text: '🗑 重置统计', onclick: () => app.resetStats() })
    ]));

    const body = ce('div', { class: 'view-body' });

    const goalMs = (app.settings.stats.dailyGoalMinutes || 60) * 60000;
    const todayPct = goalMs ? Math.min(100, Math.round(((sum.today || 0) / goalMs) * 100)) : 0;
    const cards = [
      ['今日听歌', U.fmtLong(sum.today), `目标 ${app.settings.stats.dailyGoalMinutes} 分钟 · ${todayPct}%`],
      ['本月累计', U.fmtLong(sum.month), `本月 ${sum.monthActiveDays || 0} 天有听歌 · 日均 ${U.fmtLong(sum.monthAverage)}`],
      ['今年累计', U.fmtLong(sum.year), `今年 ${sum.yearActiveDays || 0} 天有听歌 · 日均 ${U.fmtLong(sum.yearAverage)}`],
      ['全部累计', U.fmtLong(sum.all), `历史日均 ${U.fmtLong(sum.allAverage)}`],
      ['本月自然日均', U.fmtLong(sum.monthAverageCalendar), '按本月已过天数平均'],
      ['今年自然日均', U.fmtLong(sum.yearAverageCalendar), '按今年已过天数平均']
    ];
    const cardWrap = ce('div', { class: 'stat-cards' });
    for (const [k, v, s] of cards) {
      cardWrap.appendChild(ce('div', { class: 'stat-card panel' }, [
        ce('div', { class: 'k', text: k }), ce('div', { class: 'v', text: v }), ce('div', { class: 's', text: s })
      ]));
    }
    body.appendChild(cardWrap);

    const goalRow = ce('div', { class: 'stat-card panel', style: { marginBottom: '16px' } }, [
      ce('div', { class: 'k', text: '今日目标进度' }),
      ce('div', { class: 'goal-bar' }, [ce('i', { style: { width: `${todayPct}%` } })]),
      ce('div', { class: 's', style: { marginTop: '6px' }, text: `${U.fmtLong(sum.today)} / ${app.settings.stats.dailyGoalMinutes} 分钟（${todayPct}%）` })
    ]);
    body.appendChild(goalRow);

    // ---- 听歌时长图表：天 / 周 / 月 / 年 四档任选（只画一张，不排成长条）----
    const RANGES = [
      { key: 'day', label: '天', hint: '最近 30 天 · 每天听歌时长' },
      { key: 'week', label: '周', hint: '最近 12 周 · 每周听歌时长' },
      { key: 'month', label: '月', hint: '最近 12 个月 · 每月听歌时长' },
      { key: 'year', label: '年', hint: '按年统计听歌时长' }
    ];
    let range = (app.settings.stats && app.settings.stats.range) || 'day';
    if (!RANGES.some((r) => r.key === range)) range = 'day';

    const seg = ce('div', { class: 'seg' });
    const chartTitle = ce('h3', {});
    const chart = ce('canvas', { class: 'chart' });
    const chartCard = ce('div', { class: 'chart-wrap panel' }, [
      ce('div', { class: 'chart-head' }, [chartTitle, seg]),
      chart
    ]);
    body.appendChild(chartCard);

    const series = () => {
      if (range === 'week') return { data: sum.weeks || [], label: (d) => `${d.week.slice(5)} 起`, name: '最近 12 周每周听歌时长', unit: '周' };
      if (range === 'month') return { data: sum.months || [], label: (d) => d.month, name: '最近 12 个月每月听歌时长', unit: '个月' };
      if (range === 'year') return { data: sum.years || [], label: (d) => `${d.year} 年`, name: '按年统计听歌时长', unit: '年' };
      return { data: sum.last30 || [], label: (d) => d.day.slice(5), name: '最近 30 天每日听歌时长', unit: '天' };
    };

    const redraw = () => {
      const { data, label, name, unit } = series();
      const total = data.reduce((a, b) => a + (b.ms || 0), 0);
      const active = data.filter((d) => (d.ms || 0) > 0).length;
      chartTitle.textContent = `${name} · 合计 ${U.fmtLong(total)}${active ? ` · ${active} ${unit}有记录` : ''}`;
      for (const b of seg.children) b.classList.toggle('primary', b.dataset.k === range);
      statsRedraw = () => drawChart(chart, data, label);
      setTimeout(() => { if (chart.isConnected) drawChart(chart, data, label); }, 0);
    };

    for (const r of RANGES) {
      seg.appendChild(ce('button', {
        class: `btn sm${r.key === range ? ' primary' : ''}`, 'data-k': r.key, text: r.label, title: r.hint,
        onclick: () => { range = r.key; app.saveSettings({ stats: { ...app.settings.stats, range } }); redraw(); }
      }));
    }

    // ---- 每首歌累计时长排行：本地曲库 + 统计里记录过的在线曲目（含「我的收藏」里的在线歌）----
    const SRC_NAME = { qq: 'QQ音乐', kugou: '酷狗音乐', netease: '网易云音乐', bilibili: '哔哩哔哩' };
    const localById = new Map((app.state.tracks || []).map((t) => [t.id, t]));
    const favById = new Map((app.state.onlineFavs || []).map((t) => [t.id, t]));
    const rank = [];
    for (const [id, rec] of Object.entries(sum.tracks || {})) {
      const ms = (rec && rec.ms) || 0;
      if (ms <= 0) continue;
      const local = localById.get(id);
      if (local) {
        rank.push({ t: local, ms, count: local.playCount || (rec && rec.count) || 0, last: local.lastPlayedAt || (rec && rec.last) || 0, online: false, play: local });
        continue;
      }
      // 在线曲目不在本地曲库里：先用「我的收藏」里的条目补名字，其次用统计记录里存下来的标题
      const fav = favById.get(id);
      const title = (fav && (fav.title || fav.name)) || (rec && rec.title) || id;
      const artist = (fav && fav.artist) || (rec && rec.artist) || '—';
      const source = (fav && fav.source) || (rec && rec.source) || '';
      rank.push({
        t: { id, title, artist, sourceName: (fav && fav.sourceName) || SRC_NAME[source] || '在线' },
        ms, count: (rec && rec.count) || 0, last: (rec && rec.last) || 0, online: true, play: fav || null
      });
    }
    rank.sort((a, b) => b.ms - a.ms);

    const onlineCount = rank.filter((x) => x.online).length;
    const rankBox = ce('div', { class: 'chart-wrap panel' });
    rankBox.appendChild(ce('h3', { text: `每首歌累计听歌时长（${rank.length} 首有记录${onlineCount ? ` · 含 ${onlineCount} 首在线` : ''}）` }));
    if (!rank.length) {
      rankBox.appendChild(ce('div', { class: 'muted', style: { fontSize: '12.5px', padding: '10px 0' }, text: '还没有听歌记录，播放几首后这里会出现排行。' }));
    } else {
      const COLS = '46px minmax(170px,2.4fr) minmax(100px,1.4fr) 84px 120px 96px 110px';
      const tbl = ce('div', {});
      const hd = ce('div', { class: 'track-head', style: { '--cols': COLS, position: 'static' } });
      for (const l of ['#', '歌曲', '歌手', '来源', '累计听歌', '播放次数', '上次播放']) hd.appendChild(ce('div', { text: l }));
      tbl.appendChild(hd);
      rank.slice(0, 100).forEach((x, i) => {
        const r = ce('div', { class: 'track-row', style: { '--cols': COLS, cursor: x.play ? 'pointer' : 'default' } });
        r.appendChild(ce('div', { class: 't-idx', text: String(i + 1) }));
        r.appendChild(ce('div', { class: 't-title ellipsis', text: x.t.title || x.t.name || x.t.id }));
        r.appendChild(ce('div', { class: 't-cell', text: x.t.artist || '—' }));
        r.appendChild(ce('div', { class: 't-cell', text: x.online ? `🌐 ${x.t.sourceName || '在线'}` : '💾 本地' }));
        r.appendChild(ce('div', { class: 't-cell', style: { color: 'var(--accent)', fontWeight: '700' }, text: U.fmtLong(x.ms) }));
        r.appendChild(ce('div', { class: 't-cell', text: `${x.count || 0} 次` }));
        r.appendChild(ce('div', { class: 't-cell', text: x.last ? U.fmtDateTime(x.last) : '—' }));
        if (x.play) r.onclick = () => app.playTrack(x.play);
        tbl.appendChild(r);
      });
      rankBox.appendChild(tbl);
    }
    body.appendChild(rankBox);
    wrap.appendChild(body);

    redraw();
    return wrap;
  }

  function drawChart(canvas, data, labelFn) {
    if (!canvas || !canvas.isConnected) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width || 600; const h = rect.height || 172;
    canvas.width = Math.floor(w * dpr); canvas.height = Math.floor(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const cs = getComputedStyle(document.documentElement);
    const accent = (cs.getPropertyValue('--accent') || '#7c5cff').trim();
    const accent2 = (cs.getPropertyValue('--accent2') || '#22d3ee').trim();
    const muted = (cs.getPropertyValue('--muted') || '#888').trim();
    const padL = 46; const padB = 22; const padT = 10; const padR = 8;
    const cw = w - padL - padR; const ch = h - padT - padB;
    const vals = data.map((d) => (d.ms || 0) / 60000);
    const max = Math.max(1, ...vals);
    // 网格
    ctx.strokeStyle = 'rgba(140,145,170,.22)';
    ctx.fillStyle = muted;
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const y = padT + (ch * i) / 4;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.fillText(`${Math.round((max * (4 - i)) / 4)}m`, padL - 6, y + 4);
    }
    if (!data.length) {
      ctx.textAlign = 'center';
      ctx.fillText('暂无数据', w / 2, h / 2);
      return;
    }
    const bw = cw / data.length;
    ctx.textAlign = 'center';
    data.forEach((d, i) => {
      const v = (d.ms || 0) / 60000;
      const bh = max > 0 ? (v / max) * ch : 0;
      const x = padL + i * bw + bw * 0.16;
      const y = padT + ch - bh;
      const g = ctx.createLinearGradient(0, y, 0, padT + ch);
      g.addColorStop(0, accent2); g.addColorStop(1, accent);
      ctx.fillStyle = v > 0 ? g : 'rgba(140,145,170,.25)';
      const bwidth = Math.max(2, bw * 0.68);
      const r = Math.min(3, bwidth / 2);
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + bwidth, y, x + bwidth, padT + ch, r);
      ctx.arcTo(x + bwidth, padT + ch, x, padT + ch, r);
      ctx.arcTo(x, padT + ch, x, y, r);
      ctx.arcTo(x, y, x + bwidth, y, r);
      ctx.closePath();
      ctx.fill();
      if (data.length <= 14 || i % Math.ceil(data.length / 12) === 0) {
        ctx.fillStyle = muted;
        ctx.fillText(String(labelFn(d)).slice(-5), padL + i * bw + bw / 2, h - 6);
      }
    });
  }

  /* ================================================================== */
  /* 均衡器                                                              */
  /* ================================================================== */
  function eq(app) {
    const wrap = ce('div', { class: 'col', style: { height: '100%' } });
    const eqs = app.settings.eq;
    wrap.appendChild(ce('div', { class: 'view-head' }, [
      ce('div', {}, [ce('h1', { text: '均衡器' }), ce('div', { class: 'sub', text: '10 段参数均衡 · 实时生效 · 可保存自定义预设' })])
    ]));
    const body = ce('div', { class: 'view-body' });
    const panel = ce('div', { class: 'eq-panel panel' });
    const EQ_MIN = -12;
    const EQ_MAX = 12;
    const bandRefs = [];
    const preampRef = { inp: null, out: null };
    const paintFill = (inp) => {
      const pct = ((Number(inp.value) - EQ_MIN) / (EQ_MAX - EQ_MIN)) * 100;
      inp.style.setProperty('--fill', `${pct}%`);
    };
    const paintFillPreamp = (inp) => {
      const pct = ((Number(inp.value) - EQ_MIN) / (EQ_MAX - EQ_MIN)) * 100;
      inp.style.setProperty('--fill', `${pct}%`);
    };

    // 前置放大：自己拼一个可被预设更新的滑块
    const preampWrap = ce('div', { class: 'row', style: { flex: 1, gap: '8px', maxWidth: '300px' } });
    const preampOut = ce('span', { class: 'mono', style: { minWidth: '54px', fontSize: '12px', textAlign: 'right' }, text: `${eqs.preamp} dB` });
    const preampInp = ce('input', { type: 'range', min: EQ_MIN, max: EQ_MAX, step: 0.5, value: eqs.preamp, style: { flex: 1 } });
    preampInp.oninput = () => {
      preampOut.textContent = `${Number(preampInp.value)} dB`;
      paintFillPreamp(preampInp);
      app.setEq({ preamp: Number(preampInp.value) });
    };
    paintFillPreamp(preampInp);
    preampWrap.appendChild(preampInp);
    preampWrap.appendChild(preampOut);
    preampRef.inp = preampInp;
    preampRef.out = preampOut;

    panel.appendChild(ce('div', { class: 'row', style: { justifyContent: 'space-between' } }, [
      ce('div', { class: 'row' }, [
        ce('span', { style: { fontWeight: '700' }, text: '启用均衡器' }),
        sw(eqs.enabled, (v) => app.setEq({ enabled: v }))
      ]),
      ce('div', { class: 'row' }, [
        ce('span', { class: 'muted', style: { fontSize: '12px' }, text: '前置放大' }),
        preampWrap,
        (() => {
          const btn = ce('button', { class: 'btn sm', text: '重置' });
          btn.onclick = () => {
            const zero = new Array(10).fill(0);
            app.setEq({ bands: zero, preamp: 0, preset: '默认' });
            zero.forEach((v, i) => {
              const r = bandRefs[i];
              if (!r) return;
              r.inp.value = '0'; r.db.textContent = '0.0'; paintFill(r.inp);
            });
            preampInp.value = '0'; preampOut.textContent = '0 dB'; paintFillPreamp(preampInp);
            pl.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c.dataset.preset === '默认'));
          };
          return btn;
        })()
      ])
    ]));

    const bandsWrap = ce('div', { class: 'eq-bands' });
    D.EQ_FREQS.forEach((f, i) => {
      const b = ce('div', { class: 'eq-band' });
      const db = ce('div', { class: 'db', text: `${(eqs.bands[i] || 0).toFixed(1)}` });
      const inp = ce('input', {
        type: 'range', class: 'eq-slider', min: EQ_MIN, max: EQ_MAX, step: 0.5,
        value: eqs.bands[i] || 0, title: `${f} Hz`
      });
      paintFill(inp);
      inp.oninput = () => {
        db.textContent = Number(inp.value).toFixed(1);
        paintFill(inp);
        app.setEqBand(i, Number(inp.value));
      };
      // 双击归零
      inp.ondblclick = () => {
        inp.value = '0'; db.textContent = '0.0'; paintFill(inp); app.setEqBand(i, 0);
      };
      const box = ce('div', { class: 'slider-box' }, [inp]);
      b.appendChild(db);
      b.appendChild(box);
      b.appendChild(ce('div', { class: `hz${f === 1000 ? ' zero' : ''}`, text: f >= 1000 ? `${f / 1000}k` : String(f) }));
      bandsWrap.appendChild(b);
      bandRefs.push({ inp, db });
    });
    panel.appendChild(ce('div', { class: 'row', style: { justifyContent: 'space-between', fontSize: '10.5px', color: 'var(--muted)', marginTop: '10px' } }, [
      ce('span', { text: '＋12 dB' }),
      ce('span', { text: '拖动滑块调节 · 双击归零' }),
      ce('span', { text: '－12 dB' })
    ]));
    panel.appendChild(bandsWrap);

    panel.appendChild(ce('div', { class: 'divider' }));
    panel.appendChild(ce('div', { class: 'muted', style: { fontSize: '12px', marginBottom: '8px' }, text: '预设' }));
    const pl = ce('div', { class: 'preset-list' });
    // 单击预设时「就地」把 10 个滑块推到位，不重建页面（重建会中断拖动并闪烁）
    const applyPresetToUi = (bands, preset, preamp) => {
      bands.forEach((v, i) => {
        const r = bandRefs[i];
        if (!r) return;
        r.inp.value = String(v);
        r.db.textContent = Number(v).toFixed(1);
        paintFill(r.inp);
      });
      if (typeof preamp === 'number' && preampRef.inp) {
        preampRef.inp.value = String(preamp);
        preampRef.out.textContent = `${preamp} dB`;
        paintFillPreamp(preampRef.inp);
      }
      pl.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c.dataset.preset === preset));
    };
    for (const name of Object.keys(PR.EQ_PRESETS)) {
      const btn = ce('button', { class: `chip${eqs.preset === name ? ' on' : ''}`, text: name, 'data-preset': name });
      btn.onclick = () => {
        const bands = PR.EQ_PRESETS[name].slice();
        app.setEq({ bands, preset: name });
        applyPresetToUi(bands, name);
      };
      pl.appendChild(btn);
    }
    const custom = (app.settings.eq.customPresets || {});
    for (const name of Object.keys(custom)) {
      const btn = ce('button', { class: `chip${eqs.preset === name ? ' on' : ''}`, text: `⭐ ${name}`, 'data-preset': name });
      btn.onclick = () => {
        const bands = custom[name].bands.slice();
        const pre = custom[name].preamp || 0;
        app.setEq({ bands, preamp: pre, preset: name });
        applyPresetToUi(bands, name, pre);
      };
      pl.appendChild(btn);
    }
    panel.appendChild(pl);
    panel.appendChild(ce('div', { class: 'row', style: { marginTop: '12px', gap: '8px' } }, [
      ce('button', { class: 'btn sm primary', text: '＋ 保存当前为预设', onclick: () => app.saveEqPreset() }),
      ce('button', { class: 'btn sm', text: '导出均衡器设置', onclick: () => app.exportEq() })
    ]));
    body.appendChild(panel);
    wrap.appendChild(body);
    return wrap;
  }

  /* ================================================================== */
  /* 音效插件                                                            */
  /* ================================================================== */
  function plugins(app) {
    const wrap = ce('div', { class: 'col', style: { height: '100%' } });
    const installed = app.settings.plugins.installed || [];
    const enabled = app.settings.plugins.enabled || [];
    wrap.appendChild(ce('div', { class: 'view-head' }, [
      ce('div', {}, [
        ce('h1', { text: '音效插件' }),
        ce('div', { class: 'sub', text: `${installed.length} 个可用 · ${enabled.length} 个已启用 · 可叠加，按顺序串联处理` })
      ]),
      ce('div', { class: 'grow' }),
      ce('button', { class: 'btn primary sm', text: '📥 导入插件', onclick: () => app.importPlugins() }),
      ce('button', { class: 'btn sm', text: '📂 插件目录', onclick: () => window.aurora.plugins.openFolder() }),
      ce('button', { class: 'btn sm', text: '♻️ 恢复内置', onclick: () => app.resetPlugins() })
    ]));
    const body = ce('div', { class: 'view-body' });

    const tip = ce('div', { class: 'panel', style: { padding: '12px 16px', marginBottom: '14px', fontSize: '12.5px', lineHeight: '1.9' } });
    tip.innerHTML = '<b>插件格式</b>：支持导入 <span class="mono">.auroraplugin</span> / <span class="mono">.json</span> 音效描述文件，也支持直接导入 <span class="mono">wav/ogg/mp3/flac</span> 脉冲响应文件自动生成卷积混响插件。<br>描述文件示例：<span class="mono">{ "name": "我的音效", "graph": [ { "type": "biquad", "params": { "type": "lowshelf", "freq": 100, "gain": 6 } } ], "params": [ { "key": "gain", "label": "强度", "min": 0, "max": 12, "default": 6 } ] }</span>';
    body.appendChild(tip);

    const grid = ce('div', { class: 'plugin-grid' });
    for (const p of installed) {
      const isOn = enabled.includes(p.id);
      const card = ce('div', { class: `plugin-card panel${isOn ? ' on' : ''}`, 'data-plugin-id': p.id });
      card.appendChild(ce('div', { class: 'head' }, [
        ce('div', { style: { fontSize: '20px' }, text: catIcon(p.category) }),
        ce('div', { class: 'grow' }, [
          ce('div', { class: 'nm', text: p.name }),
          ce('div', { class: 'muted', style: { fontSize: '11px' }, text: `${p.author || ''} ${p.version ? 'v' + p.version : ''}${p.builtin ? ' · 内置' : ' · 导入'}` })
        ]),
        sw(isOn, (v) => app.togglePlugin(p.id, v))
      ]));
      card.appendChild(ce('div', { class: 'ds', text: p.desc || '' }));
      const params = p.params || [];
      const saved = (app.settings.plugins.params || {})[p.id] || {};
      if (params.length) {
        const pw = ce('div', { class: 'params' });
        for (const prm of params) {
          const val = saved[prm.key] !== undefined ? saved[prm.key] : prm.default;
          const row = ce('div', { class: 'prow' });
          row.appendChild(ce('span', { style: { minWidth: '58px' }, text: prm.label || prm.key }));
          const inp = ce('input', { type: 'range', min: prm.min, max: prm.max, step: prm.step || 1, value: val });
          const out = ce('span', { class: 'mono', style: { minWidth: '42px', textAlign: 'right' }, text: `${val}${prm.unit || ''}` });
          inp.oninput = () => { out.textContent = `${inp.value}${prm.unit || ''}`; app.setPluginParam(p.id, prm.key, Number(inp.value)); };
          row.appendChild(inp); row.appendChild(out);
          pw.appendChild(row);
        }
        card.appendChild(pw);
      }
      card.appendChild(ce('div', { class: 'row', style: { gap: '6px', marginTop: 'auto' } }, [
        ce('button', { class: 'btn sm', text: '试听 / 应用', onclick: () => app.togglePlugin(p.id, !enabled.includes(p.id)) }),
        !p.builtin ? ce('button', { class: 'btn sm danger', text: '删除', onclick: () => app.removePlugin(p.id) }) : null
      ]));
      grid.appendChild(card);
    }
    body.appendChild(grid);
    wrap.appendChild(body);
    return wrap;
  }

  function catIcon(c) {
    return ({ 空间: '🌌', 人声: '🎤', 动态: '📈', 染色: '🎛️', 场景: '🎬', 监听: '🎧', 趣味: '📞', 导入: '📦' })[c] || '✨';
  }

  /* ================================================================== */
  /* 设置                                                                */
  /* ================================================================== */
  const SC_LABELS = {
    playPause: '播放 / 暂停', next: '下一首', prev: '上一首',
    toggleMain: '显示 / 隐藏主窗口', toggleMini: '开关迷你播放器', toggleDesktopLyrics: '桌面歌词'
  };

  function settings(app) {
    const s = app.settings;
    const wrap = ce('div', { class: 'col', style: { height: '100%' } });
    wrap.appendChild(ce('div', { class: 'view-head' }, [
      ce('div', {}, [ce('h1', { text: '设置' }), ce('div', { class: 'sub', text: '外观、歌词、快捷键、播放行为与数据' })])
    ]));
    const body = ce('div', { class: 'view-body' });
    const grid = ce('div', { class: 'settings-grid' });
    const nav = ce('div', { class: 'settings-nav' });
    const sections = ce('div', {});

    const ids = [
      ['appearance', '🎨 外观与背景'], ['playback', '▶ 播放与过渡'],
      ['shortcuts', '⌨️ 快捷键'], ['library', '📁 曲库'], ['stats', '📊 统计'], ['data', '💾 数据与关于']
    ];
    for (const [id, label] of ids) {
      nav.appendChild(ce('div', { class: 'nav-item', text: label, onclick: () => { const el = sections.querySelector(`[data-sec="${id}"]`); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }));
    }
    grid.appendChild(nav);

    /* ---------- 外观 ---------- */
    const secA = section('外观与背景', '主题风格、强调色、自定义背景图片');
    secA.dataset.sec = 'appearance';
    const themePick = ce('div', { class: 'theme-picker' });
    for (const th of D.THEMES) {
      const item = ce('div', {
        class: `theme-item${s.theme === th.id ? ' sel' : ''}`,
        onclick: () => {
          app.saveSettings({ theme: th.id });
          // 只移动高亮，不重建页面（重建会闪一下）
          themePick.querySelectorAll('.theme-item').forEach((x) => x.classList.toggle('sel', x === item));
        }
      }, [
        ce('div', { class: `pv pv-${th.id}` }), ce('div', { class: 'nm', text: th.name }), ce('div', { class: 'ds', text: th.desc })
      ]);
      themePick.appendChild(item);
    }
    secA.appendChild(themePick);
    secA.appendChild(ce('div', { class: 'divider' }));
    const accents = ['#7c5cff', '#22d3ee', '#ff5f7e', '#34d399', '#fbbf24', '#f472b6', '#60a5fa', '#a78bfa', '#fb7185', '#14b8a6'];
    const dotEls = [];
    for (const c of accents) {
      const dot = ce('div', { class: `color-dot${s.accent === c ? ' sel' : ''}`, style: { background: c } });
      dot.onclick = () => {
        app.saveSettings({ accent: c });
        dotEls.forEach((x) => x.classList.toggle('sel', x === dot));
      };
      dotEls.push(dot);
    }
    secA.appendChild(setRow('强调色', '主色调 / 高亮色', dotEls));
    secA.appendChild(setRow('次强调色', '渐变第二色', [colorInput(s.accent2, (v) => app.saveSettings({ accent2: v }))]));
    secA.appendChild(setRow('圆角', '整体圆润程度', [slider(0, 32, 1, s.radius, (v) => app.saveSettings({ radius: v }), (v) => `${v}px`)]));
    secA.appendChild(setRow('界面密度', null, [select([{ value: 'compact', label: '紧凑' }, { value: 'cozy', label: '标准' }, { value: 'comfy', label: '宽松' }], s.density, (v) => app.saveSettings({ density: v }))]));
    secA.appendChild(setRow('动态极光背景', '跟随主题色调流动的光晕', [sw(s.animatedBg, (v) => app.saveSettings({ animatedBg: v }))]));
    secA.appendChild(ce('div', { class: 'divider' }));
    // 背景类型/清除背景会改变这一块的 DOM 结构（预览缩略图），需要重绘
    secA.appendChild(setRow('背景类型', '渐变 / 自定义图片 / 纯色', [select([{ value: 'gradient', label: '动态渐变' }, { value: 'image', label: '自定义图片' }, { value: 'color', label: '纯色' }, { value: 'none', label: '无背景' }], s.background.type, (v) => app.saveSettings({ background: { ...s.background, type: v } }, { rerender: true }))]));
    const bgRow = setRow('背景图片', s.background.value || '未选择', [
      ce('button', { class: 'btn sm', text: '🖼 选择图片', onclick: () => app.pickBackground() }),
      ce('button', { class: 'btn sm', text: '清除', onclick: () => app.saveSettings({ background: { ...s.background, type: 'gradient', value: '' } }, { rerender: true }) })
    ]);
    if (s.background.value) {
      const pv = ce('div', { class: 'bg-preview', style: { backgroundImage: `url("${window.aurora.app.bgUrl(s.background.value)}")` } });
      bgRow.querySelector('.ctl').appendChild(pv);
    }
    secA.appendChild(bgRow);
    secA.appendChild(setRow('背景模糊', null, [slider(0, 40, 1, s.background.blur, (v) => app.saveSettings({ background: { ...s.background, blur: v } }), (v) => `${v}px`)]));
    secA.appendChild(setRow('背景变暗', null, [slider(0, 0.9, 0.05, s.background.dim, (v) => app.saveSettings({ background: { ...s.background, dim: v } }), (v) => `${Math.round(v * 100)}%`)]));
    secA.appendChild(setRow('背景饱和', null, [slider(0.4, 2, 0.05, s.background.saturate, (v) => app.saveSettings({ background: { ...s.background, saturate: v } }), (v) => `${v}×`)]));
    sections.appendChild(secA);

    /* ---------- 播放与过渡 ---------- */
    const P = s.playback;
    const secP = section('播放与过渡', '切歌过渡效果、变速变调、播放行为');
    secP.dataset.sec = 'playback';
    {
      const L = s.lyrics || {};
      const styleSel = ce('select', {}, []);
      for (const [v, t] of [['karaoke', '逐字（唱到哪亮到哪）'], ['classic', '整句高亮'], ['minimal', '极简（无阴影）']]) {
        styleSel.appendChild(ce('option', { value: v, text: t, selected: (L.style || 'karaoke') === v }));
      }
      styleSel.onchange = () => app.saveSettings({ lyrics: { ...L, style: styleSel.value } });
      secP.appendChild(setRow('桌面歌词', '独立透明浮层：圆形封面 + 逐字字幕。右键浮层可调外观 / 关闭', [
        sw(!!L.desktopEnabled, (v) => app.toggleDesktopLyrics(v)),
        ce('button', { class: 'btn sm', text: '↺ 回到默认位置', onclick: () => window.aurora.lyrics.resetPos() })
      ]));
      secP.appendChild(setRow('桌面歌词风格', '更多外观选项在浮层上右键打开', [styleSel]));
      secP.appendChild(setRow('桌面歌词字号', '正在唱 / 翻译 / 下一句三行统一用这个字号，区分主次靠颜色和透明度；浮层上还能调行距、透明度、配色、封面', [
        slider(12, 90, 1, L.fontSize || 26, (v) => app.saveSettings({ lyrics: { ...L, fontSize: v } }), (v) => `${v}px`)
      ]));

      const JP_FONTS = [
        ['"Meiryo", "Yu Gothic UI", "MS PGothic", "Hiragino Sans", "Noto Sans JP", sans-serif', 'Meiryo / 游ゴシック'],
        ['"Yu Gothic UI", "Meiryo", "Noto Sans JP", sans-serif', '游ゴシック UI'],
        ['"MS PGothic", "Meiryo", sans-serif', 'MS PGothic'],
        ['"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif', 'Hiragino 角ゴシック'],
        ['"Microsoft YaHei UI", "PingFang SC", sans-serif', '跟随中文字体']
      ];
      const jpSel = ce('select', {}, []);
      for (const [v, t] of JP_FONTS) {
        jpSel.appendChild(ce('option', { value: v, text: t, selected: (L.jpFont || JP_FONTS[0][0]) === v }));
      }
      jpSel.onchange = () => app.saveSettings({ lyrics: { ...L, jpFont: jpSel.value } });
      secP.appendChild(setRow('日文字体', '日语歌词单独用这套字体渲染（中文 / 西文各用各的字体）', [jpSel]));
      secP.appendChild(setRow('日语字幕自动翻译', '日语（及纯外语）歌词会去网易云匹配同一首歌的中文翻译，显示成中日 / 中英双语', [
        sw(L.jpTrans !== false, (v) => { app.saveSettings({ lyrics: { ...L, jpTrans: v } }); app.reloadLyrics(true); })
      ]));
    }
    secP.appendChild(setRow('切歌过渡效果', '切换歌曲时的衔接方式', [select(D.TRANSITIONS.map((t) => ({ value: t.id, label: `${t.name} — ${t.desc}` })), P.transition, (v) => app.saveSettings({ playback: { ...P, transition: v } }))]));
    secP.appendChild(setRow('过渡时长', null, [slider(200, 5000, 100, P.transitionMs, (v) => app.saveSettings({ playback: { ...P, transitionMs: v } }), (v) => `${(v / 1000).toFixed(1)}s`)]));
    secP.appendChild(setRow('变速不变调', '关闭后变速会像磁带一样改变音高', [sw(P.preservePitch, (v) => { app.saveSettings({ playback: { ...P, preservePitch: v } }); app.player.engine.setPreservePitch(v); })]));
    secP.appendChild(setRow('播放速度', '0.5× ~ 3.0×', [slider(0.5, 3, 0.05, P.rate, (v) => app.setRate(v), (v) => `${Number(v).toFixed(2)}×`)]));
    secP.appendChild(setRow('变调', '−12 ~ +12 半音，独立于速度', [slider(-12, 12, 1, P.pitch, (v) => app.setPitch(v), (v) => `${v > 0 ? '+' : ''}${v} 半音`)]));
    secP.appendChild(setRow('音量', null, [slider(0, 1, 0.01, P.volume, (v) => app.setVolume(v), (v) => `${Math.round(v * 100)}%`)]));
    secP.appendChild(setRow('记住播放位置', '下次播放从上次位置继续', [sw(P.rememberPosition, (v) => app.saveSettings({ playback: { ...P, rememberPosition: v } }))]));
    secP.appendChild(setRow('自动播放下一首', null, [sw(P.autoPlayNext, (v) => app.saveSettings({ playback: { ...P, autoPlayNext: v } }))]));
    secP.appendChild(setRow('播放模式', '也可在播放栏点击切换', [select([
      { value: 'sequential', label: '顺序播放' }, { value: 'repeat-all', label: '列表循环' },
      { value: 'repeat-one', label: '单曲循环' }, { value: 'shuffle', label: '随机播放' }
    ], P.mode, (v) => { app.player.setMode(v); app.saveSettings({ playback: { ...P, mode: v } }); })]));
    sections.appendChild(secP);

    /* ---------- 快捷键 ---------- */
    const secS = section('快捷键', '全局快捷键在窗口不在前台时也能响应（媒体键 / 全局组合键）');
    secS.dataset.sec = 'shortcuts';
    // 应用内快捷键已按用户要求整体下架：只保留这一句提示，不再渲染应用内那一组。
    secS.appendChild(ce('div', { class: 'muted', style: { fontSize: '12.5px', margin: '2px 0 10px', lineHeight: '1.9' } },
      [ce('div', { text: '应用内快捷键已移除，键盘操作保留这几项（不可配置）：' }),
       ce('div', { class: 'mono', style: { fontSize: '11.5px', marginTop: '4px' }, text: '空格 播放/暂停 · ← → 快进/后退 5 秒 · ↑ ↓ 音量 · Esc 关闭弹层 · / 聚焦搜索框 · 桌面歌词窗上右键可调外观' })]));
    secS.appendChild(ce('div', { class: 'muted', style: { fontSize: '12.5px', margin: '14px 0 8px' }, text: '全局快捷键（系统级）' }));
    const sc2 = ce('div', { class: 'sc-list' });
    for (const [key, label] of Object.entries(SC_LABELS)) {
      if (s.shortcuts.global[key] === undefined) continue;
      sc2.appendChild(scItem(app, 'global', key, label, s.shortcuts.global[key]));
    }
    secS.appendChild(sc2);
    secS.appendChild(ce('div', { class: 'row', style: { marginTop: '14px', gap: '8px' } }, [
      ce('button', { class: 'btn sm', text: '↺ 全部恢复默认', onclick: () => app.resetShortcuts() }),
      ce('button', { class: 'btn sm', text: '🔍 检查占用', onclick: () => app.checkShortcuts() })
    ]));
    sections.appendChild(secS);

    /* ---------- 曲库 ---------- */
    const secLib = section('曲库与扫描', '管理音乐文件夹与扫描行为');
    secLib.dataset.sec = 'library';
    const rootsBox = ce('div', { class: 'col', style: { gap: '6px', marginBottom: '10px' } });
    for (const r of s.library.roots || []) {
      rootsBox.appendChild(ce('div', { class: 'sc-item' }, [
        ce('span', { text: '📁' }),
        ce('span', { class: 'nm mono', style: { fontSize: '11.5px' }, text: r }),
        ce('button', { class: 'btn sm', text: '扫描', onclick: () => app.rescan(r) }),
        ce('button', { class: 'btn sm danger', text: '移除', onclick: () => app.removeRoot(r) })
      ]));
    }
    secLib.appendChild(rootsBox);
    secLib.appendChild(setRow('添加文件夹', null, [
      ce('button', { class: 'btn sm primary', text: '＋ 选择文件夹', onclick: () => app.addFolder() }),
      ce('button', { class: 'btn sm', text: '🔄 重新扫描全部', onclick: () => app.rescan() })
    ]));
    secLib.appendChild(setRow('启动时自动扫描', null, [sw(s.library.autoScan, (v) => app.saveSettings({ library: { ...s.library, autoScan: v } }))]));
    sections.appendChild(secLib);

    /* ---------- 统计 ---------- */
    const secSt = section('听歌统计', '记录每日 / 每月 / 每年听歌时长与每首歌的累计时长');
    secSt.dataset.sec = 'stats';
    secSt.appendChild(setRow('启用统计', null, [sw(s.stats.enabled, (v) => app.saveSettings({ stats: { ...s.stats, enabled: v } }))]));
    secSt.appendChild(setRow('单曲最短计入时长', '少于该秒数的切换不计入统计', [slider(0, 120, 1, s.stats.minSeconds, (v) => app.saveSettings({ stats: { ...s.stats, minSeconds: v } }), (v) => `${v} 秒`)]));
    secSt.appendChild(setRow('每日目标', null, [slider(10, 480, 5, s.stats.dailyGoalMinutes, (v) => app.saveSettings({ stats: { ...s.stats, dailyGoalMinutes: v } }), (v) => `${v} 分钟`)]));
    secSt.appendChild(setRow('数据操作', null, [
      ce('button', { class: 'btn sm', text: '📊 打开统计页', onclick: () => app.setView('stats') }),
      ce('button', { class: 'btn sm', text: '📤 导出', onclick: () => app.exportStats() }),
      ce('button', { class: 'btn sm danger', text: '🗑 重置', onclick: () => app.resetStats() })
    ]));
    sections.appendChild(secSt);

    /* ---------- 数据与关于 ---------- */
    const secD = section('数据与关于', '存储位置、缓存与版本信息');
    secD.dataset.sec = 'data';
    secD.appendChild(setRow('数据目录', s.__dataDir || '', [
      ce('button', { class: 'btn sm', text: '📂 打开', onclick: () => window.aurora.app.openDataDir() })
    ]));
    secD.appendChild(setRow('封面缓存', `${app.state.coverStats ? app.state.coverStats.count + ' 个 · ' + U.fmtSize(app.state.coverStats.bytes) : '—'}`, [
      ce('button', { class: 'btn sm', text: '🧹 清空缓存', onclick: () => app.clearCovers() })
    ]));
    secD.appendChild(setRow('桌面快捷方式', '在系统桌面创建启动图标', [
      ce('button', { class: 'btn sm primary', text: '🖥 创建桌面快捷方式', onclick: () => app.createShortcut() })
    ]));
    secD.appendChild(setRow('关闭窗口时', '关闭后隐藏到托盘，音乐继续播放；要退出请用托盘菜单的「退出」', [sw(s.ui.closeToTray !== false, (v) => app.setCloseToTray(v))]));
    secD.appendChild(ce('div', { class: 'divider' }));
    const about = app.state.appInfo;
    secD.appendChild(ce('div', { class: 'muted', style: { fontSize: '12.5px', lineHeight: '2' }, html: about ? `Aurora 极光音乐 v${about.version}<br>Electron ${about.electron} · Chromium ${about.chrome} · Node ${about.node}<br>播放格式：MP3 / OGG / M4A / FLAC / WAV / AAC / OPUS<br>数据目录：<span class="mono">${U.escapeHtml(about.dataDir)}</span>` : '' }));
    secD.appendChild(ce('div', { class: 'row', style: { marginTop: '12px', gap: '8px' } }, [
      ce('button', { class: 'btn sm', text: '♻️ 恢复全部默认设置', onclick: () => app.resetSettings() }),
      ce('button', { class: 'btn sm', text: '🔁 重启应用', onclick: () => window.aurora.app.restart() })
    ]));
    sections.appendChild(secD);

    grid.appendChild(sections);
    body.appendChild(grid);
    wrap.appendChild(body);
    return wrap;
  }

  function fontOptions() {
    return [
      { value: '"Microsoft YaHei UI", "PingFang SC", sans-serif', label: '微软雅黑 / 苹方' },
      { value: '"SimSun", "Songti SC", serif', label: '宋体' },
      { value: '"KaiTi", "Kaiti SC", serif', label: '楷体' },
      { value: '"SimHei", "Heiti SC", sans-serif', label: '黑体' },
      { value: '"Segoe UI", "Arial", sans-serif', label: 'Segoe UI / Arial' },
      { value: '"Georgia", "Times New Roman", serif', label: 'Georgia' },
      { value: '"Cascadia Mono", "Consolas", monospace', label: '等宽字体' }
    ];
  }

  function scItem(app, scope, key, label, accel) {
    const btn = ce('button', { class: 'kbd', text: U.prettyHotkey(accel) });
    btn.onclick = () => {
      btn.classList.add('recording');
      btn.textContent = '按下组合键…';
      const handler = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') { cleanup(); return; }
        const hk = U.hotkeyFromEvent(e);
        if (!hk) return;
        cleanup();
        app.setShortcut(scope, key, hk);
      };
      const cleanup = () => {
        document.removeEventListener('keydown', handler, true);
        btn.classList.remove('recording');
      };
      document.addEventListener('keydown', handler, true);
    };
    return ce('div', { class: 'sc-item' }, [
      ce('span', { class: 'nm', text: label }),
      btn,
      ce('button', { class: 'btn sm ghost', text: '✕', title: '清除', onclick: () => app.setShortcut(scope, key, '') })
    ]);
  }

  window.Panels = { stats, eq, plugins, settings, drawChart, section, setRow, slider, sw, select, colorInput };
})();
