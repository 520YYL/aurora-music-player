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

    // 桌面歌词浮层
    // 注意：clickThrough（鼠标穿透）和 locked 已经删掉。
    // 穿透开着的时候窗口收不到任何鼠标事件，用户没法再点回按钮关掉它 —— 等于死锁，
    // 所以这两个功能整体下架。
    lyrics: {
      desktopEnabled: false,
      alwaysOnTop: true,
      // 外观
      style: 'karaoke',          // karaoke | classic | minimal
      fontSize: 26,              // 12 - 90；正在唱 / 翻译 / 下一句三行统一用这个固定字号
      weight: 700,
      lineGap: 12,
      opacity: 0.96,
      color: '#ffffff',          // 常规字色
      activeColor: '#7c5cff',    // 已唱部分的颜色
      unsungColor: '#8a90a8',    // 还没唱到的部分
      cnFont: '"Microsoft YaHei UI", "PingFang SC", sans-serif',
      enFont: '"Segoe UI", "Arial", sans-serif',
      jpFont: '"Meiryo", "Yu Gothic UI", "MS PGothic", "Hiragino Sans", "Noto Sans JP", sans-serif',
      jpTrans: true,             // 日语（或纯外语）歌词自动去网易云补一份中文翻译
      shadow: { enabled: true, color: '#000000', blur: 14, x: 0, y: 2, opacity: 0.85 },
      karaoke: true,             // 逐字高亮
      sweepWidth: 8,             // 光带宽度（%），越小切得越硬
      showTranslation: true,
      showNextLine: true,
      showProgressBar: false,
      showCover: true,           // 左侧圆形封面
      coverSize: 96,             // 圆形封面直径
      coverShape: 'circle',      // circle | rounded
      // 节奏可视化：封面随低频脉动 + 歌词下方一排横向频谱
      specStyle: 'both',         // none | pulse | ring(仅频谱) | both
      specSensitivity: 1,        // 0.4 - 2.5，整体灵敏度
      // 底板：浮层本身是全透明的，遇到浅色壁纸歌词会看不清，所以默认给一层淡底
      bg: { enabled: true, color: '#0b0d17', opacity: 0.55, radius: 18 },
      pos: { x: null, y: null, w: 420, h: 150 }
    },

    shortcuts: {
      // 应用内快捷键已按用户要求整体下架：设置页不再显示，启动也不再补默认值。
      // 保留一个空对象占位，避免老配置里的 inApp 残留（迁移块会把它清空）。
      inApp: {},
      global: {
        playPause: 'MediaPlayPause',
        next: 'MediaNextTrack',
        prev: 'MediaPreviousTrack',
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

    // 在线歌曲下载（右键在线搜索结果 →「下载到本地」）
    // dir 留空 = 系统「音乐」文件夹下的「Aurora 下载」
    download: {
      dir: ''
    },

    // 听歌时长统计
    stats: {
      enabled: true,
      countOnlyPlayed: true,   // 只在真正播放计入
      minSeconds: 5,           // 单曲少于该秒数不计入
      dailyGoalMinutes: 60,
      range: 'day'             // 统计图表的默认粒度：day | week | month | year
    },

    ui: {
      lastView: 'library',
      sortKey: 'manual',
      sortDir: 'asc',
      viewMode: 'list',        // list | grid
      playlistId: 'all',
      showCoverArt: true,
      zoom: 1,
      // 点右上角 ✕ 时隐藏到托盘（音乐继续放），而不是退出应用。
      // 默认 true：直接退出会让正在听的歌突然中断，很容易被当成 bug。
      closeToTray: true
    },

    // 上次播放到哪首、哪个位置（启动时自动装回播放器）
    // 下划线开头：设置页不展示，属于运行状态而不是用户可选项
    _lastPlayback: null,
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
