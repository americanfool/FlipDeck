# FlipDeck

A fullscreen split-flap display for any screen. Realistic drum-based character animation, auto-sizing grid, preset message rotation, and a simple HTTP API for pushing messages in real time.

Turn any TV, monitor, or projector into a retro split-flap board.

## Quick Start

```bash
git clone https://github.com/blacknight2u/FlipDeck.git
cd FlipDeck
cp config.sample.json config.json
node server.js
```

Open **http://localhost:3000** in a browser. Click anywhere to enable sound.

## Features

- Realistic split-flap animation — characters cycle through a fixed drum order, just like mechanical hardware
- Auto-sizing grid fills any screen edge-to-edge
- Preset message rotation with shuffle mode
- Simple HTTP API for pushing messages from any system
- Server-Sent Events for real-time updates
- Embedded audio with no external dependencies
- Works in background tabs (Web Worker-driven timing)
- Zero dependencies — pure Node.js + vanilla JS

## Configuration

Copy `config.sample.json` to `config.json` and edit:

```json
{
  "grid": { "tileHeight": 80 },
  "timing": {
    "flipTimePerChar": 40,
    "staggerDelay": 15,
    "pauseBetweenMessages": 10000
  },
  "sound": {
    "enabled": true,
    "volume": 0.6
  },
  "shuffle": true,
  "messages": [
    { "text": "YOUR MESSAGE HERE", "duration": 8000 }
  ],
  "port": 3000
}
```

| Field | Description |
|-------|-------------|
| `grid.tileHeight` | Target tile size in pixels. Larger = fewer, bigger tiles. Smaller = more tiles. Grid auto-calculates to fill the screen. |
| `timing.flipTimePerChar` | Milliseconds per drum step. `40` is fast and snappy, `80`+ lets you see each character flip. |
| `timing.staggerDelay` | Milliseconds between each tile starting its flip. Creates the wave effect across the board. |
| `timing.pauseBetweenMessages` | Default hold time between messages in milliseconds. |
| `sound.enabled` | Enable or disable flip sound on startup. |
| `sound.volume` | Volume from `0.0` (silent) to `1.0` (full). |
| `shuffle` | `true` to randomize message order, `false` for sequential. |
| `messages` | Array of preset messages. Each can have `"text"` (auto-wrapped) or `"lines"` (explicit rows). Optional `"duration"` overrides `pauseBetweenMessages`. |
| `port` | HTTP server port. |

Restart the server after editing config.

## API

### Send a message

```bash
# Auto-wrap text to fit the screen
curl -X POST http://localhost:3000/api/message \
  -H "Content-Type: application/json" \
  -d '{"text": "HELLO WORLD"}'

# Explicit lines (centered on each row)
curl -X POST http://localhost:3000/api/message \
  -H "Content-Type: application/json" \
  -d '{"lines": ["", "LINE ONE", "LINE TWO", "", ""]}'
```

API messages interrupt the preset rotation. Rotation resumes after `pauseBetweenMessages`.

### Get current message

```bash
curl http://localhost:3000/api/message
```

### Get config

```bash
curl http://localhost:3000/api/config
```

### Real-time event stream (SSE)

```bash
curl http://localhost:3000/api/events
```

Connect with `EventSource` in the browser for live updates.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| **F** | Toggle fullscreen |
| **M** | Toggle mute |

## Casting to a TV

The easiest way to display FlipDeck on a TV:

1. Open `http://localhost:3000` in Chrome
2. Three-dot menu > Save and share > Cast > select your Chromecast
3. Mute your local PC — the Chromecast receives audio from the tab independently

Alternatively, if your TV has a browser, find your PC's local IP (`ipconfig` or `ifconfig`) and open `http://YOUR_IP:3000` directly on the TV.

## How It Works

Each tile has a character drum in fixed order:

```
 ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,:!?/-'
```

To change from one character to another, the drum advances forward through every intermediate position — just like a real split-flap display. Going from A to D flips through B and C. The further apart the characters, the longer the animation takes.

## Project Structure

```
FlipDeck/
  server.js              Node.js HTTP server (zero dependencies)
  config.json            Your configuration (gitignored)
  config.sample.json     Example configuration
  public/
    index.html           Minimal fullscreen page
    css/
      reset.css          CSS reset
      board.css          Grid layout and sizing
      tile.css           Tile 3D styling
    js/
      main.js            App entry point, SSE client, keyboard shortcuts
      Board.js           Grid orchestration and message formatting
      Tile.js            Drum model and flip animation
      SoundEngine.js     Web Audio playback
      flapAudio.js       Embedded audio data
      timer-worker.js    Web Worker for background-safe timing
```

## License

MIT
