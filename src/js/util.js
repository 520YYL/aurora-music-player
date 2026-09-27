/**
 * Aurora 极光音乐 —— 通用工具
 */
(function () {
  'use strict';

  // 全局错误收集（便于诊断，也供 --smoke 自检读取）
  window.__auroraErrors = window.__auroraErrors || [];
  window.addEventListener('error', (e) => {
    try { window.__auroraErrors.push(`error: ${e.message} @${String(e.filename || '').split('/').pop()}:${e.lineno}`); } catch { /* ignore */ }
  });
  window.addEventListener('unhandledrejection', (e) => {
    try {
      const r = e.reason;
      window.__auroraErrors.push(`unhandledrejection: ${(r && r.message) || String(r)}`);
    } catch { /* ignore */ }
  });

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function ce(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') el.className = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v === true ? '' : v);
      }
    }
    if (children) for (const c of [].concat(children)) { if (c) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }
    return el;
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  /** 秒 -> mm:ss */
  function fmtTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '00:00';
    const s = Math.floor(sec % 60);
    const m = Math.floor(sec / 60) % 60;
    const h = Math.floor(sec / 3600);
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  /** 毫秒 -> mm:ss（用于累计时长） */
  function fmtMs(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '00:00';
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor(total / 60) % 60;
    const s = total % 60;
    if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
    return `${pad(m)}:${pad(s)}`;
  }

  /** 毫秒 -> 中文长格式 */
  function fmtLong(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '0 分钟';
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor(total / 60) % 60;
    const s = total % 60;
    if (h > 0) return `${h} 小时 ${m} 分`;
    if (m > 0) return `${m} 分 ${s} 秒`;
    return `${s} 秒`;
  }

  function fmtSize(bytes) {
    if (!bytes) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0; let v = bytes;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
  }

  function fmtDate(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function fmtDateTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function dayKey(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

  function escapeHtml(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function debounce(fn, ms) {
    let t = null;
    return function (...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), ms); };
  }
  function throttle(fn, ms) {
    let last = 0; let timer = null;
    return function (...args) {
      const now = Date.now();
      if (now - last >= ms) { last = now; fn.apply(this, args); }
      else if (!timer) { timer = setTimeout(() => { timer = null; last = Date.now(); fn.apply(this, args); }, ms - (now - last)); }
    };
  }

  const isMac = navigator.platform.toLowerCase().includes('mac');

  /** 从键盘事件生成快捷键字符串 */
  function hotkeyFromEvent(e) {
    const mods = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push(isMac ? 'Cmd' : 'Meta');
    let key = e.key;
    if (['Control', 'Alt', 'Shift', 'Meta', 'OS'].includes(key)) return null;
    if (key === ' ') key = 'Space';
    else if (key.length === 1) key = key.toUpperCase();
    else if (key === 'Escape') key = 'Escape';
    const media = { MediaPlayPause: 'MediaPlayPause', MediaTrackNext: 'MediaNextTrack', MediaTrackPrevious: 'MediaPreviousTrack', MediaStop: 'MediaStop' };
    if (media[key]) return media[key];
    if (!mods.length && !/^F\d{1,2}$/.test(key) && !['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Tab', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'Escape'].includes(key) && !e.code.startsWith('Media')) return null;
    return [...mods, key].join('+');
  }

  /** 判断键盘事件是否匹配快捷键 */
  function matchHotkey(e, spec) {
    if (!spec) return false;
    const parts = spec.split('+');
    const key = parts[parts.length - 1];
    const need = new Set(parts.slice(0, -1).map((m) => (m === 'Cmd' || m === 'Command' || m === 'Meta' ? (isMac ? 'Cmd' : 'Meta') : m)));
    const hasCtrl = e.ctrlKey; const hasAlt = e.altKey; const hasShift = e.shiftKey; const hasMeta = e.metaKey;
    if (need.has('Ctrl') !== hasCtrl) return false;
    if (need.has('Alt') !== hasAlt) return false;
    if (need.has('Shift') !== hasShift) return false;
    if ((need.has('Meta') || need.has('Cmd')) !== hasMeta) return false;
    let k = e.key;
    if (k === ' ') k = 'Space';
    else if (k.length === 1) k = k.toUpperCase();
    else if (k.startsWith('Arrow')) k = k; // 保持 ArrowUp 形式
    if (k === 'Esc') k = 'Escape';
    const media = { MediaPlayPause: 'MediaPlayPause', MediaTrackNext: 'MediaNextTrack', MediaTrackPrevious: 'MediaPreviousTrack', MediaStop: 'MediaStop' };
    if (e.code && e.code.startsWith('Media')) k = media[e.code] || e.key;
    return k === key;
  }

  /** 把 Ctrl+ArrowRight 显示成 Ctrl+→ */
  const GLYPH = { ArrowRight: '→', ArrowLeft: '←', ArrowUp: '↑', ArrowDown: '↓', Space: '空格', Escape: 'Esc', Enter: '回车', MediaPlayPause: '媒体播放', MediaNextTrack: '媒体下一曲', MediaPreviousTrack: '媒体上一曲', MediaStop: '媒体停止' };
  function prettyHotkey(spec) {
    if (!spec) return '未设置';
    return spec.split('+').map((p) => GLYPH[p] || p).join(' + ');
  }

  function toast(msg, type = '', ms = 2600) {
    const wrap = document.getElementById('toasts');
    if (!wrap) return;
    const t = ce('div', { class: `toast ${type}`, text: msg });
    wrap.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateX(20px)'; t.style.transition = 'all .3s'; setTimeout(() => t.remove(), 320); }, ms);
    return t;
  }

  function modal(title, desc, bodyEl, footEls) {
    const root = document.getElementById('modalRoot');
    const mask = ce('div', { class: 'modal-mask' });
    const box = ce('div', { class: 'modal panel' });
    const close = () => { mask.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    box.appendChild(ce('h2', { text: title }));
    if (desc) box.appendChild(ce('div', { class: 'm-desc', text: desc }));
    if (bodyEl) box.appendChild(bodyEl);
    const foot = ce('div', { class: 'm-foot' });
    for (const f of footEls || []) foot.appendChild(f);
    if (!footEls || !footEls.length) foot.appendChild(ce('button', { class: 'btn', text: '关闭', onclick: close }));
    box.appendChild(foot);
    mask.appendChild(box);
    mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
    root.appendChild(mask);
    document.addEventListener('keydown', onKey);
    return { close, box, mask };
  }

  function confirmBox(title, desc, okText, onOk) {
    const ok = ce('button', { class: 'btn primary', text: okText || '确定', onclick: () => { m.close(); onOk && onOk(); } });
    const cancel = ce('button', { class: 'btn', text: '取消' });
    const m = modal(title, desc, null, [cancel, ok]);
    cancel.onclick = () => m.close();
    return m;
  }

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function hexToRgba(hex, a) {
    const h = String(hex || '').replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const n = parseInt(full || '000000', 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  /** 从文件名/标题推测语言，用于中英文字体分别渲染 */
  function hasCJK(s) { return /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]/.test(String(s || '')); }

  function download(name, text) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const a = ce('a', { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  window.U = {
    $, $$, ce, pad, fmtTime, fmtMs, fmtLong, fmtSize, fmtDate, fmtDateTime, dayKey,
    escapeHtml, debounce, throttle, hotkeyFromEvent, matchHotkey, prettyHotkey,
    toast, modal, confirmBox, clamp, hexToRgba, hasCJK, download, isMac
  };
})();
