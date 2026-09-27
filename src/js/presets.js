/**
 * 内置均衡器预设 + 内置音效插件（音效插件市场）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AURORA_PRESETS = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 10 段均衡器预设（单位 dB，顺序：31 62 125 250 500 1k 2k 4k 8k 16k）
  const EQ_PRESETS = {
    '默认': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    '流行': [-1, 0, 2, 4, 4, 2, 0, -1, -1, -1],
    '摇滚': [5, 4, 3, 1, -1, -1, 1, 3, 4, 5],
    '古典': [4, 3, 2, 1, -1, -1, 0, 2, 3, 4],
    '爵士': [3, 2, 1, 2, -1, -1, 0, 1, 2, 3],
    '人声': [-3, -2, -1, 2, 4, 5, 4, 2, 0, -1],
    '低音增强': [7, 6, 5, 3, 1, 0, 0, 0, 0, 0],
    '重低音': [9, 8, 6, 3, 0, -1, -2, -3, -2, -1],
    '高音增强': [-2, -1, 0, 0, 1, 2, 4, 5, 6, 7],
    '电子': [4, 3, 1, 0, -2, 1, 2, 4, 5, 5],
    '民谣': [2, 1, 0, 2, 3, 3, 2, 0, 1, 2],
    '夜晚': [-2, -1, 0, 1, 2, 2, 1, 0, -1, -2],
    '电影': [6, 5, 3, 1, 0, 0, 1, 3, 4, 6],
    'V 型': [6, 5, 3, 0, -3, -4, -2, 2, 5, 7],
    '播客': [-4, -3, -1, 2, 4, 5, 4, 2, 0, -2]
  };

  // 内置音效插件：以声明式效果图描述，可被用户自定义插件文件扩展
  const BUILTIN_PLUGINS = [
    {
      id: 'builtin.surround3d', name: '3D 环绕声', author: 'Aurora', version: '1.0.0', builtin: true,
      desc: '扩展声场，让声音环绕在四周', category: '空间',
      params: [{ key: 'mix', label: '环绕强度', min: 0, max: 100, default: 55, unit: '%' }],
      graph: [
        { node: 'stereo', type: 'panner', params: { pan: 0 } },
        { node: 'spread', type: 'delay', params: { time: 0.012, mix: '{mix}', feedback: 0.12 } }
      ]
    },
    {
      id: 'builtin.reverbHall', name: '大厅混响', author: 'Aurora', version: '1.0.0', builtin: true,
      desc: '音乐厅般的长混响尾巴', category: '空间',
      params: [
        { key: 'mix', label: '湿度', min: 0, max: 100, default: 35, unit: '%' },
        { key: 'size', label: '空间大小', min: 0, max: 100, default: 60, unit: '%' }
      ],
      graph: [{ node: 'rev', type: 'convolver', params: { ir: 'hall', seconds: 2.6, decay: 2.4, mix: '{mix}' } }]
    },
    {
      id: 'builtin.reverbRoom', name: '房间混响', author: 'Aurora', version: '1.0.0', builtin: true,
      desc: '小房间的自然反射', category: '空间',
      params: [{ key: 'mix', label: '湿度', min: 0, max: 100, default: 22, unit: '%' }],
      graph: [{ node: 'rev', type: 'convolver', params: { ir: 'room', seconds: 0.9, decay: 3.2, mix: '{mix}' } }]
    },
    {
      id: 'builtin.bassBoost', name: '超重低音', author: 'Aurora', version: '1.0.0', builtin: true,
      desc: '加强 60-120Hz，鼓点更结实', category: '动态',
      params: [{ key: 'gain', label: '强度', min: 0, max: 12, default: 6, unit: 'dB' }],
      graph: [
        { node: 'b1', type: 'biquad', params: { type: 'lowshelf', freq: 90, gain: '{gain}', q: 0.7 } },
        { node: 'b2', type: 'biquad', params: { type: 'peaking', freq: 60, gain: '{gain}', q: 0.9 } }
      ]
    },
    {
      id: 'builtin.vocalClear', name: '清澈人声', author: 'Aurora', version: '1.0.0', builtin: true,
      desc: '突出中频人声，削弱浑浊感', category: '人声',
      params: [{ key: 'gain', label: '清晰度', min: 0, max: 10, default: 4, unit: 'dB' }],
      graph: [
        { node: 'c1', type: 'biquad', params: { type: 'peaking', freq: 300, gain: '-{gain}', q: 1.0 } },
        { node: 'c2', type: 'biquad', params: { type: 'peaking', freq: 2800, gain: '{gain}', q: 1.1 } }
      ]
    },
    {
      id: 'builtin.vocalRemove', name: '人声消除 (卡拉OK)', author: 'Aurora', version: '1.0.0', builtin: true,
      desc: '声道相减消除居中的人声', category: '人声',
      params: [{ key: 'mix', label: '消除量', min: 0, max: 100, default: 85, unit: '%' }],
      graph: [{ node: 'vr', type: 'vocalsRemover', params: { mix: '{mix}' } }]
    },
    {
      id: 'builtin.eightD', name: '8D 环绕', author: 'Aurora', version: '1.0.0', builtin: true,
      desc: '声音自动绕头旋转', category: '空间',
      params: [
        { key: 'speed', label: '旋转速度', min: 1, max: 20, default: 6 },
        { key: 'depth', label: '环绕深度', min: 0, max: 100, default: 70, unit: '%' }
      ],
      graph: [{ node: 'orbit', type: 'autoPan', params: { speed: '{speed}', depth: '{depth}' } }]
    },
    {
      id: 'builtin.night', name: '夜晚柔和', author: 'Aurora', version: '1.0.0', builtin: true,
      desc: '压缩动态，深夜小声也听得清', category: '动态',
      params: [{ key: 'amount', label: '压缩量', min: 0, max: 100, default: 60, unit: '%' }],
      graph: [
        { node: 'comp', type: 'compressor', params: { threshold: -28, knee: 22, ratio: 9, attack: 0.004, release: 0.22 } },
        { node: 'trim', type: 'gain', params: { gain: 0.92 } }
      ]
    },
    {
      id: 'builtin.warmTube', name: '温暖胆机', author: 'Aurora', version: '1.0.0', builtin: true,
      desc: '轻微偶次谐波失真，声音更暖', category: '染色',
      params: [{ key: 'drive', label: '胆味', min: 0, max: 100, default: 30, unit: '%' }],
      graph: [{ node: 'tube', type: 'waveshaper', params: { curve: 'tube', amount: '{drive}', mix: 0.85 } }]
    },
    {
      id: 'builtin.live', name: '摇滚现场', author: 'Aurora', version: '1.0.0', builtin: true,
      desc: '现场感混响 + 高频激励', category: '场景',
      params: [{ key: 'mix', label: '现场感', min: 0, max: 100, default: 45, unit: '%' }],
      graph: [
        { node: 'hp', type: 'biquad', params: { type: 'highshelf', freq: 6500, gain: 3.5, q: 0.7 } },
        { node: 'rev', type: 'convolver', params: { ir: 'room', seconds: 1.2, decay: 2.6, mix: '{mix}' } }
      ]
    },
    {
      id: 'builtin.car', name: '车载音响', author: 'Aurora', version: '1.0.0', builtin: true,
      desc: '补偿车内噪音，增强低频与清晰度', category: '场景',
      params: [{ key: 'gain', label: '强度', min: 0, max: 100, default: 55, unit: '%' }],
      graph: [
        { node: 'lo', type: 'biquad', params: { type: 'lowshelf', freq: 120, gain: 5, q: 0.7 } },
        { node: 'hi', type: 'biquad', params: { type: 'highshelf', freq: 5000, gain: 3, q: 0.7 } },
        { node: 'mid', type: 'biquad', params: { type: 'peaking', freq: 1800, gain: 2, q: 1.0 } }
      ]
    },
    {
      id: 'builtin.studio', name: '录音棚监听', author: 'Aurora', version: '1.0.0', builtin: true,
      desc: '平坦、解析力优先的还原风格', category: '监听',
      params: [{ key: 'air', label: '空气感', min: 0, max: 100, default: 25, unit: '%' }],
      graph: [
        { node: 'sub', type: 'biquad', params: { type: 'highpass', freq: 28, q: 0.7 } },
        { node: 'air', type: 'biquad', params: { type: 'highshelf', freq: 12000, gain: 2, q: 0.7 } }
      ]
    },
    {
      id: 'builtin.lofi', name: 'Lo-Fi 磁带', author: 'Aurora', version: '1.0.0', builtin: true,
      desc: '带宽限制 + 轻微抖动，复古磁带味', category: '染色',
      params: [{ key: 'amount', label: '复古度', min: 0, max: 100, default: 50, unit: '%' }],
      graph: [
        { node: 'hp', type: 'biquad', params: { type: 'highpass', freq: 120, q: 0.6 } },
        { node: 'lp', type: 'biquad', params: { type: 'lowpass', freq: 7200, q: 0.6 } },
        { node: 'wow', type: 'chorus', params: { rate: 0.4, depth: 0.0035, mix: 0.35 } }
      ]
    },
    {
      id: 'builtin.electronic', name: '电子舞曲', author: 'Aurora', version: '1.0.0', builtin: true,
      desc: '强劲低频 + 明亮高频的 EDM 调音', category: '场景',
      params: [{ key: 'pump', label: '力度', min: 0, max: 100, default: 60, unit: '%' }],
      graph: [
        { node: 'sub', type: 'biquad', params: { type: 'lowshelf', freq: 70, gain: 6.5, q: 0.8 } },
        { node: 'punch', type: 'biquad', params: { type: 'peaking', freq: 110, gain: 4, q: 1.2 } },
        { node: 'brill', type: 'biquad', params: { type: 'highshelf', freq: 9000, gain: 4, q: 0.7 } },
        { node: 'comp', type: 'compressor', params: { threshold: -20, knee: 12, ratio: 4, attack: 0.003, release: 0.18 } }
      ]
    },
    {
      id: 'builtin.chorus', name: '合唱空间', author: 'Aurora', version: '1.0.0', builtin: true,
      desc: '多声部合唱般的宽广感', category: '空间',
      params: [{ key: 'mix', label: '厚度', min: 0, max: 100, default: 40, unit: '%' }],
      graph: [{ node: 'ch', type: 'chorus', params: { rate: 1.2, depth: 0.008, mix: 0.45, voices: 3 } }]
    },
    {
      id: 'builtin.telephone', name: '电话音效', author: 'Aurora', version: '1.0.0', builtin: true,
      desc: '带通滤波，老式电话听筒效果', category: '趣味',
      params: [{ key: 'q', label: '带宽', min: 0, max: 100, default: 50, unit: '%' }],
      graph: [
        { node: 'hp', type: 'biquad', params: { type: 'highpass', freq: 400, q: 1.4 } },
        { node: 'lp', type: 'biquad', params: { type: 'lowpass', freq: 3400, q: 1.4 } }
      ]
    },
    {
      id: 'builtin.slowReverb', name: '梦幻空间', author: 'Aurora', version: '1.0.0', builtin: true,
      desc: '长混响 + 轻柔合唱，梦幻氛围', category: '空间',
      params: [{ key: 'mix', label: '梦幻度', min: 0, max: 100, default: 55, unit: '%' }],
      graph: [
        { node: 'ch', type: 'chorus', params: { rate: 0.6, depth: 0.012, mix: 0.5 } },
        { node: 'rev', type: 'convolver', params: { ir: 'hall', seconds: 4.2, decay: 1.8, mix: '{mix}' } }
      ]
    }
  ];

  return { EQ_PRESETS, BUILTIN_PLUGINS };
});
