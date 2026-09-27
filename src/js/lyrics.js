/**
 * Aurora 极光音乐 —— 歌词解析与渲染（支持中文 / 英文 / 双语）
 */
(function () {
  'use strict';

  const U = window.U;

  /** 解码歌词文件（UTF-8 优先，自动回退 GB18030/GBK / UTF-16） */
  function decodeBuffer(base64) {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    // UTF-8 BOM
    if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      return new TextDecoder('utf-8').decode(bytes.subarray(3));
    }
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      for (const enc of ['gb18030', 'gbk', 'big5', 'shift_jis']) {
        try { return new TextDecoder(enc).decode(bytes); } catch { /* next */ }
      }
      return new TextDecoder('utf-8').decode(bytes);
    }
  }

  const TIME_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  const META_RE = /^\[(ti|ar|al|by|offset|re|ve|length):(.*)\]$/i;

  /**
   * 解析 LRC 文本
   * 返回 { meta, lines: [{ t, text, tr, isCJK }], bilingual }
   */
  function parseLrc(text) {
    const meta = {};
    const raw = [];
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    let offset = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const m = META_RE.exec(trimmed);
      if (m) { meta[m[1].toLowerCase()] = m[2].trim(); continue; }
      TIME_RE.lastIndex = 0;
      const stamps = [];
      let match;
      let lastEnd = 0;
      while ((match = TIME_RE.exec(trimmed)) !== null) {
        const min = parseInt(match[1], 10);
        const sec = parseInt(match[2], 10);
        const fracRaw = match[3] || '0';
        let frac = parseInt(fracRaw, 10);
        if (fracRaw.length === 1) frac *= 100;
        else if (fracRaw.length === 2) frac *= 10;
        else frac = Math.round(frac / Math.pow(10, fracRaw.length - 3));
        stamps.push(min * 60 + sec + frac / 1000);
        lastEnd = match.index + match[0].length;
      }
      if (!stamps.length) continue;
      const content = trimmed.slice(lastEnd).trim();
      for (const t of stamps) raw.push({ t, text: content });
    }

    raw.sort((a, b) => a.t - b.t);
    if (meta.offset) offset = (parseFloat(meta.offset) || 0) / 1000;

    // 双语合并：同一时间点出现两条（一中一英）则合并为一条 + 翻译
    const merged = [];
    const byTime = new Map();
    for (const r of raw) {
      const key = r.t.toFixed(2);
      if (!byTime.has(key)) byTime.set(key, []);
      byTime.get(key).push(r.text);
    }
    for (const r of raw) {
      const key = r.t.toFixed(2);
      const group = byTime.get(key);
      if (group.length > 1 && merged.length && merged[merged.length - 1].key === key) continue;
      if (group.length > 1) {
        const cjk = group.filter((g) => U.hasCJK(g));
        const non = group.filter((g) => !U.hasCJK(g) && g);
        const primary = cjk[0] || group[0] || '';
        const tr = (cjk.length && non.length) ? non.join(' / ') : (group.filter((g) => g !== primary).join(' / '));
        merged.push({ key, t: r.t + offset, text: primary, tr: tr || '', isCJK: U.hasCJK(primary) });
      } else {
        const primary = group[0] || '';
        merged.push({ key, t: r.t + offset, text: primary, tr: '', isCJK: U.hasCJK(primary) });
      }
    }

    // 纯翻译行归并到上一行（形如 [00:12.00] 英文 紧跟 [00:12.00] 中文 已在上面处理）
    // 过滤开头的「制作信息」：作词/作曲/版权管理/版权所有… 这些不是歌词。
    // 只在还没有出现任何真正歌词之前过滤，避免误删正文里出现的同名词。
    const CREDIT_RE = [
      /^\s*(作词|作曲|编曲|填词|词|曲|制作人|出品人|出品|监制|混音|母带|录音|和声|配唱|吉他|贝斯|鼓|键盘|弦乐|人声|策划|统筹|封面|设计|发行|推广|音乐总监|录音师|混音师|翻译|上传|LRC歌词|歌词制作|OP|SP)\s*[:：]/i,
      /版权管理|版权所有|未经许可|请勿翻唱|请勿侵权|all rights reserved/i
    ];
    const out = [];
    let sawReal = false;
    let creditsSkipped = 0;
    for (const l of merged) {
      if (l.text === '' && !l.tr) continue;
      if (!sawReal && l.t <= 30 && CREDIT_RE.some((re) => re.test(l.text))) {
        creditsSkipped++;
        continue;
      }
      if (l.text && l.text.trim()) sawReal = true;
      out.push(l);
    }
    return { meta, lines: out, bilingual: out.some((l) => l.tr), creditsSkipped };
  }

  /** 判断一行是否为纯时间标签（无文字），用于跳过 */
  function isBlankLine(l) { return !l.text && !l.tr; }

  class LyricsController {
    constructor(opts) {
      this.lines = [];
      this.meta = {};
      this.current = -1;
      this.raw = '';
      this.sourcePath = null;
      this.title = '';
      this.creditsSkipped = 0;
      this.onChange = opts && opts.onChange ? opts.onChange : () => {};
      this.offsetMs = 0;
    }

    clear() {
      this.lines = [];
      this.meta = {};
      this.current = -1;
      this.raw = '';
      this.sourcePath = null;
      this.creditsSkipped = 0;
      this.onChange(this);
    }

    get empty() { return !this.lines.length; }

    async loadFor(track) {
      this.clear();
      if (!track) return this;
      this.title = track.title || track.name || '';
      const res = await window.aurora.lyrics.find({ path: track.path, title: track.title, artist: track.artist, name: track.name, embeddedLyrics: track.embeddedLyrics });
      if (!res) return this;
      let text = '';
      if (res.embedded && res.text) text = res.text;
      else if (res.base64) text = decodeBuffer(res.base64);
      if (!text || !text.trim()) return this;
      const parsed = parseLrc(text);
      this.lines = parsed.lines;
      this.meta = parsed.meta || {};
      this.creditsSkipped = parsed.creditsSkipped || 0;
      this.raw = text;
      this.sourcePath = res.path || null;
      this.onChange(this);
      return this;
    }

    setText(text, sourceName) {
      const parsed = parseLrc(text);
      this.lines = parsed.lines;
      this.meta = parsed.meta || {};
      this.creditsSkipped = parsed.creditsSkipped || 0;
      this.raw = text;
      this.sourcePath = sourceName || null;
      this.current = -1;
      this.onChange(this);
      return this;
    }

    /** 根据播放时间找当前行索引 */
    indexAt(sec) {
      if (!this.lines.length) return -1;
      const t = sec + this.offsetMs / 1000;
      let lo = 0; let hi = this.lines.length - 1; let ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (this.lines[mid].t <= t) { ans = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      return ans;
    }

    /** 当前行的进度 0~1，用于卡拉OK染色 */
    progress(sec) {
      const i = this.current;
      if (i < 0 || !this.lines[i]) return 0;
      const start = this.lines[i].t;
      const end = this.lines[i + 1] ? this.lines[i + 1].t : start + 4;
      if (end <= start) return 1;
      return Math.max(0, Math.min(1, (sec + this.offsetMs / 1000 - start) / (end - start)));
    }

    update(sec) {
      const i = this.indexAt(sec);
      if (i !== this.current) {
        this.current = i;
        return true;
      }
      return false;
    }

    nextLine(i) {
      const idx = i === undefined ? this.current : i;
      return this.lines[idx + 1] ? this.lines[idx + 1].text : '';
    }
  }

  /** 渲染歌词到容器（主窗口 / 桌面歌词 / 迷你播放器共用） */
  function renderTo(container, ctrl, opts = {}) {
    const { activeClass = 'active', pastClass = 'past', showTr = true, karaoke = true } = opts;
    container.innerHTML = '';
    if (!ctrl.lines.length) {
      container.appendChild(U.ce('div', { class: 'ly-empty', html: opts.emptyHtml || '暂无歌词<br><span style="font-size:12px">把同名 .lrc 文件放到歌曲旁边，或点击「导入歌词」</span>' }));
      return;
    }
    const frag = document.createDocumentFragment();
    ctrl.lines.forEach((l, i) => {
      const cls = ['ly-line', l.isCJK ? 'zh' : 'en'];
      if (i === ctrl.current) cls.push(activeClass);
      else if (i < ctrl.current) cls.push(pastClass);
      if (karaoke && i === ctrl.current) cls.push('karaoke');
      const el = U.ce('div', { class: cls.join(' '), 'data-i': i });
      el.appendChild(U.ce('span', { class: 'src', text: l.text }));
      if (showTr && l.tr) el.appendChild(U.ce('span', { class: 'tr', text: l.tr }));
      el.addEventListener('click', () => { if (opts.onSeek) opts.onSeek(l.t - ctrl.offsetMs / 1000); });
      frag.appendChild(el);
    });
    container.appendChild(frag);
  }

  function scrollToActive(container, smooth = true) {
    const active = container.querySelector('.ly-line.active');
    if (!active) {
      // 还没唱到第一句：滚到最上面，让用户看到即将开始的那句
      container.scrollTop = 0;
      return;
    }
    const box = container.getBoundingClientRect();
    const el = active.getBoundingClientRect();
    const target = container.scrollTop + (el.top - box.top) - box.height / 2 + el.height / 2;
    if (smooth) container.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    else container.scrollTop = Math.max(0, target);
  }

  window.Lyrics = { LyricsController, parseLrc, decodeBuffer, renderTo, scrollToActive };
})();
