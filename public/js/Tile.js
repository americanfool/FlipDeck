const DRUM_ORDER = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,:!?/-\'';
const DRUM_INDEX = new Map();
for (let i = 0; i < DRUM_ORDER.length; i++) {
  DRUM_INDEX.set(DRUM_ORDER[i], i);
}

function displayChar(char) {
  return char === ' ' ? '\u00A0' : char;
}

/**
 * Optimized Solari split-flap Tile
 * Two halves: top drops, bottom rises
 * No forced reflows, minimal DOM updates
 */
export class Tile {
  constructor(row, col) {
    this.row = row;
    this.col = col;
    this.tileId = row * 1000 + col;
    this.currentChar = ' ';
    this.isAnimating = false;
    
    // Small variance for mechanical feel
    this.motorStrength = 0.97 + Math.random() * 0.06;
    this.settleBias = 0.95 + Math.random() * 0.10;
    this.syncOffset = Math.floor(Math.random() * 6);

    this.el = document.createElement('div');
    this.el.className = 'tile';

    // Build DOM structure once
    this._buildDOM();
  }

  _buildDOM() {
    // Top panel (static + flap)
    this.topPanel = document.createElement('div');
    this.topPanel.className = 'tile-panel tile-panel-top';
    
    this.topStatic = this._createFace('tile-face tile-face-top tile-top-static');
    this.topFlap = this._createFace('tile-face tile-face-top tile-top-flap');
    
    this.topPanel.appendChild(this.topStatic.el);
    this.topPanel.appendChild(this.topFlap.el);

    // Bottom panel (static + flap)
    this.bottomPanel = document.createElement('div');
    this.bottomPanel.className = 'tile-panel tile-panel-bottom';
    
    this.bottomStatic = this._createFace('tile-face tile-face-bottom tile-bottom-static');
    this.bottomFlap = this._createFace('tile-face tile-face-bottom tile-bottom-flap');
    
    this.bottomPanel.appendChild(this.bottomStatic.el);
    this.bottomPanel.appendChild(this.bottomFlap.el);

    this.el.appendChild(this.topPanel);
    this.el.appendChild(this.bottomPanel);
  }

  _createFace(className) {
    const el = document.createElement('div');
    el.className = className;
    const span = document.createElement('span');
    el.appendChild(span);
    return { el, span };
  }

  setChar(char) {
    this.currentChar = char;
    const value = displayChar(char);
    this.topStatic.span.textContent = value;
    this.bottomStatic.span.textContent = value;
    this._resetFlaps();
  }

  static nextDrumChar(char) {
    const idx = DRUM_INDEX.get(char) ?? 0;
    return DRUM_ORDER[(idx + 1) % DRUM_ORDER.length];
  }

  /**
   * Optimized two-phase animation
   * Phase 1: Top flap drops (0 -> -90deg)
   * Phase 2: Bottom flap rises (90 -> 0deg)
   * No forced reflows - uses rAF batching
   */
  async animateStep(currentChar, nextChar, durations) {
    return new Promise((resolve) => {
      this.isAnimating = true;
      
      // Prepare both phases at once
      this._preparePhase1(currentChar, nextChar);
      
      // Phase 1: Top flap drop
      requestAnimationFrame(() => {
        this._startTopAnimation(durations.top);
        
        setTimeout(() => {
          // Phase 2: Bottom flap rise
          this._preparePhase2();
          requestAnimationFrame(() => {
            this._startBottomAnimation(durations.bottom);
            
            setTimeout(() => {
              this._completeStep(nextChar);
              resolve();
            }, durations.bottom);
          });
        }, durations.top);
      });
    });
  }

  _preparePhase1(currentChar, nextChar) {
    // Show incoming char on top static, current on bottom static
    this.topStatic.span.textContent = displayChar(nextChar);
    this.bottomStatic.span.textContent = displayChar(currentChar);
    
    // Flaps show transition
    this.topFlap.span.textContent = displayChar(currentChar);
    this.bottomFlap.span.textContent = displayChar(nextChar);
    
    // Reset transforms
    this.topFlap.el.style.transform = 'rotateX(0deg)';
    this.bottomFlap.el.style.transform = 'rotateX(90deg)';
    this.bottomFlap.el.classList.remove('is-active');
    this.topFlap.el.classList.add('is-active');
  }

