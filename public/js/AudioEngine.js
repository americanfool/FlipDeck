import { FLAP_AUDIO_BASE64 } from './flapAudio.js';

export class AudioEngine {
  constructor(volume = 0.6) {
    this.ctx = null;
    this.volume = volume;
    this.muted = false;
    this.buffers = new Map();
    this.variantGroups = {
      transient: [],
      burst: [],
      settle: []
    };
    this.masterGain = null;
    this.compressor = null;
    this.buses = {};
    this._transitionProfile = null;
    this._eventQueue = [];
    this._sliceTimer = 0;
    this._finalSettleTimer = 0;
    this._lastTriggerAt = {
      transient: 0,
      burst: 0,
      settle: 0
    };
    this._activeVoices = {
      transient: 0,
      burst: 0,
      settle: 0
    };
    this._variantCursor = {
      transient: 0,
      burst: 0,
      settle: 0
    };
    this._liveVoices = new Set();
  }

  get ready() {
    return this.ctx !== null && this.buffers.size > 0;
  }

  async init() {
    if (this.ctx) return;

    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -12;
    this.compressor.knee.value = 20;
    this.compressor.ratio.value = 1.6;
    this.compressor.attack.value = 0.008;
    this.compressor.release.value = 0.12;

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.muted ? 0 : 1;

    this.buses.transient = this._createBus({ gain: 1.12, highpass: 55, lowpass: 5200 });
    this.buses.burst = this._createBus({ gain: 1.08, highpass: 45, lowpass: 4200 });
    this.buses.settle = this._createBus({ gain: 1.1, highpass: 35, lowpass: 4800 });

    this.buses.transient.output.connect(this.masterGain);
    this.buses.burst.output.connect(this.masterGain);
    this.buses.settle.output.connect(this.masterGain);
    this.masterGain.connect(this.compressor);
    this.compressor.connect(this.ctx.destination);

    const flapBuffer = await this._decodeBase64Buffer(FLAP_AUDIO_BASE64);
    this._buildBuffers(flapBuffer);
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      return this.ctx.resume();
    }

