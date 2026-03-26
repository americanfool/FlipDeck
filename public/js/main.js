import { Board } from './Board.js';
import { SoundEngine } from './SoundEngine.js';

document.addEventListener('DOMContentLoaded', async () => {
  const container = document.getElementById('board-container');

  // Fetch config from server
  let config;
  try {
    const res = await fetch('/api/config');
    config = await res.json();
  } catch (e) {
    config = {
      grid: { tileHeight: 72 },
      timing: { flipTimePerChar: 40, staggerDelay: 15, pauseBetweenMessages: 8000 },
      sound: { enabled: true, volume: 0.6 }
    };
  }

  const GAP = 4;
  const targetSize = config.grid.tileHeight || 72;

  // Calculate grid cols/rows to fill the entire viewport
  function calcGrid() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // How many cols/rows fit at the target tile size
    const cols = Math.max(1, Math.floor(vw / (targetSize + GAP)));
    const rows = Math.max(1, Math.floor(vh / (targetSize + GAP)));

    // Compute exact tile size so tiles fill the viewport edge-to-edge
    const tileW = (vw - (cols - 1) * GAP) / cols;
    const tileH = (vh - (rows - 1) * GAP) / rows;
    const tileSize = Math.floor(Math.min(tileW, tileH));

    return { cols, rows, tileSize: Math.max(tileSize, 12) };
  }

  let gridInfo = calcGrid();
  config.grid.cols = gridInfo.cols;
  config.grid.rows = gridInfo.rows;

  const sound = new SoundEngine(config.sound?.volume ?? 0.6);
  let board = new Board(container, sound, config);

  function applySize(g) {
    board.boardEl.style.setProperty('--tile-size', `${g.tileSize}px`);
    board.boardEl.style.setProperty('--tile-gap', `${GAP}px`);
  }
  applySize(gridInfo);

  // Resize: recalc grid, rebuild if dimensions changed
  window.addEventListener('resize', () => {
    const g = calcGrid();
    if (g.cols !== board.cols || g.rows !== board.rows) {
      container.innerHTML = '';
      config.grid.cols = g.cols;
      config.grid.rows = g.rows;
      board = new Board(container, sound, config);
      applySize(g);
    } else {
      applySize(g);
    }
  });

  // Audio init on first real user gesture only
  let audioInitPromise = null;
  const initAudio = () => {
    if (audioInitPromise) return audioInitPromise;
    audioInitPromise = (async () => {
      await sound.init();
      sound.resume();
      if (!config.sound?.enabled) {
        sound.muted = true;
      }
    })();
    return audioInitPromise;
  };
  document.addEventListener('click', () => initAudio(), { once: true });
  document.addEventListener('keydown', () => initAudio(), { once: true });

  // Client-side text wrapping (grid is dynamic)
  function wrapText(text, cols, rows) {
    const words = text.toUpperCase().split(/\s+/).filter(Boolean);
    const lines = [];
    let current = '';
    for (const word of words) {
      const tryLine = current ? current + ' ' + word : word;
      if (tryLine.length <= cols) {
        current = tryLine;
      } else {
        if (current) lines.push(current);
        current = word.length > cols ? word.slice(0, cols) : word;
      }
    }
    if (current) lines.push(current);
    const trimmed = lines.slice(0, rows);
    const padTop = Math.floor((rows - trimmed.length) / 2);
    const result = [];
    for (let i = 0; i < rows; i++) {
      result.push(trimmed[i - padTop] || '');
    }
    return result;
  }

  let pendingMessage = null;

  function resolveLines(data) {
    if (data.text) return wrapText(data.text, board.cols, board.rows);
    if (data.lines) {
      const src = data.lines.map(l => (l || '').toUpperCase());
      if (src.length < board.rows) {
        const padTop = Math.floor((board.rows - src.length) / 2);
        const lines = [];
        for (let i = 0; i < board.rows; i++) lines.push(src[i - padTop] || '');
        return lines;
      }
      return src.slice(0, board.rows);
    }
    return null;
  }

  function processMessage(data) {
    const lines = resolveLines(data);
    if (!lines) return;

    if (board.isTransitioning) {
      // Queue it — will display when current transition finishes
      pendingMessage = lines;
      return;
    }

    board.displayMessage(lines).then(() => {
      if (pendingMessage) {
        const next = pendingMessage;
        pendingMessage = null;
        processMessage({ lines: next });
      }
    });
  }

  // SSE connection
  const events = new EventSource('/api/events');
  events.addEventListener('message', (e) => {
    try {
      processMessage(JSON.parse(e.data));
    } catch (err) {
      console.warn('SSE parse error:', err);
    }
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', async (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    switch (e.key.toLowerCase()) {
      case 'f':
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen().catch(() => {});
        break;
      case 'm':
        await initAudio();
        const muted = sound.toggleMute();
        showToast(muted ? 'SOUND OFF' : 'SOUND ON');
        break;
    }
  });

  function showToast(text) {
    let toast = document.getElementById('toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'toast';
      toast.style.cssText = `
        position: fixed; bottom: 20px; right: 20px;
        padding: 8px 16px; background: rgba(240,240,232,0.9);
        color: #111; font-family: 'Helvetica Neue', sans-serif;
        font-size: 14px; font-weight: 600; border-radius: 4px;
        opacity: 0; transition: opacity 0.3s;
        pointer-events: none; z-index: 100;
      `;
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.style.opacity = '1';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 1500);
  }
});
