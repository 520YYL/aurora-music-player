'use strict';
/**
 * 极光音乐 —— 主进程 JSON 持久化存储
 * 原子写入 + 防抖，避免频繁磁盘 IO 与写坏文件。
 */
const fs = require('node:fs');
const path = require('node:path');

function deepClone(v) {
  try { return structuredClone(v); } catch { return JSON.parse(JSON.stringify(v)); }
}

class JsonStore {
  constructor(file, defaults = {}) {
    this.file = file;
    this.defaults = defaults;
    this._timer = null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.data = this._read();
  }

  _read() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return Object.assign(deepClone(this.defaults), parsed);
      }
      return parsed === undefined ? deepClone(this.defaults) : parsed;
    } catch {
      return deepClone(this.defaults);
    }
  }

  get all() { return this.data; }

  get(key, fallback) {
    if (key === undefined) return this.data;
    const parts = String(key).split('.');
    let cur = this.data;
    for (const p of parts) {
      if (cur === null || cur === undefined || typeof cur !== 'object') return fallback;
      cur = cur[p];
    }
    return cur === undefined ? fallback : cur;
  }

  set(key, value) {
    if (key === undefined || key === null) {
      this.data = value;
    } else {
      const parts = String(key).split('.');
      let cur = this.data;
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {};
        cur = cur[p];
      }
      cur[parts[parts.length - 1]] = value;
    }
    this.saveDebounced();
    return this.data;
  }

  merge(patch) {
    if (!patch || typeof patch !== 'object') return this.data;
    this.data = deepMerge(this.data, patch);
    this.saveDebounced();
    return this.data;
  }

  saveDebounced(ms = 350) {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => { this._timer = null; this.save(); }, ms);
  }

  save() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    const tmp = this.file + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf8');
      fs.renameSync(tmp, this.file);
      return true;
    } catch (err) {
      try { fs.writeFileSync(this.file, JSON.stringify(this.data), 'utf8'); return true; } catch { return false; }
    }
  }

  reload() { this.data = this._read(); return this.data; }
}

function deepMerge(base, patch) {
  if (Array.isArray(patch)) return deepClone(patch);
  if (patch === null || typeof patch !== 'object') return patch;
  const out = (base && typeof base === 'object' && !Array.isArray(base)) ? base : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = deepClone(v);
    }
  }
  return out;
}

module.exports = { JsonStore, deepMerge, deepClone };
