// Character drum in fixed order — same as a real split-flap display.
// The drum only spins forward. To reach a character, it advances through
// every intermediate position, just like mechanical hardware.
const DRUM_ORDER = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,:!?/-\'';
const DRUM_INDEX = new Map();
for (let i = 0; i < DRUM_ORDER.length; i++) {
  DRUM_INDEX.set(DRUM_ORDER[i], i);
}

export class Tile {
  constructor(row, col) {
    this.row = row;
    this.col = col;
    this.currentChar = ' ';
    this.isAnimating = false;
    this._cancelToken = null;

    // Build DOM
    this.el = document.createElement('div');
    this.el.className = 'tile';

    this.innerEl = document.createElement('div');
    this.innerEl.className = 'tile-inner';

    this.frontEl = document.createElement('div');
    this.frontEl.className = 'tile-front';
    this.frontSpan = document.createElement('span');
    this.frontEl.appendChild(this.frontSpan);

    this.backEl = document.createElement('div');
    this.backEl.className = 'tile-back';
    this.backSpan = document.createElement('span');
    this.backEl.appendChild(this.backSpan);

    this.innerEl.appendChild(this.frontEl);
    this.innerEl.appendChild(this.backEl);
    this.el.appendChild(this.innerEl);
  }

  setChar(char) {
    this.currentChar = char;
    this.frontSpan.textContent = char === ' ' ? '\u00A0' : char;
    this.backSpan.textContent = '\u00A0';
    this.innerEl.style.transform = '';
    this.innerEl.classList.remove('flipping');
  }

  static nextDrumChar(char) {
    const idx = DRUM_INDEX.get(char) ?? 0;
    return DRUM_ORDER[(idx + 1) % DRUM_ORDER.length];
  }

  /**
   * Flip to the target character by advancing through every intermediate
   * position on the drum. Each step is a 3D flip animation.
   *
   * @param {string} targetChar - Character to land on
   * @param {number} delay - ms to wait before starting
   * @param {number} flipTime - ms per single flip step
   * @param {function} onFlip - callback fired on each flip (for sound)
   * @returns {Promise} resolves when done
   */
  flipTo(targetChar, delay, flipTime, onFlip) {
    if (!DRUM_INDEX.has(targetChar)) targetChar = ' ';
    if (targetChar === this.currentChar) return Promise.resolve();

    if (this._cancelToken) {
      this._cancelToken.cancelled = true;
    }
    const token = { cancelled: false };
    this._cancelToken = token;
    this.isAnimating = true;

    return new Promise((resolve) => {
      setTimeout(() => {
        if (token.cancelled) { resolve(); return; }
        this._stepThrough(targetChar, flipTime, onFlip, token, resolve);
      }, delay);
    });
  }

  _stepThrough(targetChar, flipTime, onFlip, token, resolve) {
    if (token.cancelled || this.currentChar === targetChar) {
      this.isAnimating = false;
      this._cancelToken = null;
      this.innerEl.classList.remove('flipping');
      resolve();
      return;
    }

    const nextChar = Tile.nextDrumChar(this.currentChar);

    // Set back face to the next character
    this.backSpan.textContent = nextChar === ' ' ? '\u00A0' : nextChar;

    // Trigger CSS flip animation
    this.innerEl.style.setProperty('--flip-duration', `${flipTime}ms`);
    this.innerEl.classList.remove('flipping');
    void this.innerEl.offsetHeight; // force reflow
    this.innerEl.classList.add('flipping');

    if (onFlip) onFlip();

    // Use setTimeout instead of animationend — more reliable at fast speeds
    setTimeout(() => {
      this.innerEl.classList.remove('flipping');
      this.innerEl.style.transform = '';
      this.currentChar = nextChar;
      this.frontSpan.textContent = nextChar === ' ' ? '\u00A0' : nextChar;
      this.backSpan.textContent = '\u00A0';

      // Force reflow before next step
      void this.innerEl.offsetHeight;

      this._stepThrough(targetChar, flipTime, onFlip, token, resolve);
    }, flipTime);
  }
}

