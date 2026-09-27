/**
 * Aurora 极光音乐 —— 播放控制器
 * 播放列表 / 播放模式 / 切歌过渡 / 听歌时长累计 / 系统媒体控制
 */
(function () {
  'use strict';

  const U = window.U;

  class Player {
    constructor(engine) {
      this.engine = engine;
      this.all = [];            // 曲库全部曲目
      this.queue = [];          // 当前播放队列（曲目对象数组）
      this.index = -1;
      this.current = null;
      this.mode = 'sequential'; // sequential | shuffle | repeat-all | repeat-one | shuffle-one
      this.playing = false;
      this.settings = null;
      this.shuffleHistory = [];
      this.shufflePool = [];
      this._pendingMs = 0;
      this._lastTick = 0;
      this._sessionMs = 0;
      this._countedPlay = false;
      this._flushTimer = null;
      this._tickTimer = null;
      this._scrubbing = false;
      this._loadToken = 0;
      this.handlers = {};
      this._bindEngine();
      this._startTimers();
    }

    on(evt, fn) { (this.handlers[evt] = this.handlers[evt] || []).push(fn); return this; }
    emit(evt, payload) { for (const fn of this.handlers[evt] || []) { try { fn(payload); } catch (e) { console.error(e); } } }

    applySettings(s) {
      this.settings = s;
      const P = s.playback || {};
      this.mode = P.mode || 'sequential';
      this.engine.setVolume(typeof P.volume === 'number' ? P.volume : 0.8);
      this.engine.setMuted(!!P.muted);
      this.engine.setRate(P.rate || 1);
      this.engine.setPreservePitch(P.preservePitch !== false);
      this.engine.setPitchSemitones(P.pitch || 0);
      const EQ = s.eq || {};
      this.engine.setEqGains(EQ.bands || new Array(10).fill(0));
      this.engine.setPreamp(EQ.preamp || 0);
      this.engine.setEqEnabled(!!EQ.enabled);
    }

    _bindEngine() {
      this.engine.onEnded = () => this.onTrackEnded();
      this.engine.onTimeUpdate = () => this.emit('time', { position: this.engine.position(), duration: this.engine.duration() });
      this.engine.onDeckEvent = (e) => this.emit('deck', e);
    }

    _startTimers() {
      this._tickTimer = setInterval(() => this._tick(), 250);
      this._flushTimer = setInterval(() => this.flushStats(), 5000);
    }

    /* ---------------- 队列管理 ---------------- */
    setLibrary(tracks) {
      this.all = tracks || [];
      if (!this.queue.length) this.queue = this.all.slice();
      else {
        // 保留队列中仍存在的曲目，补上新曲目
        const byId = new Map(this.all.map((t) => [t.id, t]));
        const nextQ = [];
        for (const t of this.queue) { const nt = byId.get(t.id); if (nt) nextQ.push(nt); }
        const inQ = new Set(nextQ.map((t) => t.id));
        for (const t of this.all) if (!inQ.has(t.id)) nextQ.push(t);
        this.queue = nextQ;
      }
      const cur = this.current ? this.all.find((t) => t.id === this.current.id) : null;
      if (cur) this.current = cur;
      this.emit('queue', { queue: this.queue, index: this.index });
    }

    setQueue(tracks, startIndex = 0, opts = {}) {
      this.queue = (tracks || []).slice();
      this.index = this.queue.length ? Math.max(0, Math.min(this.queue.length - 1, startIndex)) : -1;
      this._resetShuffle();
      this.emit('queue', { queue: this.queue, index: this.index });
      if (opts.autoplay !== false && this.queue.length) this.playIndex(this.index);
    }

    _resetShuffle() {
      this.shufflePool = this.queue.map((t, i) => i).filter((i) => i >= 0);
      this.shuffleHistory = [];
    }

    get currentIndex() {
      if (!this.current) return -1;
      return this.queue.findIndex((t) => t.id === this.current.id);
    }

    /* ---------------- 播放 ---------------- */
    async playIndex(i, opts = {}) {
      if (i < 0 || i >= this.queue.length) { this.stop(); return; }
      this.index = i;
      await this.playTrack(this.queue[i], opts);
    }

    async playById(id, opts = {}) {
      const idx = this.queue.findIndex((t) => t.id === id);
      if (idx >= 0) { await this.playIndex(idx, opts); return; }
      const t = this.all.find((x) => x.id === id);
      if (!t) return;
      this.queue.push(t);
      await this.playIndex(this.queue.length - 1, opts);
    }

    async playTrack(track, opts = {}) {
      if (!track) return;
      const token = ++this._loadToken;
      this.flushStats({ reason: 'switch' });
      const prev = this.current;
      this.current = track;
      this.index = this.currentIndex;
      this._sessionMs = 0;
      this._countedPlay = false;

      const P = (this.settings && this.settings.playback) || {};
      const transition = opts.transition || (prev ? (P.transition || 'crossfade') : 'none');
      const ms = opts.transitionMs || P.transitionMs || 1200;
      const startAt = opts.startAt || 0;

      await this.engine.ensure();
      if (token !== this._loadToken) return;

      if (this.engine.degraded) {
        this.engine.setSource(track, 0);
        this.engine.active = 0;
        this.engine.seek(startAt, 0);
        await this.engine.play(0);
      } else if (!prev || transition === 'none' || transition === 'gapless') {
        const idx = this.engine.active;
        this.engine.setSource(track, idx);
        this.engine.seek(startAt, idx);
        this.engine.setDeckGain(idx, 1, 0);
        await this.engine.play(idx);
      } else {
        await this._transition(track, prev, transition, ms, startAt);
      }

      this.playing = true;
      this._lastTick = performance.now();
      this.emit('track', { track, previous: prev });
      this._updateMediaSession(track);
      this._preloadNext();
      this.emit('state', this.state());
      if (this.settings && this.settings.playback && this.settings.playback.rememberPosition) {
        this._savePosition(track, startAt);
      }
    }

    async _transition(track, prevTrack, transition, ms, startAt) {
      const eng = this.engine;
      const preset = (window.AURORA_TRANSITIONS || {})[transition] || { out: 1, gap: 0, in: 1 };
      const fromIdx = eng.active;
      const toIdx = 1 - fromIdx;
      eng.setSource(track, toIdx);
      eng.seek(startAt, toIdx);
      eng.setDeckGain(toIdx, 0, 0);
      const ok = await eng.play(toIdx);
      if (!ok) {
        eng.setSource(track, fromIdx);
        eng.setDeckGain(fromIdx, 1, 0);
        await eng.play(fromIdx);
        return;
      }
      const outMs = Math.round(ms * preset.out);
      const inMs = Math.round(ms * preset.in);
      const gapMs = Math.round(ms * preset.gap);
      eng.setDeckGain(fromIdx, 0, outMs);
      if (gapMs > 0) setTimeout(() => eng.setDeckGain(toIdx, 1, inMs), outMs + gapMs);
      else eng.setDeckGain(toIdx, 1, inMs);
      eng.active = toIdx;
      setTimeout(() => {
        try { eng.pause(fromIdx); eng.setDeckGain(fromIdx, 0, 0); } catch { /* ignore */ }
      }, outMs + gapMs + inMs + 100);
    }

    _preloadNext() {
      const P = (this.settings && this.settings.playback) || {};
      const t = P.transition || 'crossfade';
      if (!['gapless', 'none', 'fade'].includes(t)) return;
      const next = this.peekNext();
      if (!next) return;
      const eng = this.engine;
      const other = 1 - eng.active;
      try {
        eng.setSource(next, other);
        eng.setDeckGain(other, 0, 0);
      } catch { /* ignore */ }
    }

    peekNext() {
      if (!this.queue.length) return null;
      if (this.mode === 'repeat-one' || this.mode === 'shuffle-one') return this.current;
      if (this.mode === 'shuffle' || this.mode === 'shuffle-one') {
        return this.queue[Math.floor(Math.random() * this.queue.length)] || null;
      }
      const i = this.currentIndex;
      if (i + 1 < this.queue.length) return this.queue[i + 1];
      if (this.mode === 'repeat-all') return this.queue[0];
      return null;
    }

    async onTrackEnded() {
      const P = (this.settings && this.settings.playback) || {};
      if (this.mode === 'repeat-one') {
        this.engine.seek(0);
        await this.engine.play();
        this._sessionMs = 0; this._countedPlay = false;
        this.emit('track', { track: this.current, repeated: true });
        return;
      }
      await this.next({ auto: true });
    }

    async next(opts = {}) {
      if (!this.queue.length) return;
      if (this.mode === 'shuffle' || this.mode === 'shuffle-one') {
        let i = -1;
        if (this.queue.length > 2) {
          let guard = 0;
          do { i = Math.floor(Math.random() * this.queue.length); guard++; } while (i === this.currentIndex && guard < 30);
        } else {
          i = (this.currentIndex + 1) % this.queue.length;
        }
        await this.playIndex(i);
        return;
      }
      const i = this.currentIndex;
      if (i + 1 < this.queue.length) { await this.playIndex(i + 1); return; }
      if (this.mode === 'repeat-all') { await this.playIndex(0); return; }
      this.pause();
      this.emit('queue-end', {});
    }

    async prev() {
      if (!this.queue.length) return;
      if (this.engine.position() > 3.5 && !this.engine.degraded) { this.seek(0); return; }
      const i = this.currentIndex;
      if (i - 1 >= 0) { await this.playIndex(i - 1); return; }
      if (this.mode === 'repeat-all') { await this.playIndex(this.queue.length - 1); return; }
      this.seek(0);
    }

    async toggle() {
      if (!this.current) {
        if (this.queue.length) await this.playIndex(Math.max(0, this.index));
        return;
      }
      if (this.playing && !this.engine.isPaused()) this.pause();
      else await this.resume();
    }

    async resume() {
      await this.engine.ensure();
      this.engine.resume();
      const ok = await this.engine.play();
      if (ok) { this.playing = true; this._lastTick = performance.now(); this.emit('state', this.state()); }
    }

    pause() {
      this.engine.pause();
      this.playing = false;
      this.flushStats({ reason: 'pause' });
      this.emit('state', this.state());
    }

    stop() {
      this.engine.pauseAll();
      this.playing = false;
      this.current = null;
      this.flushStats({ reason: 'stop' });
      this.emit('state', this.state());
    }

    seek(sec) {
      this.engine.seek(sec);
      this.emit('time', { position: this.engine.position(), duration: this.engine.duration() });
    }
    seekRelative(delta) { this.seek(Math.max(0, Math.min(this.engine.duration() || 1e9, this.engine.position() + delta))); }

    setMode(mode) {
      this.mode = mode;
      if (mode === 'shuffle' || mode === 'shuffle-one') this._resetShuffle();
      this.emit('mode', mode);
      this.emit('state', this.state());
    }

    cycleMode() {
      const order = ['sequential', 'repeat-all', 'repeat-one', 'shuffle'];
      const i = order.indexOf(this.mode);
      this.setMode(order[(i + 1) % order.length]);
      return this.mode;
    }

    /* ---------------- 听歌时长统计 ---------------- */
    _tick() {
      const now = performance.now();
      const delta = now - this._lastTick;
      this._lastTick = now;
      if (!this.current || !this.settings) return;
      const statsCfg = this.settings.stats || {};
      const reallyPlaying = this.playing && !this.engine.isPaused() && !this._scrubbing && this.engine.duration() > 0;
      if (statsCfg.enabled !== false && reallyPlaying && delta > 0 && delta < 2000) {
        // 变速播放时按“实际听的内容时长”还是“墙上时间”？这里按墙上时间（真实占用时间）
        this._pendingMs += delta;
        this._sessionMs += delta;
      }
      const minSec = (statsCfg.minSeconds || 5) * 1000;
      if (!this._countedPlay && this._sessionMs >= Math.min(minSec, Math.max(8000, (this.engine.duration() * 1000) / 2))) {
        this._countedPlay = true;
        this._pendingPlayIncrement = true;
      }
      this._savePositionThrottled();
    }

    _savePositionThrottled() {
      if (!this.current) return;
      const P = (this.settings && this.settings.playback) || {};
      if (!P.rememberPosition) return;
      const now = Date.now();
      if (now - (this._lastPosSave || 0) < 5000) return;
      this._lastPosSave = now;
      this._savePosition(this.current, this.engine.position());
    }

    _savePosition(track, pos) {
      try {
        const positions = (this.settings && this.settings._positions) || {};
        positions[track.id] = { pos, at: Date.now() };
        window.aurora.settings.set('_positions', positions);
      } catch { /* ignore */ }
    }

    getResumePosition(track) {
      const positions = (this.settings && this.settings._positions) || {};
      const rec = positions[track.id];
      if (!rec) return 0;
      if (Date.now() - rec.at > 1000 * 60 * 60 * 24 * 7) return 0;
      if (!track.duration || rec.pos > track.duration * 1000 - 8000) return 0;
      return rec.pos > 10 ? rec.pos : 0;
    }

    flushStats(opts = {}) {
      const ms = Math.round(this._pendingMs);
      const inc = !!this._pendingPlayIncrement;
      this._pendingMs = 0;
      this._pendingPlayIncrement = false;
      if (!this.current) return;
      if (ms < 500 && !inc) return;
      const entry = { id: this.current.id, ms: Math.max(ms, inc ? 1 : 0), day: U.dayKey(), incrementPlay: inc };
      window.aurora.stats.add([entry]).catch(() => {});
      this.emit('stats-flush', entry);
    }

    /* ---------------- 状态 ---------------- */
    state() {
      return {
        current: this.current,
        index: this.currentIndex,
        queueLength: this.queue.length,
        mode: this.mode,
        playing: this.playing,
        position: this.engine.position(),
        duration: this.engine.duration(),
        volume: this.engine.volume,
        muted: this.engine.muted,
        rate: this.engine.rate,
        pitch: this.engine.pitchSemis,
        degraded: this.engine.degraded
      };
    }

    /* ---------------- 系统媒体控制（Windows SMTC） ---------------- */
    _updateMediaSession(track) {
      try {
        if (!('mediaSession' in navigator) || !track) return;
        navigator.mediaSession.metadata = new MediaMetadata({
          title: track.title || track.name || '',
          artist: track.artist || '未知歌手',
          album: track.album || '',
          artwork: track.hasCover ? [{ src: window.aurora.app.mediaUrl(track.path), sizes: '512x512', type: 'image/jpeg' }] : []
        });
        navigator.mediaSession.setActionHandler('play', () => this.resume());
        navigator.mediaSession.setActionHandler('pause', () => this.pause());
        navigator.mediaSession.setActionHandler('previoustrack', () => this.prev());
        navigator.mediaSession.setActionHandler('nexttrack', () => this.next());
        navigator.mediaSession.setActionHandler('seekbackward', () => this.seekRelative(-10));
        navigator.mediaSession.setActionHandler('seekforward', () => this.seekRelative(10));
        navigator.mediaSession.playbackState = 'playing';
      } catch { /* ignore */ }
    }
  }

  window.Player = Player;
})();
