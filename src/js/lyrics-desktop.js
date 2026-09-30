/**
 * Aurora 极光音乐 —— 桌面歌词浮层
 *
 * 布局：左侧圆形（或圆角方）封面 + 右侧歌词。
 * 逐字：当前句用 background-clip:text 画一条渐变光带，唱到的字依次亮起。
 *   —— 注意不要退回「一个字一个 <span>」的做法：那样一行要几十个节点，
 *      每帧都要重排，之前就踩过「字幕一卡一卡」的坑。
 * 性能：外观设置和歌词正文各自比较指纹，只有真变了才重建 DOM；
 *      窗口尺寸**只跟设置有关、固定不变**：以前按每句歌词的实际宽度贴紧内容，
 *      结果换一句窗口就变一次大小（长句撑开、短句缩回），现在只在设置或面板变化时重算。
 */
(function () {
  'use strict';

  const api = window.aurora;
  const U = window.U;
  const $ = (s) => document.querySelector(s);

  const el = {
    root: $('#root'), bg: $('#bg'), cover: $('#cover'), coverRing: $('#coverRing'),
    coverWrap: $('#coverWrap'), spec: $('#spec'),
    lyr: $('#lyr'), cur: $('#cur'), tr: $('#tr'), nxt: $('#nxt'), empty: $('#empty'),
    bar: $('#bar'), barFill: $('#bar > i'), panel: $('#panel')
  };

  let payload = null;
  let lines = [];
  let curIdx = -1;
  let L = {};
  let gotPayload = false;    // 收到同步数据前不要显示「暂无歌词」
  let settingsKey = '';
  let linesKey = '';
  let preludeText = '';
  let curLineRange = null;   // [startSec, endSec]，用于算逐字进度
  let lastCoverId = null;
  let lastProgress = 0;   // 最近一次的逐字进度，改外观设置时用它补刷染色
  let resizeHold = false; // 拖动滑杆期间先别重算窗口（每动一格 setSize 会让整个窗一格格地跳）
  let resizeHoldT = null;
  let panelMore = false;  // 面板里的「更多设置」是否展开
  let openPicker = null;  // 面板里展开的取色器：null | 'active' | 'unsung'

  /**
   * 播放位置的本地插值。
   * 主窗口的同步限频在 4Hz（250ms 一跳），如果直接用它的 position 画逐字光带，
   * 光带就会一秒只走 4 步，看起来像帧率很低。
   * 这里把「最近一次同步的位置 + 当时的时间戳」记下来，之后每帧按经过的真实时间往前推，
   * 于是高亮可以按 60fps 平滑推进；一旦收到新的同步就重新对齐，不会累积漂移。
   */
  const posRef = { pos: 0, at: 0, rate: 1, playing: false, anchorPos: 0 };

  function setPosRef(position, rate, playing) {
    const p = Number(position) || 0;
    posRef.pos = p;
    posRef.anchorPos = p;
    posRef.at = performance.now();
    posRef.rate = Number(rate) > 0 ? Number(rate) : 1;
    posRef.playing = !!playing;
  }

  /** 当前估算的播放位置（秒） */
  function livePosition() {
    if (!posRef.playing) return posRef.pos;
    const dt = (performance.now() - posRef.at) / 1000 * posRef.rate;
    // 兜底：两次同步之间最多只外推 1.5 秒，超过说明同步断了，别继续瞎跑
    return posRef.pos + Math.min(Math.max(dt, 0), 1.5);
  }

  window.__perf = { sync: 0, linesApplied: 0, rendered: 0, resizes: 0, frames: 0 };

  /* ================================================================== */
  /* 配色方案：只留三套常用预设，其余用下面的取色器自定义                  */
  /* ================================================================== */
  const PALETTES = [
    { name: '极光紫', color: '#ffffff', active: '#7c5cff', unsung: '#8a90a8' },
    { name: '青空', color: '#ffffff', active: '#22d3ee', unsung: '#7f93a0' },
    { name: '烈焰', color: '#fff4f0', active: '#ff7a45', unsung: '#a08a80' }
  ];

  const STYLES = [
    { id: 'karaoke', name: '逐字' },
    { id: 'classic', name: '整句' },
    { id: 'minimal', name: '极简' }
  ];

  const hexToRgba = (hex, a) => U.hexToRgba(hex, a);

  /* ================================================================== */
  /* 外观                                                                */
  /* ================================================================== */
  function applySettings(s) {
    if (!s) return;
    L = s;

    // 主题色注入（供封面光环、进度条、面板使用）
    document.documentElement.style.setProperty('--accentA', L.activeColor || '#7c5cff');
    document.documentElement.style.setProperty('--accentB', L.unsungColor || '#22d3ee');

    // 三行歌词（正在唱 / 翻译 / 下一句）统一用这一个固定字号。
    // 以前「翻译 / 下一句」是按当前句的比例缩小的（0.62 / 0.66），于是同一屏里
    // 永远是一大一小两行字，看着就像「字号跟着句子长短在变」——
    // 区分三者靠的是颜色和透明度，字号不参与区分，所以固定成一个值。
    const size = Math.max(12, Math.min(90, Number(L.fontSize) || 26));
    const weight = Number(L.weight) || 700;
    const sh = L.shadow || {};
    const stroke = L.stroke || {};
    const style = L.style || 'classic';

    const shadowCss = (sh.enabled && style !== 'minimal')
      ? `${sh.x || 0}px ${sh.y === undefined ? 2 : sh.y}px ${sh.blur === undefined ? 12 : sh.blur}px ${hexToRgba(sh.color || '#000000', sh.opacity === undefined ? 0.85 : sh.opacity)}`
      : 'none';
    const glow = style === 'neon'
      ? `, 0 0 ${Math.round(size * 0.5)}px ${hexToRgba(L.activeColor || '#7c5cff', 0.9)}, 0 0 ${Math.round(size * 1.1)}px ${hexToRgba(L.activeColor || '#7c5cff', 0.5)}`
      : '';

    const base = {
      fontSize: `${size}px`,
      fontWeight: String(weight),
      textAlign: L.align || 'left',
      textShadow: shadowCss + glow,
      color: L.color || '#fff',
      opacity: String(L.opacity === undefined ? 0.96 : L.opacity),
      webkitTextStroke: (stroke.enabled && style !== 'minimal') ? `${stroke.width || 1.2}px ${stroke.color || '#000'}` : '0px transparent',
      lineHeight: `${(size * 1.26).toFixed(1)}px`
    };
    Object.assign(el.cur.style, base);
    // 翻译行与下一句：字号与当前句完全一致（固定），只用透明度区分主次
    Object.assign(el.tr.style, base, {
      fontSize: `${size}px`,
      opacity: '0.78',
      webkitTextStroke: (stroke.enabled && style !== 'minimal') ? `${(stroke.width || 1.2) * 0.7}px ${stroke.color || '#000'}` : '0px transparent'
    });
    Object.assign(el.nxt.style, base, { fontSize: `${size}px`, opacity: '0.5' });

    el.cur.style.fontFamily = fontFor('zh');
    el.tr.style.fontFamily = fontFor('zh');
    el.nxt.style.fontFamily = fontFor('zh');
    el.lyr.style.gap = `${L.lineGap === undefined ? 12 : L.lineGap}px`;

    // 字体描边和 background-clip:text 冲突（描边会盖住渐变），逐字模式下用它代替描边
    if (style === 'karaoke' || style === 'gradient') el.cur.style.webkitTextStroke = '0px transparent';

    // 底板
    // 底板（浮层全透明时，浅色壁纸上歌词会看不清）
    const bgc = L.bg || {};
    if (bgc.enabled) {
      el.bg.style.background = hexToRgba(bgc.color || '#0b0d17', bgc.opacity === undefined ? 0.55 : bgc.opacity);
      el.bg.style.borderRadius = `${bgc.radius === undefined ? 18 : bgc.radius}px`;
      el.bg.classList.add('on');
    } else {
      el.bg.classList.remove('on');
    }

    // 正文与窗口右缘留一点空隙，别让最后一个字贴边
    el.lyr.style.paddingRight = '14px';

    // 封面
    const showCover = L.showCover !== false;
    el.cover.parentElement.classList.toggle('hidden', !showCover);
    const cs = Math.max(48, Math.min(260, Number(L.coverSize) || 96));
    el.cover.style.width = `${cs}px`;
    el.cover.style.height = `${cs}px`;
    el.cover.style.fontSize = `${Math.round(cs * 0.32)}px`;
    // 横向频谱的高度跟着字号走，避免大字号时显得太矮
    el.spec.style.setProperty('--specH', `${Math.max(14, Math.round(size * 0.7))}px`);
    const rounded = L.coverShape === 'rounded';
    el.cover.classList.toggle('rounded', rounded);
    el.coverRing.classList.toggle('rounded', rounded);
    el.root.style.gap = showCover ? '18px' : '0px';

    // 保留项
    el.bar.classList.toggle('on', !!L.showProgressBar);
    el.nxt.classList.toggle('hidden', L.showNextLine === false);
    el.tr.classList.toggle('hidden', L.showTranslation === false);

    // 改字号 / 风格 / 配色之后必须补刷一次逐字染色：
    // 上面只重设了基础样式，而 renderLine 会因为「当前行没变」直接跳过着色那一步，
    // 结果就是光带一直不出现（只在切句的瞬间闪一下）。
    paintKaraoke(lastProgress);

    // 拖字号 / 行距滑杆时先不重算窗口尺寸：否则每动一格就 setSize 一次，
    // 从封面到文字整块都在跟着抖。松手（change）时再统一算一次。
    if (!resizeHold) scheduleResize();
  }

  /* ================================================================== */
  /* 歌词渲染                                                            */
  /* ================================================================== */
  function setLines(newLines) {
    lines = newLines || [];
    curIdx = -1;
    preludeText = '';
    renderLine(true);
  }

  /** 当前句的 [起, 止] 秒；止 = 下一句时间，末句给 4 秒 */
  function rangeOf(i) {
    const a = lines[i];
    if (!a) return null;
    const b = lines[i + 1];
    const start = a.t || 0;
    let end = b ? b.t : start + 4;
    if (!(end > start)) end = start + 4;
    return [start, end];
  }

  /** 一行歌词该用哪套字体：日语 → jpFont，中文 → cnFont，其余 → enFont */
  function fontFor(lang) {
    const v = (typeof lang === 'string') ? lang : (lang ? 'zh' : 'en');
    if (v === 'jp') return L.jpFont || L.cnFont || '';
    return v === 'zh' ? (L.cnFont || '') : (L.enFont || '');
  }

  function paintLine(text, lang) {
    el.cur.textContent = text;
    el.cur.style.fontFamily = fontFor(lang);
  }

  function paintKaraoke(p) {
    // 还没唱到任何一句（前奏）时不要染色：那会儿 #cur 是空的，
    // 给它加上 background-clip:text 只会让后面第一句凭空带上一层底色。
    if (!lines.length || curIdx < 0 || !el.cur.textContent) return;
    const style = L.style || 'classic';
    const active = L.activeColor || '#7c5cff';

    if (style === 'minimal') {
      el.cur.style.background = 'none';
      el.cur.style.webkitTextFillColor = L.color || '#fff';
      el.cur.style.webkitBackgroundClip = 'border-box';
      el.cur.style.backgroundClip = 'border-box';
      return;
    }
    if (style === 'classic' || !L.karaoke) {
      // 整句高亮，不做逐字
      el.cur.style.background = 'none';
      el.cur.style.webkitTextFillColor = active;
      el.cur.style.webkitBackgroundClip = 'border-box';
      el.cur.style.backgroundClip = 'border-box';
      return;
    }
    if (style === 'gradient') {
      // 整句从上到下的渐变，进度只控制整体浓淡
      el.cur.style.backgroundColor = '';
      el.cur.style.background = `linear-gradient(180deg, ${active} 0%, ${L.unsungColor || '#8a90a8'} 100%)`;
      el.cur.style.webkitTextFillColor = 'transparent';
      // 顺序很重要：background 是简写属性，会把它重置成初始值 border-box。
      // 所以必须先写 background，再写 background-clip，否则渐变会铺满整个盒子
      // （配合透明文字就成了一条纯色横条）。
      el.cur.style.webkitBackgroundClip = 'text';
      el.cur.style.backgroundClip = 'text';
      return;
    }
    // karaoke / neon：一条从左往右的光带
    const w = Math.max(0.5, Number(L.sweepWidth) || 8);
    const pos = p * 100;
    const from = Math.max(0, pos - w);
    const to = Math.min(100, pos + w * 0.35);
    el.cur.style.background = `linear-gradient(90deg,`
      + ` ${active} 0%,`
      + ` ${active} ${from}%,`
      + ` #ffffff ${pos}%,`
      + ` ${L.unsungColor || '#8a90a8'} ${to}%,`
      + ` ${L.unsungColor || '#8a90a8'} 100%)`;
    el.cur.style.webkitTextFillColor = 'transparent';
    // 同上：必须在 background 之后
    el.cur.style.webkitBackgroundClip = 'text';
    el.cur.style.backgroundClip = 'text';
  }

  /**
   * 一行的三种状态：
   *   'show'  —— 正常显示
   *   'ghost' —— 不显示内容，但**保留高度**（.ghost 只是 visibility:hidden）
   *   'none'  —— 完全隐藏，不占高度（功能被关掉、整首没有歌词时才用）
   *
   * 为什么要有 'ghost'：#lyr 是垂直居中的，歌词块的高度只要一变，整块文字就会
   * 上下蹦一下。而「这一句有没有翻译」「有没有下一句」「当前句折成一行还是两行」
   * 本来都是逐句变化的 —— 所以没内容时也要留着那一行的位置。
   */
  function setRow(node, mode) {
    node.classList.toggle('ghost', mode === 'ghost');
    node.classList.toggle('hidden', mode === 'none');
  }

  function renderLine(force) {
    const i = payload ? payload.lyricIndex : -1;
    const active = lines[i];
    const trOn = L.showTranslation !== false;
    const nxOn = L.showNextLine !== false;

    if (!active) {
      if (!lines.length) {
        setRow(el.cur, 'none'); setRow(el.tr, 'none'); setRow(el.nxt, 'none');
        curLineRange = null;
        if (!gotPayload) { el.empty.classList.add('hidden'); return; }
        el.empty.classList.remove('hidden');
        el.empty.textContent = payload && payload.title ? `♪ ${payload.title} — 暂无歌词` : '等待播放…';
        return;
      }
      // 前奏：把第一句当成「即将开始」显示，别整块留白
      el.empty.classList.add('hidden');
      // 当前句 / 翻译行留空位（ghost），只把第一句放进「下一句」那一行 ——
      // 这样歌曲真正开始时，只是文字换行、整块布局不动
      setRow(el.cur, 'ghost');
      setRow(el.tr, trOn ? 'ghost' : 'none');
      curLineRange = null;
      const wanted = lines[0] ? lines[0].text : '';
      if (wanted) {
        if (preludeText !== wanted) {
          preludeText = wanted;
          el.nxt.textContent = wanted;
          el.nxt.style.fontFamily = fontFor(lines[0].lang || lines[0].isCJK);
        }
        setRow(el.nxt, 'show');
      } else setRow(el.nxt, nxOn ? 'ghost' : 'none');
      return;
    }

    el.empty.classList.add('hidden');
    setRow(el.cur, 'show');
    el.cur.style.opacity = String(L.opacity === undefined ? 0.96 : L.opacity);

    if (curIdx !== i || force) {
      curIdx = i;
      curLineRange = rangeOf(i);
      window.__perf.rendered++;
      paintLine(active.text, active.lang || active.isCJK);

      if (active.tr && trOn) {
        el.tr.textContent = '';
        const t = document.createElement('span');
        t.className = 'tr-text';
        t.textContent = active.tr;
        el.tr.appendChild(t);
        setRow(el.tr, 'show');
      } else setRow(el.tr, trOn ? 'ghost' : 'none');

      const nx = lines[i + 1];
      if (nx && nxOn) {
        el.nxt.textContent = nx.text;
        el.nxt.style.fontFamily = fontFor(nx.lang || nx.isCJK);
        setRow(el.nxt, 'show');
      } else setRow(el.nxt, nxOn ? 'ghost' : 'none');
    }

    paintProgress();
  }

  /** 只更新逐字进度（每帧都会调，不碰 DOM 结构） */
  function paintProgress() {
    // 进度用「句子自己的时间轴」算，比整首曲子的进度条更贴歌词
    let p = 0;
    if (curLineRange) {
      const [a, b] = curLineRange;
      p = Math.max(0, Math.min(1, (livePosition() - a) / (b - a)));
    }
    lastProgress = p;
    paintKaraoke(p);
  }

  /* ================================================================== */
  /* 窗口尺寸：固定大小                                                    */
  /* ================================================================== */
  // 以前宽高都「贴紧内容」：拿当前这句歌词的实际宽度去定窗口宽度，于是每换一句
  // 窗口就跟着变一次 —— 长句把框撑开、短句又缩回去，看起来就是「字幕框一直在变大小」。
  // 现在尺寸只由设置决定（字号 / 封面大小 / 行距 / 显示项），跟唱到哪一句、
  // 跟换不换歌都无关；歌词超过宽度时在框内折行。
  const MIN_W = 330;
  const MIN_H = 110;
  const MAX_H = 620;
  const MAX_W = 1300;
  // 参考正文宽度：按「这么多个全角字」估一个固定宽度，与歌词内容无关。
  // 14 个字在 26px 字号下约 364px；配合下面给当前句预留两行，
  // 一个框大约能容下 28 个汉字，常见歌词整句都不用折。
  const REF_CJK = 14;
  // 正文右侧留一点余量，否则最后一个字会贴着窗口边缘
  const TEXT_PAD = 6;
  // 当前句最多按两行预留（宽度固定后长句必然折行）
  const CUR_LINES = 2;
  // 面板展开时的高度上限：面板自身有 max-height，这里只是别让它顶到屏幕
  const MAX_PANEL_H = 620;

  let resizeTimer = null;

  // 只在「设置变了」或「面板开关」时排队重算尺寸；换歌词不再触发（这是修 bug 的关键）
  function scheduleResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(applyWindowSize, 60);
  }

  /**
   * 量出一段文字的自然宽度（不换行）。
   * 只用来量一个固定的参考字串（'测' × REF_CJK），结果与当前歌词无关，
   * 所以不会因为换句而改变窗口尺寸。
   * 不能直接读 #lyr.scrollWidth：它受当前窗口宽度约束，窗口窄的时候文字已经换行了，
   * 量出来的是「当前布局宽度」而不是自然宽度。
   * 这里用一个绝对定位、width:max-content 的量尺元素，结果与窗口大小无关。
   */
  function measureTextWidth(text, styleSource) {
    if (!text) return 0;
    const probe = document.createElement('div');
    probe.textContent = text;
    probe.style.cssText = 'position:absolute;left:-10000px;top:0;width:max-content;max-width:none;'
      + 'white-space:pre;visibility:hidden;pointer-events:none;';
    const cs = getComputedStyle(styleSource || el.cur);
    probe.style.font = cs.font;
    probe.style.fontFamily = cs.fontFamily;
    probe.style.fontSize = cs.fontSize;
    probe.style.fontWeight = cs.fontWeight;
    probe.style.letterSpacing = cs.letterSpacing;
    el.root.appendChild(probe);
    const w = probe.getBoundingClientRect().width;
    probe.remove();
    return w;
  }

  /**
   * 按设置算出一个固定尺寸并通知主进程。
   *
   * 这里**绝对不要**再读 el.cur / el.tr / el.nxt 的文本：一旦尺寸依赖歌词内容，
   * 窗口就会在每句之间忽大忽小 —— 那正是这次要修的问题。
   * 尺寸只跟这些设置有关：字号、封面大小/开关、行距、是否显示翻译与下一句、频谱。
   *
   * 窗口本身设成了 resizable:false（主进程），所以这里算出来的尺寸不会被
   * 用户拖动或系统回调改掉，也就不需要防重入的守卫。
   */
  function applyWindowSize() {
    const rootStyle = getComputedStyle(el.root);
    const padX = (parseFloat(rootStyle.paddingLeft) || 0) + (parseFloat(rootStyle.paddingRight) || 0);
    const padY = (parseFloat(rootStyle.paddingTop) || 0) + (parseFloat(rootStyle.paddingBottom) || 0);
    const gap = parseFloat(rootStyle.gap) || 0;
    const coverHidden = L.showCover === false;
    const coverW = coverHidden ? 0 : el.cover.offsetWidth;

    const size = Math.max(12, Math.min(90, Number(L.fontSize) || 26));
    const lineH = size * 1.26;
    const lg = Number(L.lineGap === undefined ? 12 : L.lineGap) || 0;
    const lyrPadR = parseFloat(el.lyr.style.paddingRight) || 0;

    // 宽度：固定参考字宽 + 封面 + 内边距（与当前歌词无关）
    const textW = Math.ceil(measureTextWidth('测'.repeat(REF_CJK), el.cur) * 1.04) + TEXT_PAD;

    const panelOpen = el.panel.classList.contains('open');
    // 面板展开时把它当成一个并排的兄弟块算进去，窗口就会真的变宽给歌词让位；
    // 光把面板设成 absolute 的话它不参与布局，窗口再宽也只会盖住歌词。
    const panelW = panelOpen ? el.panel.offsetWidth + 8 : 0;
    const extraW = panelW ? panelW + 14 : 0;
    const wantW = padX + coverW + (coverW ? gap : 0) + textW + lyrPadR + extraW;
    const maxW = Math.max(MIN_W, Math.min(MAX_W, screen.availWidth - 40));

    // 高度：按「当前句两行 + 翻译一行 + 下一句一行 + 频谱」预留，同样是固定值。
    // 都按「可能会出现」预留，所以某首歌没有翻译时只是多留了一点空白，
    // 不会因为歌词变了就改高度。
    let rows = CUR_LINES * lineH;
    if (L.showTranslation !== false) rows += lg + lineH + 3;   // +3 是 .tr-text 的 margin-top
    if (L.showNextLine !== false) rows += lg + lineH;
    // 频谱：+8 是 #spec 自己的 margin-top（flex 的 gap 之外还有这一段）
    if (specActive()) rows += lg + 8 + (Number(el.spec.offsetHeight) || Math.round(size * 0.7));

    let contentH = padY + 4;
    if (coverW) contentH = Math.max(contentH, coverW + padY + 4);
    contentH = Math.max(contentH, rows + padY + 4);
    if (panelOpen) contentH = Math.max(contentH, el.panel.scrollHeight + 46);

    const W = Math.max(MIN_W, Math.min(maxW, Math.ceil(wantW)));
    const H = Math.max(MIN_H, Math.min(panelOpen ? MAX_PANEL_H : MAX_H, Math.ceil(contentH)));
    window.__perf.resizes++;
    api.app.setSize(W, H);
  }

  /* ================================================================== */
  /* 同步                                                                */
  /* ================================================================== */
  api.on('lyrics:sync', (p) => {
    if (!p) return;
    gotPayload = true;
    payload = p;
    window.__perf.sync++;
    // 更新位置基准：之后每帧在这里往前插值，直到下一条同步到达
    setPosRef(p.position, p.rate, p.playing);
    // 频谱（主窗口按需推送，关掉节奏效果时不会有这个字段）
    if (p.spec) {
      liveSpec = String(p.spec).split(',').map(Number);
      liveBass = Number(p.bass) || 0;
      liveLevel = Number(p.level) || 0;
    } else if (!p.playing) {
      liveBass = 0; liveLevel = 0;
    }

    if (p.settings) {
      if (p.settings.theme) document.documentElement.dataset.theme = p.settings.theme;
      if (p.settings.lyrics) {
        const key = JSON.stringify(p.settings.lyrics);
        if (key !== settingsKey) { settingsKey = key; applySettings(p.settings.lyrics); }
      }
    }

    // 封面：只在 id 变化时改样式，别每次同步都写 background-image
    if (p.coverId !== lastCoverId) {
      lastCoverId = p.coverId;
      if (p.hasCover && p.coverId) {
        el.cover.classList.remove('ph');
        el.cover.textContent = '';
        el.cover.style.backgroundImage = `url("${p.coverSrc || U.coverUrlOf(p.coverId)}")`;
      } else {
        el.cover.classList.add('ph');
        el.cover.style.backgroundImage = '';
        el.cover.textContent = '♪';
      }
    }

    if (p.lines) {
      const key = `${p.lines.length}|${p.lines[0] ? p.lines[0].text : ''}|${p.lyricVersion || ''}`;
      if (key !== linesKey) { linesKey = key; window.__perf.linesApplied++; setLines(p.lines); }
    }

    renderLine(false);
    el.coverRing.classList.toggle('on', !!p.playing);
    if (L.showProgressBar && p.duration) {
      el.barFill.style.width = `${Math.min(100, (p.position / p.duration) * 100)}%`;
    }
  });

  /* ================================================================== */
  /* 节奏可视化：封面脉动 + 环形频谱                                       */
  /* ================================================================== */
  const SPEC_BARS = 30;
  const specBars = [];
  let liveSpec = null;
  let liveBass = 0;
  let liveLevel = 0;
  let pulseShown = 1;
  let specShown = null;

  function buildSpec() {
    el.spec.innerHTML = '';
    specBars.length = 0;
    for (let i = 0; i < SPEC_BARS; i++) {
      const b = document.createElement('i');
      el.spec.appendChild(b);
      specBars.push({ el: b, shown: 2 });
    }
  }

  /**
   * 能量曲线。
   * 实测 analyser 的低频平均值只在 0.03~0.15 之间游走，线性用的话脉动几乎看不出来；
   * 开方把它压到 0.17~0.39，再线性映射，动静就明显了。
   */
  function energyCurve(v) { return Math.sqrt(Math.max(0, Math.min(1, v))); }

  function pulseActive() { const s = L.specStyle || 'both'; return s === 'pulse' || s === 'both'; }
  function specActive() { const s = L.specStyle || 'both'; return s === 'ring' || s === 'both'; }

  /** 每帧推动节奏效果（与逐字推进共用同一个 rAF） */
  function animateRhythm(playing) {
    const sen = Math.max(0.4, Math.min(2.5, Number(L.specSensitivity) || 1));
    const bass = energyCurve(liveBass * sen);
    const level = energyCurve(liveLevel * sen);
    const wantPulse = pulseActive() && L.showCover !== false && playing;

    // 封面脉动：低频驱动（停下来时平滑回到 1）
    const pulseTarget = wantPulse ? 1 + bass * 0.17 : 1;
    pulseShown += (pulseTarget - pulseShown) * 0.18;
    el.cover.style.setProperty('--pulse', pulseShown.toFixed(4));
    // 光环跟着整体能量呼吸（叠在旋转光环上）
    if (el.coverRing.classList.contains('on')) {
      const g = 0.42 + level * 0.5;
      el.coverRing.style.opacity = g.toFixed(3);
    } else {
      el.coverRing.style.opacity = '';
    }

    // 横向频谱（不需要封面也能显示）
    if (!specActive()) {
      // 关掉频谱时要 display:none，不能只去掉 .on（那只是 opacity:0）：
      // 它仍占着 margin-top 8 + --specH 的高度，跟 applyWindowSize 里
      // 「不显示频谱就不预留这一行」对不上，整块文字会被顶偏。
      if (specShown !== false) {
        el.spec.classList.remove('on');
        el.spec.classList.add('hidden');
        specShown = false;
      }
      return;
    }
    if (specShown !== true) {
      el.spec.classList.add('on');
      el.spec.classList.remove('hidden');
      specShown = true;
    }
    const data = liveSpec;
    const n = specBars.length;
    const maxH = Number(el.spec.clientHeight) || 26;
    for (let i = 0; i < n; i++) {
      const b = specBars[i];
      const x = n > 1 ? i / (n - 1) : 0;
      const raw = data && data.length ? (data[Math.min(data.length - 1, Math.floor(x * data.length))] || 0) : 0;
      const target = playing ? Math.max(2, energyCurve(raw * sen) * maxH) : 2;
      b.shown += (target - b.shown) * (target > b.shown ? 0.5 : 0.12);
      b.el.style.height = `${Math.max(2, Math.min(maxH, b.shown)).toFixed(1)}px`;
    }
  }

  buildSpec();

  /**
   * 主窗口的同步只有 4Hz，光靠它画逐字光带会一跳一跳。
   * 这里每帧重算一次进度，位置由 livePosition() 按真实经过时间外推。
   * 只在「当前句在唱」时才动，静止时几乎零开销。
   */
  function tickProgress() {
    requestAnimationFrame(tickProgress);
    window.__perf.frames++;
    const playing = posRef.playing;
    // 节奏可视化每帧都要动（包括停下来时回落）
    animateRhythm(playing);
    if (!playing || !curLineRange || curIdx < 0) return;
    paintProgress();
  }
  requestAnimationFrame(tickProgress);

  api.on('lyrics:settings', (s) => { if (s) { L = { ...L, ...s }; applySettings(L); renderLine(true); } });

  /* ================================================================== */
  /* 右键菜单（工具条已移除，设置与关闭都从这里进）                        */
  /* ================================================================== */
  // 注意：只有 no-drag 的区域才能收到 contextmenu（见 lyrics.html 里 #lyr 的
  // 说明）——drag 区域在 Windows 上等同于标题栏，右键会弹系统菜单。
  // 所以歌词区被显式设成 no-drag，右键才不会看到「还原 / 移动 / 大小 / 关闭」。

  function togglePanel(force) {
    const open = typeof force === 'boolean' ? force : !el.panel.classList.contains('open');
    el.panel.classList.toggle('open', open);
    if (open) buildPanel();
    scheduleResize();
  }

  /* ================================================================== */
  /* 调色板 / 快捷设置面板                                                */
  /* ================================================================== */
  async function patchLyrics(patch) {
    L = { ...L, ...patch };
    applySettings(L);
    renderLine(true);
    await api.lyrics.update(patch);
  }

  function srow(label, control, valueText) {
    const r = document.createElement('div');
    r.className = 'srow';
    const l = document.createElement('label');
    l.textContent = label;
    r.appendChild(l);
    r.appendChild(control);
    if (valueText !== undefined) {
      const v = document.createElement('span');
      v.className = 'val';
      v.textContent = valueText;
      r.appendChild(v);
    }
    return r;
  }
  function range(min, max, step, value, onInput) {
    const i = document.createElement('input');
    i.type = 'range'; i.min = min; i.max = max; i.step = step; i.value = value;
    // 拖动期间挂起窗口重算（resizeHold），松手或停手 0.5 秒后再算一次。
    // 不这么做的话，滑杆每动一格都会 setSize，窗口一格格跳。
    i.oninput = () => {
      resizeHold = true;
      clearTimeout(resizeHoldT);
      resizeHoldT = setTimeout(() => { resizeHold = false; scheduleResize(); }, 500);
      onInput(Number(i.value));
    };
    i.onchange = () => {
      clearTimeout(resizeHoldT);
      resizeHold = false;
      scheduleResize();
    };
    return i;
  }
  /** #rrggbb → { h: 0-360, s: 0-100, l: 0-100 } */
  function hexToHsl(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    const n = m ? parseInt(m[1], 16) : 0xffffff;
    const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const l = (mx + mn) / 2;
    let h = 0, s = 0;
    if (mx !== mn) {
      const d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
  }

  /** { h, s, l } → '#rrggbb' */
  function hslToHex(h, s, l) {
    const hh = ((Number(h) % 360) + 360) % 360;
    const ss = Math.max(0, Math.min(100, Number(s))) / 100;
    const ll = Math.max(0, Math.min(100, Number(l))) / 100;
    const c = (1 - Math.abs(2 * ll - 1)) * ss;
    const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
    const m = ll - c / 2;
    let r = 0, g = 0, b = 0;
    if (hh < 60) { r = c; g = x; } else if (hh < 120) { r = x; g = c; }
    else if (hh < 180) { g = c; b = x; } else if (hh < 240) { g = x; b = c; }
    else if (hh < 300) { r = x; b = c; } else { r = c; b = x; }
    const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
    return `#${to(r)}${to(g)}${to(b)}`;
  }

  /**
   * 展开在面板里的取色器（色相 / 饱和度 / 明度三根滑杆）。
   *
   * 为什么不直接用 <input type="color">：它弹出来的是 Chromium 的**原生取色窗口**，
   * 那是一个独立的系统窗口、不属于页面，而歌词浮层是 alwaysOnTop 的无边框透明窗口
   * ——原生窗口压不过浮层，点开就被面板盖住了（用户看到的就是「调色盘图层优先级不高」）。
   * 自己画在面板里就没有层级问题，顺便和面板配色统一。
   */
  function colorEditor(label, value, onChange) {
    const box = document.createElement('div');
    box.className = 'cpbox';
    const hsl = hexToHsl(value);
    const cur = () => hslToHex(hsl.h, hsl.s, hsl.l);

    const head = document.createElement('div');
    head.className = 'cphead';
    const dot = document.createElement('span');
    dot.className = 'cpsw';
    dot.style.background = cur();
    const name = document.createElement('span');
    name.textContent = label;
    const grow = document.createElement('span');
    grow.className = 'grow';
    const code = document.createElement('span');
    code.className = 'val';
    code.textContent = cur().toUpperCase();
    head.appendChild(dot); head.appendChild(name); head.appendChild(grow); head.appendChild(code);
    box.appendChild(head);

    const apply = () => {
      const hex = cur();
      dot.style.background = hex;
      code.textContent = hex.toUpperCase();
      onChange(hex);
    };
    const add = (t, max, val, set) => {
      const r = document.createElement('div');
      r.className = 'srow';
      const l = document.createElement('label');
      l.textContent = t;
      r.appendChild(l);
      r.appendChild(range(0, max, 1, val, (v) => { set(v); apply(); }));
      box.appendChild(r);
    };
    add('色相', 360, hsl.h, (v) => { hsl.h = v; });
    add('饱和度', 100, hsl.s, (v) => { hsl.s = v; });
    add('明度', 100, hsl.l, (v) => { hsl.l = v; });
    return box;
  }
  function toggleBtn(on, text, onChange) {
    const b = document.createElement('button');
    b.className = `sbtn${on ? ' primary' : ''}`;
    b.textContent = text;
    b.onclick = () => onChange(!on);
    return b;
  }

  function buildPanel() {
    const box = el.panel;
    box.innerHTML = '';

    // 标题
    const head = document.createElement('div');
    head.className = 'shead';
    const t1 = document.createElement('span');
    t1.textContent = '🎨 桌面歌词';
    const g = document.createElement('span');
    g.className = 'grow';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'sbtn';
    closeBtn.textContent = '✕';
    closeBtn.onclick = () => togglePanel(false);
    head.appendChild(t1); head.appendChild(g); head.appendChild(closeBtn);
    box.appendChild(head);

    // 配色：三套预设 + 两个取色器
    const sw = document.createElement('div');
    sw.className = 'swatches';
    for (const pal of PALETTES) {
      const c = document.createElement('div');
      c.className = `sw${(L.activeColor === pal.active && L.unsungColor === pal.unsung) ? ' sel' : ''}`;
      c.title = pal.name;
      c.style.background = `linear-gradient(135deg, ${pal.active} 0%, ${pal.unsung} 100%)`;
      c.onclick = () => patchLyrics({ color: pal.color, activeColor: pal.active, unsungColor: pal.unsung }).then(buildPanel);
      sw.appendChild(c);
    }
    const swRow = document.createElement('div');
    swRow.className = 'srow';
    const swLabel = document.createElement('label');
    swLabel.textContent = '配色';
    swRow.appendChild(swLabel); swRow.appendChild(sw);
    // 取色器顶到右边
    const g2 = document.createElement('span');
    g2.className = 'grow';
    swRow.appendChild(g2);
    // 两个色块按钮：点开就在下面展开自绘取色器（不用原生取色窗口，见 colorEditor）
    const mkBtn = (key, label, color) => {
      const b = document.createElement('button');
      b.className = `cpbtn${openPicker === key ? ' on' : ''}`;
      b.title = `${label}（点击展开取色器）`;
      b.style.background = color || '#ffffff';
      b.onclick = () => { openPicker = openPicker === key ? null : key; buildPanel(); scheduleResize(); };
      return b;
    };
    swRow.appendChild(mkBtn('active', '已唱色', L.activeColor));
    swRow.appendChild(mkBtn('unsung', '未唱色', L.unsungColor));
    box.appendChild(swRow);
    if (openPicker === 'active') box.appendChild(colorEditor('已唱色（正在唱的部分）', L.activeColor, (v) => patchLyrics({ activeColor: v })));
    if (openPicker === 'unsung') box.appendChild(colorEditor('未唱色（还没唱的部分）', L.unsungColor, (v) => patchLyrics({ unsungColor: v })));

    // 字号
    {
      const fsVal = document.createElement('span');
      fsVal.className = 'val';
      fsVal.textContent = `${L.fontSize || 26}px`;
      const r = srow('字号', range(12, 90, 1, L.fontSize || 26, (v) => {
        fsVal.textContent = `${v}px`;
        patchLyrics({ fontSize: v });
      }));
      r.appendChild(fsVal);
      box.appendChild(r);
    }
    // 行间距的最小值就是 0，所以判空必须写 `=== undefined`：
    // 以前写的是 `L.lineGap || 12`，0 被当成「没有设置」，于是调成最小之后
    // 一打开面板又显示 12（用户反馈的「每次调到最小，下次点右键发现不是最小了」）。
    {
      const lg0 = Number.isFinite(Number(L.lineGap)) ? Number(L.lineGap) : 12;
      const gapVal = document.createElement('span');
      gapVal.className = 'val';
      gapVal.textContent = `${lg0}px`;
      const r = srow('行间距', range(0, 60, 1, lg0, (v) => {
        gapVal.textContent = `${v}px`;
        patchLyrics({ lineGap: v });
      }));
      r.appendChild(gapVal);
      box.appendChild(r);
    }

    // 常用的就「配色 / 字号 / 行间距」这三项，其余全部收进「更多设置」：
    // 一打开面板就是十几个开关，连歌词都被挡住了。
    const moreRow = document.createElement('div');
    moreRow.className = 'srow';
    const moreBtn = document.createElement('button');
    moreBtn.className = 'sbtn wide';
    moreBtn.textContent = panelMore ? '更多设置 ▴' : '更多设置 ▾';
    moreBtn.onclick = () => { panelMore = !panelMore; buildPanel(); scheduleResize(); };
    moreRow.appendChild(moreBtn);
    box.appendChild(moreRow);

    if (panelMore) {
    box.appendChild(srow('不透明度', range(0.15, 1, 0.01, L.opacity === undefined ? 0.96 : L.opacity, (v) => patchLyrics({ opacity: v })), `${Math.round((L.opacity === undefined ? 0.96 : L.opacity) * 100)}%`));

    // 风格：三选一
    const grid = document.createElement('div');
    grid.className = 'stylegrid';
    for (const st of STYLES) {
      const b = document.createElement('button');
      b.className = `sbtn${(L.style || 'karaoke') === st.id ? ' primary' : ''}`;
      b.textContent = st.name;
      b.onclick = () => patchLyrics({ style: st.id }).then(buildPanel);
      grid.appendChild(b);
    }
    const stRow = document.createElement('div');
    stRow.className = 'srow';
    const stLabel = document.createElement('label');
    stLabel.textContent = '风格';
    stRow.appendChild(stLabel); stRow.appendChild(grid);
    box.appendChild(stRow);

    // 封面：只留开关和大小
    box.appendChild(srow('封面', toggleBtn(L.showCover !== false, L.showCover !== false ? '显示' : '隐藏', (v) => patchLyrics({ showCover: v }).then(buildPanel)), ''));
    box.appendChild(srow('封面大小', range(48, 260, 2, L.coverSize || 96, (v) => patchLyrics({ coverSize: v })), `${L.coverSize || 96}px`));

    // 节奏可视化
    {
      const grid2 = document.createElement('div');
      grid2.className = 'stylegrid';
      for (const [v, t] of [['both', '脉动+频谱'], ['pulse', '仅脉动'], ['ring', '仅频谱'], ['none', '关']]) {
        const b = document.createElement('button');
        b.className = `sbtn${(L.specStyle || 'both') === v ? ' primary' : ''}`;
        b.textContent = t;
        b.onclick = () => patchLyrics({ specStyle: v }).then(buildPanel);
        grid2.appendChild(b);
      }
      const r2 = document.createElement('div');
      r2.className = 'srow';
      const l2 = document.createElement('label');
      l2.textContent = '节奏';
      r2.appendChild(l2); r2.appendChild(grid2);
      box.appendChild(r2);
      const sens = Math.round((L.specSensitivity === undefined ? 1 : L.specSensitivity) * 100) / 100;
      const sensVal = document.createElement('span');
      sensVal.className = 'val';
      sensVal.textContent = `${sens}×`;
      const r3 = srow('灵敏度', range(0.4, 2.5, 0.05, sens, (v) => {
        sensVal.textContent = `${Math.round(v * 100) / 100}×`;
        patchLyrics({ specSensitivity: v });
      }));
      r3.appendChild(sensVal);
      box.appendChild(r3);
    }

    // 显示项：只留翻译和下一句
    box.appendChild(srow('翻译', toggleBtn(L.showTranslation !== false, L.showTranslation !== false ? '开' : '关', (v) => patchLyrics({ showTranslation: v })), ''));
    box.appendChild(srow('下一句', toggleBtn(L.showNextLine !== false, L.showNextLine !== false ? '开' : '关', (v) => patchLyrics({ showNextLine: v })), ''));
    box.appendChild(srow('底板', toggleBtn(L.bg && L.bg.enabled, L.bg && L.bg.enabled ? '开' : '关', (v) => patchLyrics({ bg: { ...(L.bg || {}), enabled: v } }).then(buildPanel)), ''));
    box.appendChild(srow('底板透明', range(0, 1, 0.02, (L.bg && L.bg.opacity) === undefined ? 0.55 : L.bg.opacity, (v) => patchLyrics({ bg: { ...(L.bg || {}), opacity: v } }))));
    } /* end if (panelMore) */

    const btns = document.createElement('div');
    btns.className = 'srow';
    const b1 = document.createElement('button');
    b1.className = 'sbtn'; b1.textContent = '↺ 重置位置';
    b1.onclick = () => api.lyrics.resetPos();
    const b2 = document.createElement('button');
    b2.className = 'sbtn'; b2.textContent = '主窗口';
    b2.onclick = () => api.app.focusMain();
    const b3 = document.createElement('button');
    b3.className = 'sbtn'; b3.textContent = '✕ 关闭歌词';
    b3.onclick = () => api.lyrics.toggleDesktop(false);
    btns.appendChild(b1); btns.appendChild(b2); btns.appendChild(b3);
    box.appendChild(btns);
  }

  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    // 面板内部（滑杆 / 取色器 / 按钮）右键不要当成开关，否则调一半就关了
    if (el.panel.classList.contains('open') && el.panel.contains(e.target)) return;
    togglePanel();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') togglePanel(false); });

  /* ================================================================== */
  /* 启动                                                                */
  /* ================================================================== */
  api.settings.get().then((s) => { if (s && s.lyrics) applySettings(s.lyrics); });
  // 窗口刚加载好时主动索要一次（否则会错过开窗瞬间的那条同步消息）
  api.lyrics.requestSync().catch(() => {});
  window.addEventListener('DOMContentLoaded', () => { api.lyrics.requestSync().catch(() => {}); });
})();
