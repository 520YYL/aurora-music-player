/**
 * Aurora 极光音乐 —— 变调 AudioWorklet
 * 双抽头颗粒变调（overlap-add + 正弦窗），与播放速度完全独立。
 */
class AuroraPitchShifter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'pitchRatio', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }];
  }
  constructor(options) {
    super();
    const g = (options && options.processorOptions && options.processorOptions.grainSize) || 2048;
    this.grain = Math.max(256, g | 0);
    this.size = this.grain * 8;
    this.bufs = [new Float32Array(this.size), new Float32Array(this.size)];
    this.w = 0;
    this.phase = 0;
    this.started = false;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || !output.length) return true;
    const n = output[0].length;
    const ratioArr = parameters.pitchRatio;
    const ratio = ratioArr && ratioArr.length ? ratioArr[0] : 1;
    const bypass = Math.abs(ratio - 1) < 1e-4;
    const size = this.size;
    const grain = this.grain;
    const bufs = this.bufs;
    const chCount = Math.min(2, output.length);

    for (let i = 0; i < n; i++) {
      // 写入环形缓冲
      for (let ch = 0; ch < 2; ch++) {
        const src = input && input[ch] ? input[ch][i] : (input && input[0] ? input[0][i] : 0);
        bufs[ch][this.w] = src || 0;
      }
      this.w = (this.w + 1) % size;

      if (bypass) {
        for (let ch = 0; ch < chCount; ch++) {
          const src = input && input[ch] ? input[ch][i] : (input && input[0] ? input[0][i] : 0);
          output[ch][i] = src || 0;
        }
        continue;
      }

      this.phase += (1 - ratio) / grain;
      this.phase -= Math.floor(this.phase);

      for (let ch = 0; ch < chCount; ch++) {
        let acc = 0;
        let gsum = 0;
        const buf = bufs[ch];
        for (let k = 0; k < 2; k++) {
          let ph = this.phase + k * 0.5;
          ph -= Math.floor(ph);
          const delay = 1 + ph * (grain - 2);
          const gain = Math.sin(Math.PI * ph);
          let rp = this.w - delay;
          while (rp < 0) rp += size;
          const i0 = rp | 0;
          const frac = rp - i0;
          const a = buf[i0 % size];
          const b = buf[(i0 + 1) % size];
          acc += gain * (a + (b - a) * frac);
          gsum += gain;
        }
        output[ch][i] = gsum > 0.001 ? acc / gsum : 0;
      }
    }
    return true;
  }
}

class AuroraBypass extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (input && output) {
      for (let ch = 0; ch < output.length; ch++) {
        if (input[ch]) output[ch].set(input[ch]);
      }
    }
    return true;
  }
}

registerProcessor('aurora-pitch-shifter', AuroraPitchShifter);
registerProcessor('aurora-bypass', AuroraBypass);
