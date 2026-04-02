const http = require('http');
const fs = require('fs');
const path = require('path');

// Load config
const configPath = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const PORT = config.port || 3000;
const IDLE_AFTER_ANIMATION_MS = Math.max(0, config.timing?.idleAfterAnimationMs || 500);
const SERVER_SESSION_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// State
let currentMessage = { text: '' };
const sseClients = new Set();
let rotationTimer = null;
let rotationIndex = 0;
let rotationPaused = false;
let nextMessageId = 1;
let awaitingTransitionId = null;
let awaitingIdleMs = IDLE_AFTER_ANIMATION_MS;

// MIME types
const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function normalizeMessage(body) {
  const hasText = typeof body.text === 'string';
  const hasLines = Array.isArray(body.lines);
  const hasFill = typeof body.fill === 'string';

  if (!hasText && !hasLines && !hasFill) {
    return null;
  }

  const message = {
    text: hasText ? body.text : null,
    lines: hasLines ? body.lines : null,
    fill: hasFill ? body.fill : null,
  };

  if (body.immediate === true) message.immediate = true;
  if (body.force === true) message.force = true;

  return message;
}

function withMessageId(message) {
  return {
    ...message,
    id: nextMessageId++,
    sessionId: SERVER_SESSION_ID,
  };
}

// Broadcast to all SSE clients
function broadcast(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

// Read request body as JSON
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// Shuffle array in place (Fisher-Yates)
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Preset message rotation
let shuffledOrder = [];

function buildOrder() {
  shuffledOrder = config.messages.map((_, i) => i);
  if (config.shuffle) shuffle(shuffledOrder);
}

function scheduleNextRotation(delay) {
  if (rotationTimer) {
    clearTimeout(rotationTimer);
  }

  rotationTimer = setTimeout(showNext, delay);
}

function showNext() {
  if (rotationPaused) return;

  if (rotationIndex >= shuffledOrder.length) {
    rotationIndex = 0;
    if (config.shuffle) buildOrder();
  }

  const msg = config.messages[shuffledOrder[rotationIndex]];
  currentMessage = withMessageId({
    text: msg.text || '',
    lines: msg.lines || null,
    fill: msg.fill || null,
  });
  broadcast(currentMessage);

  rotationIndex++;

  awaitingTransitionId = currentMessage.id;
  awaitingIdleMs = Math.max(0, msg.duration ?? IDLE_AFTER_ANIMATION_MS);
}

function startRotation() {
  if (!config.messages || config.messages.length === 0) return;
  if (shuffledOrder.length === 0) buildOrder();
  showNext();
}

function pauseRotation() {
  rotationPaused = true;
  awaitingTransitionId = null;
  awaitingIdleMs = IDLE_AFTER_ANIMATION_MS;
  if (rotationTimer) {
    clearTimeout(rotationTimer);
    rotationTimer = null;
  }
}

function resumeRotation() {
  if (!config.messages || config.messages.length === 0) return;
  rotationPaused = false;

  if (currentMessage && typeof currentMessage.id === 'number') {
    awaitingTransitionId = currentMessage.id;
  }

  awaitingIdleMs = IDLE_AFTER_ANIMATION_MS;
}

// HTTP server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // CORS
  if (pathname.startsWith('/api/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
  }

  // GET /api/config
  if (pathname === '/api/config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      grid: config.grid,
      timing: config.timing,
      physics: config.physics,
      sound: config.sound,
    }));
    return;
  }

  // GET /api/message
  if (pathname === '/api/message' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(currentMessage));
    return;
  }

  if (pathname === '/favicon.ico' && req.method === 'GET') {
    res.writeHead(204);
    res.end();
    return;
  }

  // POST /api/message
  if (pathname === '/api/message' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const normalized = normalizeMessage(body);
      if (!normalized) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Provide "text", "lines", or "fill"' }));
        return;
      }

      currentMessage = withMessageId(normalized);
      broadcast(currentMessage);
      awaitingIdleMs = Math.max(0, body.duration ?? IDLE_AFTER_ANIMATION_MS);

      pauseRotation();
      resumeRotation();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...currentMessage }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
    return;
  }

  if (pathname === '/api/transition-complete' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      if (
        IDLE_AFTER_ANIMATION_MS > 0 &&
        body.sessionId === SERVER_SESSION_ID &&
        body.id === awaitingTransitionId
      ) {
        awaitingTransitionId = null;
        scheduleNextRotation(awaitingIdleMs);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
    return;
  }

  // SSE /api/events
  if (pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('\n');
    res.write(`data: ${JSON.stringify(currentMessage)}\n\n`);
    sseClients.add(res);
    const heartbeat = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 15000);
    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
    return;
  }

  // Static files
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, 'public', filePath);
  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`FlipDeck running at http://localhost:${PORT}`);
  startRotation();
});
