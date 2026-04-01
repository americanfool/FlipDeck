import { Tile } from './Tile.js';
import { AudioEngine } from './AudioEngine.js';
import { PhysicsEngine } from './PhysicsEngine.js';

export class Board {
  constructor(containerEl, config, sharedAudioEngine = null) {
    this.cols = config.grid.cols;
    this.rows = config.grid.rows;
    this.config = config;
    this.isTransitioning = false;
    this.tiles = [];
    this.currentGrid = [];

    this.physicsEngine = new PhysicsEngine(config.physics);
    this.audioEngine = null;
    if (sharedAudioEngine) {
      this.audioEngine = sharedAudioEngine;
    } else if (config.sound?.enabled !== false) {
      this.audioEngine = new AudioEngine(config.sound?.volume ?? 0.6);
    }

    this._rafId = 0;
    this._safetyTimer = null;
    this._transition = null;
    this._lastFrameAt = 0;
    this._frameSamples = [];
    this.performance = this._buildPerformanceProfile();

    this.boardEl = document.createElement('div');
    this.boardEl.className = 'board';
    this.boardEl.style.setProperty('--grid-cols', this.cols);
    this.boardEl.style.setProperty('--grid-rows', this.rows);
    this.boardEl.dataset.quality = this.performance.quality;

    this.gridEl = document.createElement('div');
    this.gridEl.className = 'tile-grid';

    for (let r = 0; r < this.rows; r++) {
      const row = [];
      const charRow = [];

      for (let c = 0; c < this.cols; c++) {
        const tile = new Tile(r, c);
        tile.setChar(' ');
        this.gridEl.appendChild(tile.el);
        row.push(tile);
        charRow.push(' ');
      }

      this.tiles.push(row);
      this.currentGrid.push(charRow);
    }

    this.boardEl.appendChild(this.gridEl);
    containerEl.appendChild(this.boardEl);

    this._tick = this._tick.bind(this);
  }

  async initAudio() {
    if (!this.audioEngine) return;
    await this.audioEngine.init();
    this.audioEngine.resume();
  }

