/**
 * Aurora 极光音乐 —— 音频可视化（浮动板块 + 迷你频谱）
 */
(function () {
  'use strict';

  class Visualizer {
    constructor(canvas, engine) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.engine = engine;
      this.mode = 'bars';
      this.raf = null;
      this.hue = 0;
      this.dots = [];
      this.resize();
      this._onResize = () => this.resize();
      window.addEventListener('resize', this._onResize);
    }

    resize() {
      const c = this.canvas;
      const dpr = window.devicePixelRatio || 1;
      const rect = c.getBoundingClientRect();
      c.width = Math.max(80, Math.floor((rect.width || 280) * dpr));
      c.height = Math.max(40, Math.floor((rect.height || 96) * dpr));
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.w = rect.width || 280;
      this.h = rect.height || 96;
    }

    setMode(m) { this.mode = m; }

    start() {
      if (this.raf) return;
      const loop = () => {
        this.raf = requestAnimationFrame(loop);
        this.draw();
      };
      this.raf = requestAnimationFrame(loop);
    }

    stop() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = null; }

    accents() {
      const cs = getComputedStyle(document.documentElement);
      return {
        a: (cs.getPropertyValue('--accent') || '#7c5cff').trim(),
        b: (cs.getPropertyValue('--accent2') || '#22d3ee').trim(),
        text: (cs.getPropertyValue('--text') || '#fff').trim()
      };
    }

    draw() {
      const ctx = this.ctx;
      const w = this.w; const h = this.h;
      ctx.clearRect(0, 0, w, h);
      const data = this.engine && this.engine.frequencyData ? this.engine.frequencyData() : null;
      const { a, b } = this.accents();
      this.hue = (this.hue + 0.6) % 360;

      if (!data) {
        ctx.strokeStyle = 'rgba(150,150,180,.35)';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        for (let x = 0; x <= w; x += 4) {
          const y = h / 2 + Math.sin(x / 22 + Date.now() / 600) * 4;
          if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
        return;
      }

      const N = data.length;
      const step = Math.max(1, Math.floor(N / 96));

      switch (this.mode) {
        case 'wave': {
          const wave = this.engine.waveData();
          const g = ctx.createLinearGradient(0, 0, w, 0);
          g.addColorStop(0, a); g.addColorStop(1, b);
          ctx.strokeStyle = g; ctx.lineWidth = 2; ctx.beginPath();
          const stride = Math.max(1, Math.floor(wave.length / w));
          for (let i = 0, x = 0; i < wave.length; i += stride, x++) {
            const v = (wave[i] - 128) / 128;
            const y = h / 2 + v * (h / 2 - 4);
            if (x === 0) ctx.moveTo(0, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
          break;
        }
        case 'mirror': {
          const bars = Math.min(72, Math.floor(w / 5));
          const bw = w / bars;
          for (let i = 0; i < bars; i++) {
            const idx = Math.floor((i / bars) * (N * 0.7));
            const v = (data[idx] || 0) / 255;
            const bh = Math.max(2, v * (h / 2 - 3));
            const g = ctx.createLinearGradient(0, h / 2 - bh, 0, h / 2 + bh);
            g.addColorStop(0, a); g.addColorStop(1, b);
            ctx.fillStyle = g;
            ctx.fillRect(i * bw + 1, h / 2 - bh, bw - 2, bh * 2);
          }
          break;
        }
        case 'radial': {
          const cx = w / 2; const cy = h / 2;
          const R = Math.min(w, h) * 0.26;
          const bars = 64;
          for (let i = 0; i < bars; i++) {
            const idx = Math.floor((i / bars) * (N * 0.6));
            const v = (data[idx] || 0) / 255;
            const ang = (i / bars) * Math.PI * 2 + this.hue * 0.01;
            const r1 = R;
            const r2 = R + 3 + v * (Math.min(w, h) * 0.22);
            ctx.strokeStyle = `hsl(${(this.hue + i * 4) % 360} 80% 62%)`;
            ctx.lineWidth = Math.max(1.4, (Math.PI * 2 * R / bars) * 0.55);
            ctx.beginPath();
            ctx.moveTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
            ctx.lineTo(cx + Math.cos(ang) * r2, cy + Math.sin(ang) * r2);
            ctx.stroke();
          }
          ctx.fillStyle = `hsl(${this.hue % 360} 80% 60% / .18)`;
          ctx.beginPath(); ctx.arc(cx, cy, R - 2, 0, Math.PI * 2); ctx.fill();
          break;
        }
        case 'dots': {
          if (this.dots.length !== 64) {
            this.dots = Array.from({ length: 64 }, () => ({ x: Math.random(), y: Math.random(), vy: 0 }));
          }
          const avg = Array.from({ length: 64 }, (_, i) => (data[Math.floor((i / 64) * N * 0.6)] || 0) / 255);
          this.dots.forEach((d, i) => {
            d.vy += (avg[i] * 0.5 - d.y) * 0.06;
            d.vy *= 0.9;
            d.y += d.vy;
            d.y = Math.max(0.02, Math.min(1, d.y));
            const r = 1.5 + d.y * 4.5;
            ctx.fillStyle = `hsl(${(this.hue + i * 5) % 360} 85% 65% / ${0.35 + d.y * 0.6})`;
            ctx.beginPath();
            ctx.arc(d.x * w, h - d.y * h, r, 0, Math.PI * 2);
            ctx.fill();
          });
          break;
        }
        default: { // bars
          const bars = Math.min(64, Math.floor(w / 6));
          const bw = w / bars;
          for (let i = 0; i < bars; i++) {
            const idx = Math.floor(Math.pow(i / bars, 1.35) * (N * 0.72));
            const v = (data[idx] || 0) / 255;
            const bh = Math.max(2, v * (h - 6));
            const g = ctx.createLinearGradient(0, h, 0, h - bh);
            g.addColorStop(0, a); g.addColorStop(1, b);
            ctx.fillStyle = g;
            const r = Math.min(3, bw / 2.4);
            roundRect(ctx, i * bw + 1, h - bh, bw - 2, bh, r);
            ctx.fill();
          }
        }
      }
    }

    destroy() { this.stop(); window.removeEventListener('resize', this._onResize); }
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  /** 播放栏迷你频谱 */
  function makeMiniEq(container, engine, bars = 5) {
    container.innerHTML = '';
    const els = [];
    for (let i = 0; i < bars; i++) {
      const b = document.createElement('i');
      b.style.height = '4px';
      container.appendChild(b);
      els.push(b);
    }
    let raf = null;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const data = engine && engine.frequencyData ? engine.frequencyData() : null;
      if (!data) { for (const e of els) e.style.height = '4px'; return; }
      const N = data.length;
      for (let i = 0; i < bars; i++) {
        const idx = Math.floor(Math.pow((i + 1) / (bars + 1), 1.6) * N * 0.7);
        const v = (data[idx] || 0) / 255;
        els[i].style.height = `${4 + v * 22}px`;
      }
    };
    raf = requestAnimationFrame(loop);
    return { stop() { if (raf) cancelAnimationFrame(raf); } };
  }

  window.Visualizer = Visualizer;
  window.makeMiniEq = makeMiniEq;
})();