    return Promise.resolve();
  }

  startTransition(summary) {
    if (!this.ready || this.muted) return;

    this.resume();
    this.stopTransition(false);

    if (this._finalSettleTimer) {
      clearTimeout(this._finalSettleTimer);
      this._finalSettleTimer = 0;
    }

    const changedTiles = Math.max(1, summary.changedTiles || 1);
    const quality = summary.quality || 'balanced';

    this._transitionProfile = {
      changedTiles,
      quality,
      intensity: Math.min(1, (changedTiles / 28) + ((summary.totalSteps || 0) / 220)),
      rows: Math.max(1, summary.rows || 1),
      cols: Math.max(1, summary.cols || 1),
      rowBankSize: Math.max(1, summary.rowBankSize || 4),
      windowMs: quality === 'low' ? 56 : quality === 'balanced' ? 42 : 34,
      cooldowns: {
        transient: quality === 'low' ? 0.065 : quality === 'balanced' ? 0.05 : 0.04,
        burst: quality === 'low' ? 0.11 : quality === 'balanced' ? 0.085 : 0.07,
        settle: quality === 'low' ? 0.16 : quality === 'balanced' ? 0.12 : 0.1,
      },
      caps: {
        transient: quality === 'low' ? 2 : 3,
        burst: quality === 'low' ? 1 : 2,
        settle: 1,
      },
      literalThreshold: changedTiles <= 10 ? 2 : 1,
      burstThreshold: changedTiles <= 12 ? 5 : changedTiles <= 26 ? 4 : 3,
      detailChance: Math.max(0.2, Math.min(0.58, 0.74 - (changedTiles / 115))),
    };

    this._resetSchedulerState();
    this._startScheduler();
  }

  enqueueFlip({ isFinalStep = false, row = 0, col = 0, cadence = 44 } = {}) {
    if (!this.ready || this.muted || !this._transitionProfile) return;
    if (this.ctx.state === 'suspended') return;

    this._eventQueue.push({ isFinalStep, row, col, cadence });
  }

  stopTransition(playFinal = true) {
    if (this._finalSettleTimer) {
      clearTimeout(this._finalSettleTimer);
      this._finalSettleTimer = 0;
    }

    if (this._sliceTimer) {
      clearInterval(this._sliceTimer);
      this._sliceTimer = 0;
    }

    this._stopLiveVoices();

    this._transitionProfile = null;
    this._resetSchedulerState();

    if (playFinal && this.ready && !this.muted) {
      this._playLayer('settle', {
        gainAmount: 0.068,
        playbackRate: 0.995,
        pan: 0,
      });

      this._finalSettleTimer = window.setTimeout(() => {
        this._playLayer('transient', {
          gainAmount: 0.036,
          playbackRate: 0.985,
          pan: 0,
        });
        this._finalSettleTimer = 0;
      }, 34);
    }
  }

  stop() {
    this.stopTransition(false);
  }

  toggleMute() {
    this.muted = !this.muted;

    if (this.masterGain && this.ctx) {
      const now = this.ctx.currentTime;
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setTargetAtTime(this.muted ? 0 : 1, now, 0.01);
    }

    if (this.muted) {
      this.stopTransition(false);
    }

    return this.muted;
  }

  _resetSchedulerState() {
    this._eventQueue = [];
    this._lastTriggerAt.transient = 0;
    this._lastTriggerAt.burst = 0;
    this._lastTriggerAt.settle = 0;
    this._activeVoices.transient = 0;
    this._activeVoices.burst = 0;
    this._activeVoices.settle = 0;
    this._variantCursor.transient = 0;
    this._variantCursor.burst = 0;
    this._variantCursor.settle = 0;
  }

  _startScheduler() {
    if (this._sliceTimer || !this._transitionProfile) return;

    this._sliceTimer = window.setInterval(() => {
      this._flushQueue();
    }, this._transitionProfile.windowMs);
  }

  _flushQueue() {
    const profile = this._transitionProfile;
    if (!profile || !this.ready || this.muted || this.ctx?.state === 'suspended') return;
    if (this._eventQueue.length === 0) return;

    const events = this._eventQueue.splice(0, this._eventQueue.length);
    const now = this.ctx.currentTime;
    let flips = 0;
    let settles = 0;
    let totalCadence = 0;
    let totalCol = 0;
    let minCol = Number.POSITIVE_INFINITY;
    let maxCol = Number.NEGATIVE_INFINITY;
    const bankMap = new Map();

    for (const event of events) {
      flips++;
      totalCadence += event.cadence;
      totalCol += event.col;
      if (event.isFinalStep) settles++;

       minCol = Math.min(minCol, event.col);
       maxCol = Math.max(maxCol, event.col);

      const bankId = Math.floor(event.row / profile.rowBankSize);
      if (!bankMap.has(bankId)) {
        bankMap.set(bankId, {
          flips: 0,
          settles: 0,
          totalCadence: 0,
          totalCol: 0,
          minCol: event.col,
          maxCol: event.col,
        });
      }

      const bank = bankMap.get(bankId);
      bank.flips++;
      bank.totalCadence += event.cadence;
      bank.totalCol += event.col;
      bank.minCol = Math.min(bank.minCol, event.col);
      bank.maxCol = Math.max(bank.maxCol, event.col);
      if (event.isFinalStep) bank.settles++;
    }

    const avgCadence = totalCadence / flips;
    const avgCol = totalCol / flips;
    const stereoBias = this._colToPan(avgCol, profile.cols);
    const cadenceFactor = Math.max(0, Math.min(1, (70 - avgCadence) / 40));
    const density = flips / Math.max(1, profile.changedTiles * 0.16);
    const globalSpread = (maxCol - minCol) / Math.max(1, profile.cols - 1);
    const bursty = flips >= profile.burstThreshold || density >= 1;
    const banks = [...bankMap.entries()]
      .map(([bankId, bank]) => ({
        bankId,
        flips: bank.flips,
        settles: bank.settles,
        avgCadence: bank.totalCadence / bank.flips,
        avgCol: bank.totalCol / bank.flips,
        pan: this._colToPan(bank.totalCol / bank.flips, profile.cols),
        spread: (bank.maxCol - bank.minCol) / Math.max(1, profile.cols - 1),
      }))
      .sort((a, b) => b.flips - a.flips);

    if (bursty) {
      this._emitBurstLayer({ flips, settles, cadenceFactor, stereoBias, profile, now, banks, globalSpread });
    } else {
      this._emitTransientLayer({ flips, settles, cadenceFactor, stereoBias, profile, now, banks });
    }

    if (settles > 0) {
      this._emitSettleLayer({ settles, stereoBias, profile, now, banks });
    }
  }

  _emitTransientLayer({ flips, settles, cadenceFactor, stereoBias, profile, now, banks }) {
    if (!this._canTrigger('transient', now, profile)) return;
    if (flips < profile.literalThreshold && Math.random() > profile.detailChance) return;

    const hits = Math.min(flips, profile.changedTiles <= 10 ? 2 : 1);
    for (let i = 0; i < hits; i++) {
      const bank = banks[i] || banks[0];
      const panOffset = bank ? bank.pan : (i === 0 ? stereoBias : stereoBias * -0.6);
      this._playLayer('transient', {
        gainAmount: Math.max(0.048, 0.066 + (cadenceFactor * 0.016) + (settles * 0.005)),
        playbackRate: (settles > 0 ? 0.998 : 0.985) + (Math.random() * 0.012),
        pan: panOffset,
        whenOffset: i * 0.01,
      });
    }

    this._lastTriggerAt.transient = now;
  }

  _emitBurstLayer({ flips, settles, cadenceFactor, stereoBias, profile, now, banks, globalSpread }) {
    if (!this._canTrigger('burst', now, profile)) return;

    const primaryBank = banks[0];
    const secondaryBank = banks[1];
    const primaryPan = primaryBank ? primaryBank.pan : stereoBias;
    const secondaryPan = secondaryBank ? secondaryBank.pan : (globalSpread > 0.38 ? -primaryPan : primaryPan * -0.5);

    this._playLayer('burst', {
      gainAmount: Math.min(0.12, 0.072 + (Math.min(6, flips) * 0.007) + (profile.intensity * 0.01)),
      playbackRate: 0.968 + (Math.random() * 0.016),
      pan: primaryPan,
    });

    if (
      this._activeVoices.burst < profile.caps.burst &&
      ((secondaryBank && secondaryBank.flips >= 2) || globalSpread > 0.34 || flips >= 7)
    ) {
      this._playLayer('burst', {
        gainAmount: 0.05 + (profile.intensity * 0.006),
        playbackRate: 0.958 + (cadenceFactor * 0.012) + (Math.random() * 0.012),
        pan: secondaryPan,
        whenOffset: 0.016,
      });
    }

    if (settles > 0 && this._activeVoices.transient < profile.caps.transient && Math.random() <= 0.55) {
      this._playLayer('transient', {
        gainAmount: 0.046,
        playbackRate: 1 + (Math.random() * 0.012),
        pan: primaryPan * 0.45,
        whenOffset: 0.022,
      });
    }

    this._lastTriggerAt.burst = now;
  }

  _emitSettleLayer({ settles, stereoBias, profile, now, banks }) {
    if (!this._canTrigger('settle', now, profile)) return;

    const settleBank = banks.find(bank => bank.settles > 0) || banks[0];

    this._playLayer('settle', {
      gainAmount: Math.min(0.082, 0.048 + (Math.min(4, settles) * 0.008) + (profile.intensity * 0.008)),
      playbackRate: 0.995 + (Math.random() * 0.012),
      pan: settleBank ? settleBank.pan * 0.18 : stereoBias * 0.15,
    });

    this._lastTriggerAt.settle = now;
  }

  _canTrigger(layer, now, profile) {
    return (
      this._activeVoices[layer] < profile.caps[layer] &&
      (now - this._lastTriggerAt[layer]) >= profile.cooldowns[layer]
    );
  }

  _playLayer(layer, { gainAmount, playbackRate, pan, whenOffset = 0 }) {
    const key = this._pickVariant(layer);
    const buffer = key ? this.buffers.get(key) : null;
    if (!buffer || !this.ctx) return;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = playbackRate;

    const gain = this.ctx.createGain();
    gain.gain.value = gainAmount * this.volume;

    const panner = typeof this.ctx.createStereoPanner === 'function'
      ? this.ctx.createStereoPanner()
      : this.ctx.createGain();

    if ('pan' in panner) {
      panner.pan.value = Math.max(-0.35, Math.min(0.35, pan));
    }

    this._activeVoices[layer]++;

    source.connect(gain);
    gain.connect(panner);
    panner.connect(this.buses[layer].input);
    source.start(this.ctx.currentTime + whenOffset);

    const voice = { source, gain, panner, layer };
    this._liveVoices.add(voice);

    source.onended = () => {
      this._liveVoices.delete(voice);
      source.disconnect();
      gain.disconnect();
      panner.disconnect();
      this._activeVoices[layer] = Math.max(0, this._activeVoices[layer] - 1);
    };
  }

  _pickVariant(layer) {
    const group = this.variantGroups[layer];
    if (!group || group.length === 0) return null;

    const idx = this._variantCursor[layer] % group.length;
    this._variantCursor[layer]++;
    return group[idx];
  }

  _createBus({ gain, highpass, lowpass }) {
    const input = this.ctx.createGain();
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = highpass;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = lowpass;
    const out = this.ctx.createGain();
    out.gain.value = gain;

    input.connect(hp);
    hp.connect(lp);
    lp.connect(out);

    return { input, output: out };
  }

  _stopLiveVoices() {
    if (!this.ctx || this._liveVoices.size === 0) return;

    const now = this.ctx.currentTime;
    for (const voice of this._liveVoices) {
      try {
        voice.gain.gain.cancelScheduledValues(now);
        voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
        voice.gain.gain.linearRampToValueAtTime(0, now + 0.025);
        voice.source.stop(now + 0.03);
      } catch (_) {}
    }

    this._liveVoices.clear();
  }

  _colToPan(col, cols) {
    if (cols <= 1) return 0;
    const normalized = (col / (cols - 1)) * 2 - 1;
    return Math.max(-0.3, Math.min(0.3, normalized * 0.65));
  }

  _buildBuffers(flapBuffer) {
    this.buffers.clear();
    this.variantGroups.transient = [];
    this.variantGroups.burst = [];
    this.variantGroups.settle = [];

    if (flapBuffer) {
      const slices = this._extractTransientSlices(flapBuffer);
      if (slices.length >= 6) {
        this._addVariant('flap-soft-a', this._makeSliceVariant(slices[0], {
          gain: 0.92,
          startTrim: 0.0,
          endTrim: 0.008,
          fadeIn: 0.0004,
          fadeOut: 0.05,
          targetPeak: 0.72,
        }), 'transient');
        this._addVariant('flap-soft-b', this._makeSliceVariant(slices[1], {
          gain: 0.88,
          startTrim: 0.0,
          endTrim: 0.01,
          fadeIn: 0.0004,
          fadeOut: 0.046,
          targetPeak: 0.68,
        }), 'transient');
        this._addVariant('flap-hard-a', this._makeSliceVariant(slices[2], {
          gain: 1,
          startTrim: 0.0,
          endTrim: 0.006,
          fadeIn: 0.0002,
          fadeOut: 0.055,
          targetPeak: 0.76,
        }), 'transient');

        this._addVariant('flap-burst-a', this._makeSliceVariant(slices[3], {
          gain: 0.96,
          startTrim: 0.0,
          endTrim: 0.012,
          fadeIn: 0.0003,
          fadeOut: 0.05,
          targetPeak: 0.74,
        }), 'burst');
        this._addVariant('flap-burst-b', this._makeSliceVariant(slices[4], {
          gain: 0.92,
          startTrim: 0.0,
          endTrim: 0.014,
          fadeIn: 0.0003,
          fadeOut: 0.048,
          targetPeak: 0.72,
        }), 'burst');

        this._addVariant('flap-settle-a', this._makeSliceVariant(slices[5], {
          gain: 0.9,
          startTrim: 0.0,
          endTrim: 0.0,
          fadeIn: 0.0004,
          fadeOut: 0.065,
          targetPeak: 0.74,
        }), 'settle');
        this._addVariant('flap-settle-b', this._makeSliceVariant(slices[6] || slices[5], {
          gain: 0.86,
          startTrim: 0.0,
          endTrim: 0.004,
          fadeIn: 0.0004,
          fadeOut: 0.058,
          targetPeak: 0.7,
        }), 'settle');
        return;
      }
    }

    this._addVariant('flap-soft-a', this._synthesizeClick({ attack: 0.0014, decay: 150, body: 0.08, noise: 0.035 }), 'transient');
    this._addVariant('flap-soft-b', this._synthesizeClick({ attack: 0.0011, decay: 132, body: 0.07, noise: 0.03 }), 'transient');
    this._addVariant('flap-hard-a', this._synthesizeClick({ attack: 0.001, decay: 120, body: 0.12, noise: 0.05 }), 'transient');
    this._addVariant('flap-burst-a', this._synthesizeClick({ attack: 0.0008, decay: 112, body: 0.11, noise: 0.05 }), 'burst');
    this._addVariant('flap-burst-b', this._synthesizeClick({ attack: 0.0008, decay: 104, body: 0.1, noise: 0.048 }), 'burst');
    this._addVariant('flap-settle-a', this._synthesizeClack(), 'settle');
    this._addVariant('flap-settle-b', this._synthesizeClack(), 'settle');
  }

  _addVariant(key, buffer, group) {
    this.buffers.set(key, buffer);
    this.variantGroups[group].push(key);
  }

  _makeSliceVariant(sourceBuffer, opts) {
    const sampleRate = sourceBuffer.sampleRate;
    const channelCount = sourceBuffer.numberOfChannels;
    const totalLength = sourceBuffer.length;
    const start = Math.max(0, Math.floor((opts.startTrim || 0) * sampleRate));
    const end = Math.min(totalLength, totalLength - Math.floor((opts.endTrim || 0) * sampleRate));
    const length = Math.max(256, end - start);
    const out = this.ctx.createBuffer(channelCount, length, sampleRate);
    const fadeIn = Math.max(1, Math.floor((opts.fadeIn || 0.001) * sampleRate));
    const fadeOut = Math.max(1, Math.floor((opts.fadeOut || 0.03) * sampleRate));
    const gain = opts.gain ?? 1;
    const targetPeak = opts.targetPeak ?? 0;
    const peak = this._measurePeak(sourceBuffer);
    const normalization = targetPeak > 0 && peak > 0 ? Math.min(3.5, targetPeak / peak) : 1;

    for (let ch = 0; ch < channelCount; ch++) {
      const src = sourceBuffer.getChannelData(ch);
      const dest = out.getChannelData(ch);

      for (let i = 0; i < length; i++) {
        let env = gain * normalization;
        if (i < fadeIn) {
          env *= i / fadeIn;
        }
        if (i > length - fadeOut) {
          env *= Math.max(0, (length - i) / fadeOut);
        }

        dest[i] = src[start + i] * env;
      }
    }

    return out;
  }

  _measurePeak(buffer) {
    let peak = 0;
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < data.length; i++) {
        peak = Math.max(peak, Math.abs(data[i]));
      }
    }
    return peak;
  }

  _extractTransientSlices(sourceBuffer) {
    const data = sourceBuffer.getChannelData(0);
    const sampleRate = sourceBuffer.sampleRate;
    const hop = Math.max(1, Math.floor(sampleRate * 0.008));
    const minSpacing = Math.floor(sampleRate * 0.085);
    const threshold = 0.11;
    const peaks = [];
    let lastPeak = -minSpacing;

    for (let i = 0; i < data.length; i += hop) {
      let peak = 0;
      let peakIndex = i;
      const end = Math.min(data.length, i + hop);
      for (let j = i; j < end; j++) {
        const v = Math.abs(data[j]);
        if (v > peak) {
          peak = v;
          peakIndex = j;
        }
      }

      if (peak >= threshold && (peakIndex - lastPeak) >= minSpacing) {
        peaks.push(peakIndex);
        lastPeak = peakIndex;
      }
    }

    return peaks.slice(0, 12).map((peakIndex) => {
      const pre = Math.floor(sampleRate * 0.018);
      const post = Math.floor(sampleRate * 0.16);
      const start = Math.max(0, peakIndex - pre);
      const end = Math.min(data.length, peakIndex + post);
      const length = Math.max(256, end - start);
      const out = this.ctx.createBuffer(sourceBuffer.numberOfChannels, length, sampleRate);

      for (let ch = 0; ch < sourceBuffer.numberOfChannels; ch++) {
        const src = sourceBuffer.getChannelData(ch);
        const dest = out.getChannelData(ch);
        for (let i = 0; i < length; i++) {
          dest[i] = src[start + i];
        }
      }

      return out;
    });
  }

  async _decodeBase64Buffer(base64) {
    try {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }

      return await this.ctx.decodeAudioData(bytes.buffer);
    } catch (e) {
      console.warn('Failed to decode flap sample:', e);
      return null;
    }
  }

  _synthesizeClick({ attack, decay, body, noise }) {
    const duration = 0.024;
    const sampleRate = this.ctx.sampleRate;
    const length = sampleRate * duration;
    const buffer = this.ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    const freqA = 1120 + (Math.random() * 180);
    const freqB = 1460 + (Math.random() * 220);

    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      const transient = Math.min(1, t / attack);
      const envelope = transient * Math.exp(-t * decay);
      const partials =
        (Math.sin(2 * Math.PI * freqA * t) * 0.46) +
        (Math.sin(2 * Math.PI * freqB * t) * 0.2);
      const grit = ((Math.random() * 2) - 1) * noise;
      const lowBody = Math.sin(2 * Math.PI * 260 * t) * body;
      data[i] = (partials + grit + lowBody) * envelope;
    }

    return buffer;
  }

  _synthesizeClack() {
    const duration = 0.03;
    const sampleRate = this.ctx.sampleRate;
    const length = sampleRate * duration;
    const buffer = this.ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      const envelope = Math.exp(-t * 110);
      const metallic =
        (Math.sin(2 * Math.PI * 760 * t) * 0.2) +
        (Math.sin(2 * Math.PI * 1180 * t) * 0.12) +
        (Math.sin(2 * Math.PI * 1680 * t) * 0.05);
      const bite = ((Math.random() * 2) - 1) * 0.028;
      data[i] = (metallic + bite) * envelope;
    }

    return buffer;
  }
}