  dispose() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = 0;
    }

    if (this._safetyTimer) {
      clearTimeout(this._safetyTimer);
      this._safetyTimer = null;
    }

    this.audioEngine?.stopTransition(false);

    if (this._transition?.resolve) {
      this._transition.resolve();
    }

    this._transition = null;
    this.isTransitioning = false;

    for (const row of this.tiles) {
      for (const tile of row) {
        tile.dispose();
      }
    }
  }

  setLinesImmediate(lines) {
    const grid = this._formatToGrid(lines);

    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        this.tiles[r][c].setChar(grid[r][c]);
      }
    }

    this.currentGrid = grid;
  }

  displayMessage(lines) {
    this._syncCurrentGridFromTiles();

    if (this.isTransitioning) return Promise.resolve();

    const newGrid = this._formatToGrid(lines);
    const startAt = performance.now();
    const pending = [];
    let changedTiles = 0;
    let totalSteps = 0;
    let estimatedDuration = 0;

    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const tile = this.tiles[r][c];
        const currentChar = tile.currentChar;
        const targetChar = newGrid[r][c];

        if (currentChar === targetChar) continue;

        const physics = this.physicsEngine.calculateFlip(currentChar, targetChar, {
          motorVariance: this.config.physics?.motorVariance ?? 8
        });

        const delay = this._getFlipDelay(r, c) + physics.motorDelay;
        const stepCadence = Math.max(30, Math.round(physics.perCharTime / tile.motorStrength));
        const finalCatch = Math.max(8, Math.round(physics.settleDuration * tile.settleBias));

        pending.push({
          tile,
          targetChar,
          startAt: startAt + delay,
          stepCadence,
          finalCatch,
          phase: 'waiting',
          phaseEndsAt: 0,
          topDuration: 0,
          bottomDuration: 0,
          stepTargetChar: null
        });

        changedTiles++;
        totalSteps += physics.distance;
        estimatedDuration = Math.max(
          estimatedDuration,
          delay + (physics.distance * stepCadence) + finalCatch
        );
      }
    }

    if (pending.length === 0) {
      this.currentGrid = newGrid;
      return Promise.resolve();
    }

    pending.sort((a, b) => a.startAt - b.startAt);

    this.isTransitioning = true;
    this._lastFrameAt = 0;
    this._frameSamples = [];

    return new Promise((resolve) => {
      this._transition = {
        pending,
        ready: [],
        active: [],
        completed: 0,
        total: pending.length,
        newGrid,
        resolve
      };

      this.audioEngine?.startTransition({
        changedTiles,
        totalSteps,
        duration: estimatedDuration,
        quality: this.performance.quality,
        rows: this.rows,
        cols: this.cols,
        rowBankSize: this.config.timing?.rowBankSize ?? 4
      });

      this._safetyTimer = setTimeout(() => {
        this._abortTransition();
      }, Math.max(12000, estimatedDuration * 3));

      this._scheduleTick();
    });
  }

  _tick(now) {
    const transition = this._transition;
    if (!transition) {
      this._rafId = 0;
      return;
    }

    if (this._lastFrameAt !== 0) {
      this._frameSamples.push(now - this._lastFrameAt);
      if (this._frameSamples.length > 180) {
        this._frameSamples.shift();
      }
    }
    this._lastFrameAt = now;

    while (transition.pending.length > 0 && transition.pending[0].startAt <= now) {
      transition.ready.push(transition.pending.shift());
    }

    for (let i = transition.active.length - 1; i >= 0; i--) {
      const flip = transition.active[i];
      if (now < flip.phaseEndsAt) continue;

      if (flip.phase === 'top-drop') {
        flip.phase = 'bottom-rise';
        flip.phaseEndsAt = now + flip.bottomDuration;
        flip.tile.beginBottomRise(flip.bottomDuration);
        continue;
      }

      if (flip.phase === 'bottom-rise') {
        flip.tile.commitStep(flip.stepTargetChar);

        if (flip.stepTargetChar === flip.targetChar) {
          transition.active.splice(i, 1);
          transition.completed++;
        } else {
          this._beginStep(flip, now);
        }
      }
    }

    let startedThisFrame = 0;
    while (
      transition.ready.length > 0 &&
      transition.active.length < this.performance.maxConcurrentTiles &&
      startedThisFrame < this.performance.maxStartsPerFrame
    ) {
      const flip = transition.ready.shift();
      this._beginStep(flip, now);
      transition.active.push(flip);
      startedThisFrame++;
    }

    if (transition.completed >= transition.total) {
      this._finishTransition();
      return;
    }

    this._scheduleTick();
  }

  _beginStep(flip, now) {
    const currentChar = flip.tile.currentChar;
    const nextChar = Tile.nextDrumChar(currentChar);
    const isFinalStep = nextChar === flip.targetChar;

    flip.stepTargetChar = nextChar;
    flip.topDuration = Math.max(18, Math.round(flip.stepCadence * 0.44));
    flip.bottomDuration = Math.max(
      20,
      Math.round(flip.stepCadence * 0.56) + (isFinalStep ? flip.finalCatch : 0)
    );
    flip.phase = 'top-drop';
    flip.phaseEndsAt = now + flip.topDuration;

    flip.tile.beginTopDrop(currentChar, nextChar, flip.topDuration);
    this.audioEngine?.enqueueFlip({
      isFinalStep,
      row: flip.tile.row,
      col: flip.tile.col,
      cadence: flip.stepCadence
    });
  }

  _scheduleTick() {
    if (this._rafId) return;
    this._rafId = requestAnimationFrame((now) => {
      this._rafId = 0;
      this._tick(now);
    });
  }

  _finishTransition(playFinalSound = true) {
    if (this._safetyTimer) {
      clearTimeout(this._safetyTimer);
      this._safetyTimer = null;
    }

    this._syncCurrentGridFromTiles();
    this.isTransitioning = false;

    const resolve = this._transition?.resolve;
    this._transition = null;

    this.audioEngine?.stopTransition(playFinalSound);
    this._maybeAdjustQuality();

    if (resolve) resolve();
  }

  _abortTransition() {
    const transition = this._transition;
    if (!transition) return;

    for (const flip of transition.active) {
      flip.tile.cancelActiveStep();
      flip.tile.setChar(flip.tile.currentChar);
    }

    for (const flip of transition.ready) {
      flip.tile.cancelActiveStep();
    }

    for (const flip of transition.pending) {
      flip.tile.cancelActiveStep();
    }

    this._finishTransition(false);
  }

  _syncCurrentGridFromTiles() {
    const grid = [];

    for (let r = 0; r < this.rows; r++) {
      const row = [];
      for (let c = 0; c < this.cols; c++) {
        row.push(this.tiles[r][c].currentChar);
      }
      grid.push(row);
    }

    this.currentGrid = grid;
  }

  _buildPerformanceProfile(forceQuality) {
    const tileCount = this.rows * this.cols;
    const cores = navigator.hardwareConcurrency || 4;
    const quality = forceQuality || this._getBaseQuality(tileCount, cores);

    if (quality === 'low') {
      return {
        quality,
        maxConcurrentTiles: 6,      // Reduced from 14 - too many concurrent animations
        maxStartsPerFrame: 2,       // Reduced from 4 - spread out work
        maxConcurrentBanks: 2         // NEW: Limit row banks
      };
    }

    if (quality === 'balanced') {
      return {
        quality,
        maxConcurrentTiles: 12,       // Reduced from 22
        maxStartsPerFrame: 4,       // Reduced from 6
        maxConcurrentBanks: 3
      };
    }

    return {
      quality: 'full',
      maxConcurrentTiles: 20,       // Reduced from 32
      maxStartsPerFrame: 6,       // Reduced from 10
      maxConcurrentBanks: 4
    };
  }

  _getBaseQuality(tileCount, cores) {
    if (cores <= 4 || tileCount > 180) return 'low';
    if (cores <= 8 || tileCount > 120) return 'balanced';
    return 'full';
  }

  _maybeAdjustQuality() {
    if (this._frameSamples.length < 12) return;

    const total = this._frameSamples.reduce((sum, sample) => sum + sample, 0);
    const avg = total / this._frameSamples.length;
    const worst = Math.max(...this._frameSamples);

    if ((avg > 22 || worst > 75) && this.performance.quality !== 'low') {
      const nextQuality = this.performance.quality === 'full' ? 'balanced' : 'low';
      this.performance = this._buildPerformanceProfile(nextQuality);
      this.boardEl.dataset.quality = this.performance.quality;
      return;
    }

    if (avg < 14 && worst < 32 && this.performance.quality === 'low') {
      this.performance = this._buildPerformanceProfile('balanced');
      this.boardEl.dataset.quality = this.performance.quality;
    }
  }

  _getFlipDelay(row, col) {
    const timing = this.config.timing || {};
    const bankSize = Math.max(1, timing.rowBankSize ?? 4);
    const bankDelay = timing.rowBankDelay ?? 28;
    const rowSkew = timing.rowBankSkew ?? 4;
    const colSkew = timing.colBankSkew ?? 1;
    const bankIndex = Math.floor(row / bankSize);
    const rowOffset = (row % bankSize) * rowSkew;
    const colOffset = (col % 4) * colSkew;

    return (bankIndex * bankDelay) + rowOffset + colOffset;
  }

  _formatToGrid(lines) {
    const grid = [];

    for (let r = 0; r < this.rows; r++) {
      const line = (lines[r] || '').toUpperCase();
      const padTotal = this.cols - line.length;
      const padLeft = Math.max(0, Math.floor(padTotal / 2));
      const padded = ' '.repeat(padLeft) + line +
        ' '.repeat(Math.max(0, this.cols - padLeft - line.length));
      grid.push(padded.split(''));
    }

    return grid;
  }
}