  _startTopAnimation(duration) {
    // Use CSS transition - GPU accelerated
    this.topFlap.el.style.transition = `transform ${duration}ms cubic-bezier(0.55, 0.04, 0.78, 0.19)`;
    this.topFlap.el.style.transform = 'rotateX(-90deg)';
  }

  _preparePhase2() {
    this.topFlap.el.classList.remove('is-active');
    this.bottomFlap.el.classList.add('is-active');
  }

  _startBottomAnimation(duration) {
    this.bottomFlap.el.style.transition = `transform ${duration}ms cubic-bezier(0.22, 0.61, 0.36, 1)`;
    this.bottomFlap.el.style.transform = 'rotateX(0deg)';
  }

  _completeStep(nextChar) {
    this.currentChar = nextChar;
    const value = displayChar(nextChar);
    this.topStatic.span.textContent = value;
    this.bottomStatic.span.textContent = value;
    this._resetFlaps();
  }

  _resetFlaps() {
    this.topFlap.el.classList.remove('is-active');
    this.bottomFlap.el.classList.remove('is-active');
    
    // Clear transitions
    this.topFlap.el.style.transition = '';
    this.bottomFlap.el.style.transition = '';
    
    // Reset positions
    this.topFlap.el.style.transform = 'rotateX(0deg)';
    this.bottomFlap.el.style.transform = 'rotateX(90deg)';
    
    this.isAnimating = false;
  }

  cancelAnimation() {
    this._resetFlaps();
  }

  /**
   * Board.js compatibility methods
   * These provide the imperative API Board.js expects
   */
  beginTopDrop(currentChar, nextChar, duration) {
    this.isAnimating = true;
    
    // Show incoming char on top static, current on bottom static
    this.topStatic.span.textContent = displayChar(nextChar);
    this.bottomStatic.span.textContent = displayChar(currentChar);
    
    // Flaps show transition
    this.topFlap.span.textContent = displayChar(currentChar);
    this.bottomFlap.span.textContent = displayChar(nextChar);
    
    // Reset transforms first (no transition)
    this.topFlap.el.style.transition = 'none';
    this.bottomFlap.el.style.transition = 'none';
    this.topFlap.el.style.transform = 'rotateX(0deg)';
    this.bottomFlap.el.style.transform = 'rotateX(90deg)';
    this.bottomFlap.el.classList.remove('is-active');
    this.topFlap.el.classList.add('is-active');
    
    // Force reflow to apply reset immediately
    this.topFlap.el.offsetHeight;
    
    // Start animation immediately (no rAF delay)
    this.topFlap.el.style.transition = `transform ${duration}ms cubic-bezier(0.55, 0.04, 0.78, 0.19)`;
    this.topFlap.el.style.transform = 'rotateX(-90deg)';
  }

  beginBottomRise(duration) {
    this.topFlap.el.classList.remove('is-active');
    this.bottomFlap.el.classList.add('is-active');
    
    // Reset bottom flap position (no transition)
    this.bottomFlap.el.style.transition = 'none';
    this.bottomFlap.el.style.transform = 'rotateX(90deg)';
    
    // Force reflow
    this.bottomFlap.el.offsetHeight;
    
    // Start animation immediately
    this.bottomFlap.el.style.transition = `transform ${duration}ms cubic-bezier(0.22, 0.61, 0.36, 1)`;
    this.bottomFlap.el.style.transform = 'rotateX(0deg)';
  }

  commitStep(nextChar) {
    this.currentChar = nextChar;
    const value = displayChar(nextChar);
    this.topStatic.span.textContent = value;
    this.bottomStatic.span.textContent = value;
  }

  cancelActiveStep() {
    this._resetFlaps();
  }

  dispose() {
    this.cancelAnimation();
  }
}
