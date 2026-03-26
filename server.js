const http = require('http');
const fs = require('fs');
const path = require('path');

// Load config
const configPath = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const PORT = config.port || 3000;

// State
let currentMessage = { text: '' };
const sseClients = new Set();
let rotationTimer = null;
let rotationIndex = 0;
let rotationPaused = false;

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

// Preset message rotation
function startRotation() {
  if (!config.messages || config.messages.length === 0) return;

  function showNext() {
    if (rotationPaused) return;

    const msg = config.messages[rotationIndex % config.messages.length];
    // Pass through as-is — client handles wrapping
    currentMessage = { text: msg.text || '', lines: msg.lines || null };
    broadcast(currentMessage);

    const duration = msg.duration || config.timing.pauseBetweenMessages || 8000;
    rotationIndex++;
    rotationTimer = setTimeout(showNext, duration);
  }

  showNext();
}

function pauseRotation() {
  rotationPaused = true;
  if (rotationTimer) {
    clearTimeout(rotationTimer);
    rotationTimer = null;
  }
}

function resumeRotation() {
  if (!config.messages || config.messages.length === 0) return;
  rotationPaused = false;
  const delay = config.timing.pauseBetweenMessages || 8000;
  rotationTimer = setTimeout(() => startRotation(), delay);
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

  // POST /api/message
  if (pathname === '/api/message' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      if (!body.text && !body.lines) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Provide "text" string or "lines" array' }));
        return;
      }
      currentMessage = { text: body.text || null, lines: body.lines || null };
      broadcast(currentMessage);

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
    req.on('close', () => { sseClients.delete(res); });
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
