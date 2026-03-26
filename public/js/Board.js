import { Tile } from './Tile.js';

export class Board {
  constructor(containerEl, soundEngine, config) {
    this.cols = config.grid.cols;
    this.rows = config.grid.rows;
    this.soundEngine = soundEngine;
    this.config = config;
    this.isTransitioning = false;
    this.tiles = [];
    this.currentGrid = [];

    // Build board DOM
    this.boardEl = document.createElement('div');
    this.boardEl.className = 'board';
    this.boardEl.style.setProperty('--grid-cols', this.cols);
    this.boardEl.style.setProperty('--grid-rows', this.rows);

    // Tile grid
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
  }

  /**
   * Display a message on the board. Each tile flips through the drum
   * sequentially to reach its target character.
   * Returns a promise that resolves when all tiles finish.
   */
  displayMessage(lines) {
    if (this.isTransitioning) return Promise.resolve();
    this.isTransitioning = true;

    const newGrid = this._formatToGrid(lines);
    const flipPromises = [];

    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const newChar = newGrid[r][c];
        const oldChar = this.currentGrid[r][c];

        if (newChar !== oldChar) {
          const delay = (r * this.cols + c) * this.config.timing.staggerDelay;
          const flipTime = this.config.timing.flipTimePerChar;

          flipPromises.push(
            this.tiles[r][c].flipTo(newChar, delay, flipTime)
          );
        }
      }
    }

    this.currentGrid = newGrid;

    // Play the full transition sound once per message change
    if (flipPromises.length > 0) {
      this.soundEngine?.playTransition();
    }

    if (flipPromises.length === 0) {
      this.isTransitioning = false;
      return Promise.resolve();
    }

    return Promise.all(flipPromises).then(() => {
      this.isTransitioning = false;
    });
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
