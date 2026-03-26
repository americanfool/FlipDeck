import { FLAP_AUDIO_BASE64 } from './flapAudio.js';

export class SoundEngine {
  constructor(volume = 0.6) {
    this.ctx = null;
    this.muted = false;
    this._initialized = false;
    this._audioBuffer = null;
    this._volume = volume;
    this._currentSource = null;
  }

  get ready() {
    return this._initialized && this._audioBuffer !== null;
  }

  async init() {
    if (this._initialized) return;
    this._initialized = true;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();

    try {
      const binaryStr = atob(FLAP_AUDIO_BASE64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      this._audioBuffer = await this.ctx.decodeAudioData(bytes.buffer);
    } catch (e) {
      console.warn('Failed to decode flap audio:', e);
    }
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  toggleMute() {
    this.muted = !this.muted;
    return this.muted;
  }

  // Play the full transition recording once per message change
  playTransition() {
    if (!this.ready || this.muted) return;
    if (this.ctx.state === 'suspended') return;

    // Stop any currently playing clip
    if (this._currentSource) {
      try { this._currentSource.stop(); } catch (_) {}
    }

    const source = this.ctx.createBufferSource();
    source.buffer = this._audioBuffer;

    const gain = this.ctx.createGain();
    gain.gain.value = this._volume;

    source.connect(gain);
    gain.connect(this.ctx.destination);
    source.start(0);

    this._currentSource = source;
    source.onended = () => {
      if (this._currentSource === source) this._currentSource = null;
    };
  }
}
