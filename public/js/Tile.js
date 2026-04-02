const DRUM_ORDER = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,:!?/-\'';
const DRUM_INDEX = new Map();
for (let i = 0; i < DRUM_ORDER.length; i++) {
  DRUM_INDEX.set(DRUM_ORDER[i], i);
}

// Web Worker drives all setTimeout calls — immune to background tab throttling
const worker = new Worker('js/timer-worker.js');
const pendingTimers = new Map();
let _nextId = 1;

worker.onmessage = (e) => {
  const cb = pendingTimers.get(e.data.id);
  if (cb) {
    pendingTimers.delete(e.data.id);
    cb();
  }
};

function reliableTimeout(cb, delay) {
  const id = _nextId++;
  pendingTimers.set(id, cb);
  worker.postMessage({ action: 'set', id, delay });
}

export class Tile {
  constructor(row, col) {
    this.row = row;
    this.col = col;
    this.currentChar = ' ';
    this.isAnimating = false;
    this._cancelToken = null;

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

  flipTo(targetChar, delay, flipTime) {
    if (!DRUM_INDEX.has(targetChar)) targetChar = ' ';
    if (targetChar === this.currentChar) return Promise.resolve();

    if (this._cancelToken) this._cancelToken.cancelled = true;
    const token = { cancelled: false };
    this._cancelToken = token;
    this.isAnimating = true;

    return new Promise((resolve) => {
      reliableTimeout(() => {
        if (token.cancelled) { resolve(); return; }
        this._stepThrough(targetChar, flipTime, token, resolve);
      }, delay);
    });
  }

  _stepThrough(targetChar, flipTime, token, resolve) {
    if (token.cancelled || this.currentChar === targetChar) {
      this.isAnimating = false;
      this._cancelToken = null;
      this.innerEl.classList.remove('flipping');
      resolve();
      return;
    }

    const nextChar = Tile.nextDrumChar(this.currentChar);
    this.backSpan.textContent = nextChar === ' ' ? '\u00A0' : nextChar;

    // JS-driven transform — works in background tabs unlike CSS @keyframes
    this.innerEl.style.transition = 'none';
    this.innerEl.style.transform = 'rotateX(0deg)';
    void this.innerEl.offsetHeight;
    this.innerEl.style.transition = `transform ${flipTime}ms ease-in-out`;
    this.innerEl.style.transform = 'rotateX(-180deg)';

    reliableTimeout(() => {
      this.innerEl.style.transition = 'none';
      this.innerEl.style.transform = '';
      this.currentChar = nextChar;
      this.frontSpan.textContent = nextChar === ' ' ? '\u00A0' : nextChar;
      this.backSpan.textContent = '\u00A0';
      void this.innerEl.offsetHeight;
      this._stepThrough(targetChar, flipTime, token, resolve);
    }, flipTime);
  }
}
