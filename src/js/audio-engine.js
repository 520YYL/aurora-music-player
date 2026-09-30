/**
 * Aurora 极光音乐 —— 音频引擎
 * 双解码器 (dual deck) + 10 段均衡器 + 插件效果链 + 独立变调 + 多种切歌过渡
 * 图： deckA/deckB -> input -> EQ×10 -> preamp -> pluginIn -> [插件链] -> pluginOut -> pitch -> analyser -> master -> out
 */
(function () {
  'use strict';

  const NBANDS = 10;

  class AudioEngine {
    constructor(opts = {}) {
      this.volume = 0.8;
      this.muted = false;
      this.rate = 1;
      this.pitchSemis = 0;
      this.preservePitch = true;
      this.ctx = null;
      this.ready = false;
      this.degraded = false;
      this.decks = [];
      this.active = 0;
      this.currentTrackId = null;   // 由 Player 同步，用于过滤过期的 ended 事件
      this.plugins = [];
      this.onEnded = opts.onEnded || (() => {});
      this.onTimeUpdate = opts.onTimeUpdate || (() => {});
      this.onDeckEvent = opts.onDeckEvent || (() => {});
      this.eqEnabled = false;
      this.eqGains = new Array(NBANDS).fill(0);
      this.preampDb = 0;
      this.eqBands = [];
      this._raf = null;
      this._silenceCheck = null;
    }

    /* ---------------- 初始化 ---------------- */
    async ensure() {
      if (this.ready || this.degraded) return;
      try {
        await this._buildGraph();
        this.ready = true;
      } catch (err) {
        console.error('[engine] Web Audio 初始化失败，降级为直通播放：', err);
        this._fallbackDirect();
      }
    }

    async _buildGraph() {
      const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
      this.ctx = ctx;

      // 10 段均衡
      const freqs = (window.AURORA_DEFAULTS && window.AURORA_DEFAULTS.EQ_FREQS) || [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
      this.input = ctx.createGain();
      let node = this.input;
      this.eqBands = [];
      for (let i = 0; i < NBANDS; i++) {
        const f = ctx.createBiquadFilter();
        f.type = 'peaking';
        f.frequency.value = freqs[i];
        f.Q.value = 1.1;
        f.gain.value = 0;
        node.connect(f);
        node = f;
        this.eqBands.push(f);
      }
      this.preamp = ctx.createGain();
      node.connect(this.preamp);

      this.pluginIn = ctx.createGain();
      this.pluginOut = ctx.createGain();
      this.preamp.connect(this.pluginIn);
      this.pluginIn.connect(this.pluginOut);

      // 变调（AudioWorklet 颗粒变调器）
      this.pitchIn = ctx.createGain();
      this.pitchOut = ctx.createGain();
      this.pitchRatio = 1;
      this.pluginOut.connect(this.pitchIn);
      this.pitchIn.connect(this.pitchOut);
      this.pitchNode = null;
      try {
        await ctx.audioWorklet.addModule('aurora://local/app/js/pitch-worklet.js');
        const pn = new AudioWorkletNode(ctx, 'aurora-pitch-shifter', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
          processorOptions: { grainSize: 2048 }
        });
        this.pitchIn.disconnect();
        this.pitchIn.connect(pn);
        pn.connect(this.pitchOut);
        this.pitchNode = pn;
        this.pitchParam = pn.parameters.get('pitchRatio');
        if (this.pitchParam) this.pitchParam.value = 1;
      } catch (err) {
        console.warn('[engine] 变调 Worklet 不可用：', err && err.message);
      }
      try {
        const bypass = new AudioWorkletNode(ctx, 'aurora-bypass', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
        // 该节点仅用于验证 worklet 运行；不接入主链
        bypass.disconnect();
      } catch { /* ignore */ }

      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 4096;
      this.analyser.smoothingTimeConstant = 0.78;
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;
      this.pitchOut.connect(this.analyser);
      this.analyser.connect(this.master);
      this.master.connect(ctx.destination);

      // 双解码器
      for (let i = 0; i < 2; i++) {
        const el = new Audio();
        el.preload = 'auto';
        el.crossOrigin = 'anonymous';
        el.preservesPitch = true;
        if ('mozPreservesPitch' in el) el.mozPreservesPitch = true;
        if ('webkitPreservesPitch' in el) el.webkitPreservesPitch = true;
        const src = ctx.createMediaElementSource(el);
        const gain = ctx.createGain();
        gain.gain.value = i === 0 ? 1 : 0;
        src.connect(gain);
        gain.connect(this.input);
        const deck = { el, src, gain, index: i, track: null, startedAt: 0 };
        this._bindDeck(deck);
        this.decks.push(deck);
      }
      this.active = 0;
      this.applyRate();
      this.applyEQ();
      if (this.plugins.length) this.rebuildPlugins();
    }

    _fallbackDirect() {
      this.ready = false;
      this.degraded = true;
      this.decks = [];
      for (let i = 0; i < 2; i++) {
        const el = new Audio();
        el.preload = 'auto';
        el.volume = this.muted ? 0 : this.volume;
        const deck = { el, src: null, gain: null, index: i, track: null, degraded: true };
        this._bindDeck(deck);
        this.decks.push(deck);
      }
      this.active = 0;
    }

    _bindDeck(deck) {
      const el = deck.el;
      el.addEventListener('ended', () => {
        // 双重判定：只有「这一路解码器仍是当前解码器」且「它上面那首歌仍是当前歌曲」
        // 时才触发自动下一首。否则在切歌竞态里，刚淡出的旧解码器播完会误触发自动切歌。
        const isActive = this.decks[this.active] === deck;
        const isCurrent = !!(deck.track && this.currentTrackId && deck.track.id === this.currentTrackId);
        if (isActive && isCurrent) this.onEnded(deck);
        this.onDeckEvent({ type: 'ended', deck });
      });
      el.addEventListener('timeupdate', () => {
        if (this.decks[this.active] === deck) this.onTimeUpdate(this.position(), this.duration());
      });
      el.addEventListener('loadedmetadata', () => this.onDeckEvent({ type: 'loadedmetadata', deck }));
      el.addEventListener('error', () => this.onDeckEvent({
        type: 'error', deck,
        error: el.error ? el.error.message : null,
        errorCode: el.error ? el.error.code : null
      }));
      el.addEventListener('playing', () => { if (this.decks[this.active] === deck) this.onDeckEvent({ type: 'playing', deck }); });
      el.addEventListener('waiting', () => this.onDeckEvent({ type: 'waiting', deck }));
      el.addEventListener('pause', () => this.onDeckEvent({ type: 'pause', deck }));
    }

    resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); }

    /* ---------------- 解码器操作 ---------------- */
    deck(i) { return this.decks[i === undefined ? this.active : i]; }
    other() { return this.decks[1 - this.active]; }

    setSource(track, i = this.active) {
      const deck = this.decks[i];
      if (!deck) return null;
      deck.track = track;
      // 本地文件走 aurora://local/media；在线曲目（path 为空）走 aurora://local/stream，
      // 由主进程实时解析直链并按 Range 透传。
      // track.source 决定走哪条通道：'bilibili'（默认）/ 'kuwo' / 'netease'
      let url = '';
      if (track && track.path) {
        url = window.aurora.app.mediaUrl(track.path);
      } else if (track && track.online && track.videoId && window.aurora.online) {
        url = window.aurora.online.streamUrl(track.videoId, track.source);
      }
      if (deck.el.src !== url) {
        deck.el.src = url;
        deck.el.load();
      }
      this.applyRate(i);
      return deck;
    }

    async play(i = this.active) {
      const deck = this.decks[i];
      if (!deck) return false;
      this.resume();
      try {
        await deck.el.play();
        this._startSilenceWatch();
        return true;
      } catch (err) {
        console.warn('[engine] play 失败：', err && err.message);
        return false;
      }
    }

    pause(i = this.active) { const d = this.decks[i]; if (d) d.el.pause(); }
    pauseAll() { for (const d of this.decks) try { d.el.pause(); } catch { /* ignore */ } }

    seek(sec, i = this.active) {
      const d = this.decks[i];
      if (!d) return;
      try { d.el.currentTime = Math.max(0, sec); } catch { /* ignore */ }
    }

    position(i = this.active) { const d = this.decks[i]; return d ? d.el.currentTime || 0 : 0; }
    duration(i = this.active) { const d = this.decks[i]; return d && Number.isFinite(d.el.duration) ? d.el.duration : 0; }
    buffered(i = this.active) {
      const d = this.decks[i];
      if (!d || !d.el.buffered || !d.el.buffered.length) return 0;
      try { return d.el.buffered.end(d.el.buffered.length - 1); } catch { return 0; }
    }
    isPaused(i = this.active) { const d = this.decks[i]; return !d || d.el.paused; }

    setDeckGain(i, v, rampMs = 0) {
      const d = this.decks[i];
      if (!d) return;
      if (d.degraded) { d.el.volume = Math.max(0, Math.min(1, this.muted ? 0 : v * this.volume)); return; }
      const g = d.gain.gain;
      const t = this.ctx.currentTime;
      const target = Math.max(0, Math.min(1.4, v));
      try {
        g.cancelScheduledValues(t);
        if (rampMs > 0) {
          g.setValueAtTime(g.value, t);
          g.linearRampToValueAtTime(target, t + rampMs / 1000);
        } else {
          g.setValueAtTime(target, t);
        }
      } catch { g.value = target; }
    }

    getDeckGain(i) { const d = this.decks[i]; if (!d) return 0; return d.degraded ? d.el.volume : d.gain.gain.value; }

    /* ---------------- 播放参数 ---------------- */
    setVolume(v) {
      this.volume = Math.max(0, Math.min(1, v));
      if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
      if (this.degraded) for (const d of this.decks) d.el.volume = this.muted ? 0 : this.volume;
    }
    setMuted(m) {
      this.muted = !!m;
      if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
      if (this.degraded) for (const d of this.decks) d.el.volume = this.muted ? 0 : this.volume;
    }
    setPreservePitch(on) { this.preservePitch = !!on; this.applyRate(); }

    applyRate(i) {
      const list = i === undefined ? this.decks : [this.decks[i]];
      for (const d of list) {
        if (!d) continue;
        try {
          d.el.playbackRate = Math.max(0.25, Math.min(4, this.rate));
          d.el.preservesPitch = this.preservePitch;
          if ('mozPreservesPitch' in d.el) d.el.mozPreservesPitch = this.preservePitch;
          if ('webkitPreservesPitch' in d.el) d.el.webkitPreservesPitch = this.preservePitch;
        } catch { /* ignore */ }
      }
    }
    setRate(r) { this.rate = Math.max(0.25, Math.min(4, Number(r) || 1)); this.applyRate(); }

    setPitchSemitones(s) {
      this.pitchSemis = Math.max(-12, Math.min(12, Number(s) || 0));
      this.pitchRatio = Math.pow(2, this.pitchSemis / 12);
      if (this.pitchParam) {
        const t = this.ctx ? this.ctx.currentTime : 0;
        try {
          this.pitchParam.cancelScheduledValues(t);
          this.pitchParam.setTargetAtTime(this.pitchRatio, t, 0.03);
        } catch { this.pitchParam.value = this.pitchRatio; }
      }
    }

    /* ---------------- 均衡器 ---------------- */
    setEqEnabled(on) {
      this.eqEnabled = !!on;
      this.applyEQ();
    }
    setEqGains(gains) {
      this.eqGains = gains.slice(0, NBANDS);
      this.applyEQ();
    }
    setEqBand(i, db) {
      this.eqGains[i] = Number(db) || 0;
      if (!this.eqBands[i]) return;
      const t = this.ctx.currentTime;
      try { this.eqBands[i].gain.setTargetAtTime(this.eqEnabled ? this.eqGains[i] : 0, t, 0.03); }
      catch { this.eqBands[i].gain.value = this.eqEnabled ? this.eqGains[i] : 0; }
    }
    setPreamp(db) {
      this.preampDb = Number(db) || 0;
      this.applyEQ();
    }
    applyEQ() {
      if (!this.eqBands.length) return;
      const t = this.ctx.currentTime;
      for (let i = 0; i < this.eqBands.length; i++) {
        const v = this.eqEnabled ? (this.eqGains[i] || 0) : 0;
        try { this.eqBands[i].gain.setTargetAtTime(v, t, 0.03); } catch { this.eqBands[i].gain.value = v; }
      }
      const pre = Math.pow(10, this.preampDb / 20);
      try { this.preamp.gain.setTargetAtTime(this.eqEnabled ? pre : 1, t, 0.03); } catch { this.preamp.gain.value = 1; }
    }

    /* ---------------- 插件链 ---------------- */
    async setPlugins(pluginList) {
      this.plugins = (pluginList || []).map((p) => ({ descriptor: p.descriptor || p, params: p.params || {} }));
      if (!this.ctx) return;
      await this.rebuildPlugins();
    }

    updatePluginParams(pluginId, params) {
      const entry = this.plugins.find((p) => (p.descriptor.id === pluginId));
      if (!entry) return;
      entry.params = params;
      for (const n of entry.nodes || []) {
        if (typeof n.setParam === 'function') {
          for (const [k, v] of Object.entries(params)) n.setParam(k, v);
        }
      }
    }

    async rebuildPlugins() {
      if (!this.ctx) return;
      // 拆除旧链
      for (const p of this.plugins) {
        for (const n of p.nodes || []) { try { n.dispose && n.dispose(); } catch { /* ignore */ } }
      }
      try { this.pluginIn.disconnect(); } catch { /* ignore */ }
      let cursor = this.pluginIn;
      for (const p of this.plugins) {
        const built = await buildPluginChain(this.ctx, p.descriptor, p.params || {});
        p.nodes = built.nodes;
        cursor.connect(built.input);
        cursor = built.output;
      }
      cursor.connect(this.pluginOut);
    }

    /* ---------------- 频谱 ---------------- */
    frequencyData() {
      if (!this.analyser) return null;
      const arr = new Uint8Array(this.analyser.frequencyBinCount);
      this.analyser.getByteFrequencyData(arr);
      return arr;
    }
    waveData() {
      if (!this.analyser) return null;
      const arr = new Uint8Array(this.analyser.fftSize);
      this.analyser.getByteTimeDomainData(arr);
      return arr;
    }

    /* ---------------- 静音保护（Web Audio 图异常时降级） ---------------- */
    _startSilenceWatch() {
      if (!this.analyser || this.degraded || this._silenceCheck) return;
      let elapsed = 0;
      let last = performance.now();
      this._silenceCheck = setInterval(() => {
        const now = performance.now();
        elapsed += now - last;
        last = now;
        const d = this.decks[this.active];
        if (!d) { clearInterval(this._silenceCheck); this._silenceCheck = null; return; }
        if (d.el.paused || d.el.currentTime < 0.6) { elapsed = 0; return; }
        const data = this.frequencyData();
        let sum = 0;
        if (data) for (let i = 0; i < data.length; i += 16) sum += data[i];
        if (sum === 0 && elapsed > 2500) {
          clearInterval(this._silenceCheck); this._silenceCheck = null;
          const pos = d.el.currentTime;
          const wasPlaying = !d.el.paused;
          const track = d.track;
          console.warn('[engine] 检测到 Web Audio 输出静音，切换到直通模式');
          this._fallbackDirect();
          if (track) {
            this.active = 0;
            this.setSource(track, 0);
            this.seek(pos, 0);
            this.setDeckGain(0, 1, 0);
            if (wasPlaying) this.play(0);
          }
          window.dispatchEvent(new CustomEvent('aurora:degraded'));
        }
      }, 500);
    }

    destroy() { this.pauseAll(); if (this.ctx) this.ctx.close().catch(() => {}); }
  }

  /* ================================================================== */
  /* 插件图构建                                                          */
  /* ================================================================== */
  function resolveParam(v, params) {
    if (typeof v === 'string') {
      const m = /^(-?)\{(\w+)\}$/.exec(v.trim());
      if (m) {
        const raw = params[m[2]];
        const num = Number(raw);
        return m[1] === '-' ? -num : num;
      }
      const n = Number(v);
      return Number.isFinite(n) ? n : v;
    }
    return v;
  }
  function num(v, params, dflt = 0) {
    const r = resolveParam(v, params);
    const n = Number(r);
    return Number.isFinite(n) ? n : dflt;
  }

  function makeIR(ctx, seconds = 2.5, decay = 2.5) {
    const rate = ctx.sampleRate;
    const len = Math.max(64, Math.floor(rate * seconds));
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * (1 - t * 0.15);
      }
    }
    return buf;
  }

  async function buildPluginChain(ctx, descriptor, params) {
    const nodes = [];
    const entryGain = ctx.createGain();
    const exitGain = ctx.createGain();
    let cursor = entryGain;
    const graph = Array.isArray(descriptor.graph) ? descriptor.graph : [];

    for (const step of graph) {
      const type = step.type || step.node;
      const sp = step.params || {};
      const module = await buildEffectModule(ctx, type, sp, params, descriptor, nodes);
      if (!module) continue;
      nodes.push(module);
      cursor.connect(module.input);
      cursor = module.output;
    }
    cursor.connect(exitGain);
    return { input: entryGain, output: exitGain, nodes };
  }

  async function buildEffectModule(ctx, type, sp, params, descriptor, allNodes) {
    switch (type) {
      case 'gain': {
        const g = ctx.createGain();
        g.gain.value = num(sp.gain, params, 1);
        return {
          input: g, output: g,
          setParam(k, v) {
            const p = { ...params, [k]: v };
            g.gain.setTargetAtTime(num(sp.gain, p, 1), ctx.currentTime, 0.03);
          },
          dispose() { try { g.disconnect(); } catch { /* ignore */ } }
        };
      }
      case 'biquad': {
        const f = ctx.createBiquadFilter();
        f.type = sp.type || 'peaking';
        f.frequency.value = Math.max(10, num(sp.freq, params, 1000));
        f.Q.value = Math.max(0.0001, num(sp.q, params, 1));
        f.gain.value = num(sp.gain, params, 0);
        return {
          input: f, output: f,
          setParam(k, v) {
            const p = { ...params, [k]: v };
            f.frequency.setTargetAtTime(Math.max(10, num(sp.freq, p, 1000)), ctx.currentTime, 0.03);
            f.gain.setTargetAtTime(num(sp.gain, p, 0), ctx.currentTime, 0.03);
            if (sp.q !== undefined) f.Q.setTargetAtTime(Math.max(0.0001, num(sp.q, p, 1)), ctx.currentTime, 0.03);
          },
          dispose() { try { f.disconnect(); } catch { /* ignore */ } }
        };
      }
      case 'convolver': {
        const input = ctx.createGain();
        const output = ctx.createGain();
        const dry = ctx.createGain();
        const wet = ctx.createGain();
        const conv = ctx.createConvolver();
        let mix = num(sp.mix, params, 0.4) / (Math.abs(num(sp.mix, params, 40)) > 1.001 ? 100 : 1);
        mix = Math.max(0, Math.min(1, mix));
        dry.gain.value = 1 - mix;
        wet.gain.value = mix;
        if (sp.irFile) {
          try {
            const resp = await fetch(window.aurora.app.mediaUrl(sp.irFile));
            const buf = await resp.arrayBuffer();
            conv.buffer = await ctx.decodeAudioData(buf);
          } catch { conv.buffer = makeIR(ctx, sp.seconds || 2.2, sp.decay || 2.6); }
        } else {
          conv.buffer = makeIR(ctx, sp.seconds || 2.2, sp.decay || 2.6);
        }
        input.connect(dry); dry.connect(output);
        input.connect(conv); conv.connect(wet); wet.connect(output);
        return {
          input, output,
          setParam(k, v) {
            const p = { ...params, [k]: v };
            let m = num(sp.mix, p, 0.4);
            if (m > 1.001) m = m / 100;
            m = Math.max(0, Math.min(1, m));
            dry.gain.setTargetAtTime(1 - m, ctx.currentTime, 0.05);
            wet.gain.setTargetAtTime(m, ctx.currentTime, 0.05);
          },
          dispose() { for (const n of [input, output, dry, wet, conv]) { try { n.disconnect(); } catch { /* ignore */ } } }
        };
      }
      case 'delay': {
        const input = ctx.createGain();
        const output = ctx.createGain();
        const dry = ctx.createGain();
        const wet = ctx.createGain();
        const dl = ctx.createDelay(2);
        const fb = ctx.createGain();
        let m = num(sp.mix, params, 0.3);
        if (m > 1.001) m = m / 100;
        dl.delayTime.value = Math.max(0.001, num(sp.time, params, 0.02));
        fb.gain.value = Math.max(0, Math.min(0.92, num(sp.feedback, params, 0.2)));
        dry.gain.value = 1 - m;
        wet.gain.value = m;
        input.connect(dry); dry.connect(output);
        input.connect(dl); dl.connect(fb); fb.connect(dl); dl.connect(wet); wet.connect(output);
        return {
          input, output,
          setParam(k, v) {
            const p = { ...params, [k]: v };
            let mm = num(sp.mix, p, 0.3);
            if (mm > 1.001) mm = mm / 100;
            dry.gain.setTargetAtTime(1 - mm, ctx.currentTime, 0.05);
            wet.gain.setTargetAtTime(mm, ctx.currentTime, 0.05);
          },
          dispose() { for (const n of [input, output, dry, wet, dl, fb]) { try { n.disconnect(); } catch { /* ignore */ } } }
        };
      }
      case 'chorus': {
        const input = ctx.createGain();
        const output = ctx.createGain();
        const dry = ctx.createGain();
        const wet = ctx.createGain();
        const dl = ctx.createDelay(1);
        const lfo = ctx.createOscillator();
        const lfoGain = ctx.createGain();
        const voices = Math.max(1, Math.min(4, num(sp.voices, params, 2)));
        lfo.frequency.value = Math.max(0.05, num(sp.rate, params, 1.2));
        lfoGain.gain.value = Math.max(0.0001, num(sp.depth, params, 0.006));
        dl.delayTime.value = 0.02;
        lfo.connect(lfoGain); lfoGain.connect(dl.delayTime);
        lfo.start();
        let m = num(sp.mix, params, 0.4);
        if (m > 1.001) m = m / 100;
        dry.gain.value = 1 - m * 0.5;
        wet.gain.value = m / (voices * 0.7 + 0.3);
        input.connect(dry); dry.connect(output);
        input.connect(dl); dl.connect(wet); wet.connect(output);
        return {
          input, output,
          setParam(k, v) {
            const p = { ...params, [k]: v };
            let mm = num(sp.mix, p, 0.4);
            if (mm > 1.001) mm = mm / 100;
            wet.gain.setTargetAtTime(mm / (voices * 0.7 + 0.3), ctx.currentTime, 0.05);
            lfo.frequency.setTargetAtTime(Math.max(0.05, num(sp.rate, p, 1.2)), ctx.currentTime, 0.05);
          },
          dispose() { try { lfo.stop(); } catch { /* ignore */ } for (const n of [input, output, dry, wet, dl, lfo, lfoGain]) { try { n.disconnect(); } catch { /* ignore */ } } }
        };
      }
      case 'autoPan': {
        const input = ctx.createGain();
        const output = ctx.createGain();
        const panner = ctx.createStereoPanner();
        const lfo = ctx.createOscillator();
        const lfoGain = ctx.createGain();
        let depth = num(sp.depth, params, 70);
        if (depth > 1.001) depth = depth / 100;
        lfo.frequency.value = Math.max(0.01, num(sp.speed, params, 6) / 4);
        lfoGain.gain.value = Math.max(0, Math.min(1, depth));
        lfo.connect(lfoGain); lfoGain.connect(panner.pan);
        lfo.start();
        input.connect(panner); panner.connect(output);
        return {
          input, output,
          setParam(k, v) {
            const p = { ...params, [k]: v };
            let d = num(sp.depth, p, 70);
            if (d > 1.001) d = d / 100;
            lfo.frequency.setTargetAtTime(Math.max(0.01, num(sp.speed, p, 6) / 4), ctx.currentTime, 0.05);
            lfoGain.gain.setTargetAtTime(Math.max(0, Math.min(1, d)), ctx.currentTime, 0.05);
          },
          dispose() { try { lfo.stop(); } catch { /* ignore */ } for (const n of [input, output, panner, lfo, lfoGain]) { try { n.disconnect(); } catch { /* ignore */ } } }
        };
      }
      case 'compressor': {
        const c = ctx.createDynamicsCompressor();
        c.threshold.value = num(sp.threshold, params, -24);
        c.knee.value = num(sp.knee, params, 20);
        c.ratio.value = num(sp.ratio, params, 6);
        c.attack.value = num(sp.attack, params, 0.005);
        c.release.value = num(sp.release, params, 0.22);
        return {
          input: c, output: c,
          setParam() {},
          dispose() { try { c.disconnect(); } catch { /* ignore */ } }
        };
      }
      case 'waveshaper': {
        const input = ctx.createGain();
        const output = ctx.createGain();
        const ws = ctx.createWaveShaper();
        let amount = num(sp.amount, params, 30);
        if (amount > 1.001) amount = amount / 100;
        const curve = new Float32Array(1024);
        const k = 1 + amount * 12;
        for (let i = 0; i < 1024; i++) {
          const x = (i / 1023) * 2 - 1;
          curve[i] = Math.tanh(k * x) / Math.tanh(k);
        }
        ws.curve = curve;
        ws.oversample = '2x';
        const wet = ctx.createGain();
        const dry = ctx.createGain();
        const mix = sp.mix !== undefined ? (num(sp.mix, params, 0.85) > 1.001 ? num(sp.mix, params, 0.85) / 100 : num(sp.mix, params, 0.85)) : 1;
        wet.gain.value = mix; dry.gain.value = 1 - mix;
        input.connect(dry); dry.connect(output);
        input.connect(ws); ws.connect(wet); wet.connect(output);
        return {
          input, output,
          setParam(k, v) {
            const p = { ...params, [k]: v };
            let a = num(sp.amount, p, 30);
            if (a > 1.001) a = a / 100;
            const kk = 1 + a * 12;
            for (let i = 0; i < 1024; i++) {
              const x = (i / 1023) * 2 - 1;
              curve[i] = Math.tanh(kk * x) / Math.tanh(kk);
            }
            ws.curve = curve;
          },
          dispose() { for (const n of [input, output, ws, wet, dry]) { try { n.disconnect(); } catch { /* ignore */ } } }
        };
      }
      case 'vocalsRemover': {
        const input = ctx.createGain();
        const output = ctx.createGain();
        const splitter = ctx.createChannelSplitter(2);
        const merger = ctx.createChannelMerger(2);
        const inv = ctx.createGain();
        inv.gain.value = -1;
        const wet = ctx.createGain();
        let m = num(sp.mix, params, 85);
        if (m > 1.001) m = m / 100;
        wet.gain.value = Math.max(0, Math.min(1, m));
        input.connect(splitter);
        splitter.connect(merger, 0, 0);
        splitter.connect(inv, 1);
        inv.connect(merger, 0, 1);
        merger.connect(wet); wet.connect(output);
        return {
          input, output,
          setParam(k, v) {
            const p = { ...params, [k]: v };
            let mm = num(sp.mix, p, 85);
            if (mm > 1.001) mm = mm / 100;
            wet.gain.setTargetAtTime(Math.max(0, Math.min(1, mm)), ctx.currentTime, 0.05);
          },
          dispose() { for (const n of [input, output, splitter, merger, inv, wet]) { try { n.disconnect(); } catch { /* ignore */ } } }
        };
      }
      case 'stereo': {
        const p = ctx.createStereoPanner();
        p.pan.value = Math.max(-1, Math.min(1, num(sp.pan, params, 0)));
        return { input: p, output: p, setParam() {}, dispose() { try { p.disconnect(); } catch { /* ignore */ } } };
      }
      default: {
        const g = ctx.createGain();
        return { input: g, output: g, setParam() {}, dispose() { try { g.disconnect(); } catch { /* ignore */ } } };
      }
    }
  }

  /* ================================================================== */
  /* 过渡效果                                                            */
  /* ================================================================== */
  const TRANSITION_PRESETS = {
    none: { out: 0, gap: 0, in: 0 },
    fade: { out: 0.45, gap: 0.1, in: 0.45 },
    crossfade: { out: 1, gap: 0, in: 1 },
    smooth: { out: 1.9, gap: 0, in: 1.9 },
    dip: { out: 0.22, gap: 0.12, in: 0.22 },
    gapless: { out: 0, gap: 0, in: 0 }
  };

  window.AudioEngine = AudioEngine;
  window.AURORA_TRANSITIONS = TRANSITION_PRESETS;
  window.AURORA_BUILD_PLUGIN = buildPluginChain;
  window.AURORA_MAKE_IR = makeIR;
})();
