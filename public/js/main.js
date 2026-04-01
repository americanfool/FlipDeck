import { Board } from './Board.js';

document.addEventListener('DOMContentLoaded', async () => {
  const container = document.getElementById('board-container');

  // Fetch config from server
  let config;
  let configFetchFailed = false;
  try {
    const res = await fetch('/api/config');
    config = await res.json();
  } catch (e) {
    configFetchFailed = true;
    config = {
      grid: { tileHeight: 72 },
      timing: {
        staggerDelay: 15,
        idleAfterAnimationMs: 500,
        rowBankSize: 4,
        rowBankDelay: 28,
        rowBankSkew: 4,
        colBankSkew: 1
      },
      sound: { enabled: true, volume: 0.6 },
      physics: {
        baseFlipTime: 45,
        motorStartDelay: 26,
        settleTime: 22,
        motorVariance: 15
      }
    };
  }

  config.timing = {
    staggerDelay: 15,
    idleAfterAnimationMs: 500,
    rowBankSize: 4,
    rowBankDelay: 28,
    rowBankSkew: 4,
    colBankSkew: 1,
    ...config.timing
  };

  config.physics = {
    baseFlipTime: 45,
    motorStartDelay: 26,
    settleTime: 22,
    motorVariance: 15,
    ...config.physics
  };

  const GAP = 4;
  const targetSize = config.grid.tileHeight || 72;

  function getViewportSize() {
    const visualViewport = window.visualViewport;
    return {
      width: Math.floor(visualViewport?.width || window.innerWidth),
      height: Math.floor(visualViewport?.height || window.innerHeight)
    };
  }

  // Calculate grid cols/rows to fill the entire viewport
  function calcGrid() {
    const { width: vw, height: vh } = getViewportSize();

    // How many cols/rows fit at the target tile size
    const cols = Math.max(1, Math.floor((vw + GAP) / (targetSize + GAP)));
    const rows = Math.max(1, Math.floor((vh + GAP) / (targetSize + GAP)));

    // Compute exact tile size so tiles fill the viewport edge-to-edge
    const tileW = (vw - (cols - 1) * GAP) / cols;
    const tileH = (vh - (rows - 1) * GAP) / rows;
    const tileSize = Math.min(tileW, tileH);

    return {
      cols,
      rows,
      tileSize: Number.isFinite(tileSize) ? Math.max(tileSize, 12) : 12,
    };
  }

  let gridInfo = calcGrid();
  config.grid.cols = gridInfo.cols;
  config.grid.rows = gridInfo.rows;

  let sharedAudioEngine = null;
  let board = new Board(container, config, sharedAudioEngine);
  sharedAudioEngine = board.audioEngine;
  window.board = board; // Expose for profiler access
  let lastMessageData = null;
  let resizeTimer = null;
  let isOffline = false;
  let showStats = false;

  function ensureStatsOverlay() {
    let stats = document.getElementById('stats-overlay');
    if (stats) return stats;

    stats = document.createElement('div');
    stats.id = 'stats-overlay';
    stats.style.cssText = `
      position: fixed;
      top: 12px;
      right: 12px;
      min-width: 88px;
      padding: 8px 10px;
      background: rgba(10, 10, 10, 0.82);
      color: #f0f0e8;
      font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.04em;
      line-height: 1.35;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 4px;
      pointer-events: none;
      z-index: 200;
      display: none;
    `;
    document.body.appendChild(stats);
    return stats;
  }

  function setStatsVisibility(visible) {
    showStats = visible;
    const stats = ensureStatsOverlay();
    stats.style.display = visible ? 'block' : 'none';
  }

  function startFpsCounter() {
    const stats = ensureStatsOverlay();
    let frames = 0;
    let lastSampleAt = performance.now();
    let lastFrameAt = performance.now();
    let fps = 60;
    let frameMs = 16.7;

    const update = (now) => {
      frames++;
      frameMs = now - lastFrameAt;
      lastFrameAt = now;

      const sampleDuration = now - lastSampleAt;
      if (sampleDuration >= 500) {
        fps = Math.round((frames * 1000) / sampleDuration);
        const quality = board?.performance?.quality || 'full';
        const fpsColor = fps >= 58 ? '#9ef0a6' : fps >= 45 ? '#f0d78a' : '#ff8d8d';
        stats.innerHTML = [
          `<div style="color:${fpsColor}">FPS ${String(fps).padStart(2, ' ')}</div>`,
          `<div>MS ${frameMs.toFixed(1)}</div>`,
          `<div>Q ${quality.toUpperCase()}</div>`
        ].join('');

        frames = 0;
        lastSampleAt = now;
      }

      requestAnimationFrame(update);
    };

    requestAnimationFrame(update);
  }

  function applySize(g) {
    board.boardEl.style.setProperty('--tile-size', `${g.tileSize}px`);
    board.boardEl.style.setProperty('--tile-gap', `${GAP}px`);
  }
  applySize(gridInfo);
  startFpsCounter();
  setStatsVisibility(false);

  if (configFetchFailed) {
    showOfflineMessage();
  }

  function rebuildBoard(g) {
    board.dispose();
    container.innerHTML = '';
    config.grid.cols = g.cols;
    config.grid.rows = g.rows;
    board = new Board(container, config, sharedAudioEngine);
    sharedAudioEngine = board.audioEngine;
    applySize(g);

    if (audioInitPromise) {
      audioInitPromise = board.initAudio();
    }

    if (isOffline) {
      board.setLinesImmediate(['FLIPDECK', 'SERVER OFFLINE']);
    } else if (lastMessageData) {
      const lastLines = resolveLines(lastMessageData);
      if (lastLines) {
        board.setLinesImmediate(lastLines);
      }
    }
  }

  function showOfflineMessage() {
    isOffline = true;
    board.setLinesImmediate(['FLIPDECK', 'SERVER OFFLINE']);
  }

  // Resize: recalc grid, rebuild only after the resize settles.
  const scheduleResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const g = calcGrid();
      if (g.cols !== board.cols || g.rows !== board.rows) {
        rebuildBoard(g);
      } else {
        applySize(g);
      }
    }, 120);
  };

  window.addEventListener('resize', scheduleResize);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', scheduleResize);
  }

  // Audio init on first real user gesture only
  let audioInitPromise = null;
  const initAudio = () => {
    if (audioInitPromise) return audioInitPromise;
    audioInitPromise = (async () => {
      await board.initAudio();
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

  function notifyTransitionComplete(id, sessionId) {
    fetch('/api/transition-complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, sessionId })
    }).catch(() => {});
  }

  function resolveLines(data) {
    if (typeof data.fill === 'string') {
      const fillChar = String(data.fill).charAt(0).toUpperCase() || ' ';
      return Array(board.rows).fill(fillChar.repeat(board.cols));
    }

    if (typeof data.text === 'string') return wrapText(data.text, board.cols, board.rows);
    if (Object.prototype.hasOwnProperty.call(data, 'lines') && Array.isArray(data.lines)) {
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
    lastMessageData = data;
    const lines = resolveLines(data);
    if (!lines) return;

    const isImmediate = data.immediate === true || data.force === true;

    if (isImmediate) {
      pendingMessage = null;
      if (board._abortTransition) {
        board._abortTransition();
      }
    }

    if (board.isTransitioning && !isImmediate) {
      // Queue it — will display when current transition finishes
      pendingMessage = data;
      return;
    }

    board.displayMessage(lines).then(() => {
      if (typeof data.id === 'number' && typeof data.sessionId === 'string') {
        notifyTransitionComplete(data.id, data.sessionId);
      }

      if (pendingMessage) {
        const next = pendingMessage;
        pendingMessage = null;
        processMessage(next);
      }
    });
  }

  // SSE connection
  const events = new EventSource('/api/events');
  events.addEventListener('message', (e) => {
    try {
      isOffline = false;
      processMessage(JSON.parse(e.data));
    } catch (err) {
      console.warn('SSE parse error:', err);
    }
  });
  events.onerror = () => {
    console.info('SSE reconnecting');
    showOfflineMessage();
  };

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
        if (board.audioEngine) {
          const muted = board.audioEngine.toggleMute();
          showToast(muted ? 'SOUND OFF' : 'SOUND ON');
        }
        break;
      case 'p':
        setStatsVisibility(!showStats);
        showToast(showStats ? 'STATS ON' : 'STATS OFF');
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
