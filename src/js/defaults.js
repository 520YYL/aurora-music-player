/**
 * 极光音乐 Aurora Music —— 共享默认配置
 * 同时被主进程 (require) 和渲染进程 (<script>) 使用。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AURORA_DEFAULTS = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

  const DEFAULT_SETTINGS = {
    version: 2,
    // 外观
    theme: 'glass',            // glass | flat | neumorph | skeuo | midnight | macaron
    accent: '#7c5cff',
    accent2: '#22d3ee',
    radius: 18,
    density: 'cozy',           // compact | cozy | comfy
    fontFamily: '',
    background: {
      type: 'gradient',        // gradient | image | color | none
      value: '',               // 图片路径 / 颜色值
      blur: 0,                 // 0-40 px
      dim: 0.35,               // 0-0.9 黑色遮罩
      saturate: 1,
      fit: 'cover'
    },
    animatedBg: true,
    visualizer: { enabled: true, style: 'bars', bars: 48, opacity: 0.55, position: 'bottom' },

    // 播放
    playback: {
      mode: 'sequential',      // sequential | shuffle | repeat-all | repeat-one | shuffle-one
      rate: 1,                 // 0.5 - 3
      pitch: 0,                // -12 ~ +12 半音
      preservePitch: true,     // 变速不变调
      volume: 0.8,
      muted: false,
      transition: 'crossfade', // none | fade | crossfade | smooth | dip | gapless
      transitionMs: 1200,
      gaplessLead: 300,
      normalize: false,
      rememberPosition: false,
      autoPlayNext: true,
      skipShortTracks: 0
    },

    // 均衡器
    eq: {
      enabled: false,
      preamp: 0,
      bands: EQ_FREQS.map(() => 0),
      preset: '默认'
    },

    // 桌面歌词
    lyrics: {
      desktopEnabled: false,
      locked: false,
      alwaysOnTop: true,
      clickThrough: false,
      fontSize: 34,
      lineGap: 14,
      opacity: 0.96,
      align: 'center',           // left | center | right
      color: '#ffffff',
      activeColor: '#7c5cff',
      playedColor: '#22d3ee',
      cnFont: '"Microsoft YaHei UI", "PingFang SC", sans-serif',
      enFont: '"Segoe UI", "Arial", sans-serif',
      weight: 700,
      shadow: { enabled: true, color: '#000000', blur: 12, x: 0, y: 2, opacity: 0.85 },
      stroke: { enabled: true, width: 1.4, color: '#000000' },
      showTranslation: true,
      showNextLine: true,
      showProgressBar: false,
      karaoke: true,
      pos: { x: null, y: null, w: 1100, h: 220 },
      monitor: 'primary'
    },

    mini: {
      visible: false,
      pos: { x: null, y: null },
      size: { w: 340, h: 128 },
      opacity: 0.94,
      alwaysOnTop: true,
      showVisualizer: true
    },

    // 音效插件
    plugins: {
      installed: [],           // 已安装（含内置）
      enabled: [],             // 启用中的插件 id
      params: {}               // { [pluginId]: { [key]: value } }
    },

    shortcuts: {
      inApp: {
        playPause: 'Space',
        next: 'Ctrl+ArrowRight',
        prev: 'Ctrl+ArrowLeft',
        volumeUp: 'Ctrl+ArrowUp',
        volumeDown: 'Ctrl+ArrowDown',
        mute: 'Ctrl+M',
        seekForward: 'ArrowRight',
        seekBackward: 'ArrowLeft',
        toggleDesktopLyrics: 'Ctrl+L',
        toggleMini: 'Ctrl+P',
        toggleMain: 'Ctrl+Alt+A',
        shuffle: 'Ctrl+S',
        repeat: 'Ctrl+R',
        favorite: 'Ctrl+D',
        search: 'Ctrl+F',
        theme: 'Ctrl+T',
        eq: 'Ctrl+E',
        stats: 'Ctrl+I'
      },
      global: {
        playPause: 'MediaPlayPause',
        next: 'MediaNextTrack',
        prev: 'MediaPreviousTrack',
        stop: 'MediaStop',
        toggleMain: 'Ctrl+Alt+A',
        toggleDesktopLyrics: 'Ctrl+Alt+L'
      },
      globalEnabled: true
    },

    library: {
      roots: [],
      autoScan: false,
      watch: true,
      showDuration: true
    },

    // 听歌时长统计
    stats: {
      enabled: true,
      countOnlyPlayed: true,   // 只在真正播放计入
      minSeconds: 5,           // 单曲少于该秒数不计入
      dailyGoalMinutes: 60
    },

    ui: {
      lastView: 'library',
      sortKey: 'manual',
      sortDir: 'asc',
      viewMode: 'list',        // list | grid
      playlistId: 'all',
      showCoverArt: true,
      zoom: 1
    }
  };

  const AUDIO_EXTS = ['.mp3', '.ogg', '.oga', '.m4a', '.m4b', '.mp4', '.flac', '.wav', '.aac', '.opus', '.weba', '.webm'];

  const THEMES = [
    { id: 'glass', name: '玻璃拟态', desc: '毛玻璃通透质感' },
    { id: 'flat', name: '扁平化', desc: '干净利落，纯色块' },
    { id: 'neumorph', name: '新拟态', desc: '柔和凸起与内凹' },
    { id: 'skeuo', name: '拟物化', desc: '金属拉丝与真实质感' },
    { id: 'midnight', name: '暗夜极简', desc: '深色高对比' },
    { id: 'macaron', name: '马卡龙', desc: '明亮活泼的糖果色' }
  ];

  const TRANSITIONS = [
    { id: 'none', name: '直接切换', desc: '无任何过渡' },
    { id: 'fade', name: '淡出淡入', desc: '先渐弱，再渐强' },
    { id: 'crossfade', name: '交叉淡化', desc: '两首歌平滑重叠' },
    { id: 'smooth', name: '缓慢融合', desc: '长交叉淡化，适合慢歌' },
    { id: 'dip', name: '快速闪接', desc: '快速压低再拉起的 DJ 切歌' },
    { id: 'gapless', name: '无缝衔接', desc: '零间隙，适合连续专辑' }
  ];

  return { DEFAULT_SETTINGS, EQ_FREQS, AUDIO_EXTS, THEMES, TRANSITIONS };
});
