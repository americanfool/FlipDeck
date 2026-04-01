export class PhysicsEngine {
  constructor(config = {}) {
    this.config = {
      baseFlipTime: config.baseFlipTime ?? 45,
      motorStartDelay: config.motorStartDelay ?? 26,
      settleTime: config.settleTime ?? 22
    };
  }

  calculateFlip(fromChar, toChar, tileVariance = {}) {
    const distance = this._getDrumDistance(fromChar, toChar);
    if (distance === 0) {
      return {
        distance: 0,
        motorDelay: 0,
        perCharTime: 0,
        settleDuration: 0
      };
    }

    return {
      distance,
      motorDelay: this._applyVariance(
        this.config.motorStartDelay,
        tileVariance.motorVariance ?? 8
      ),
      perCharTime: this._calculatePerCharTime(distance),
      settleDuration: Math.max(8, Math.min(this.config.settleTime, 28))
    };
  }

  _getDrumDistance(fromChar, toChar) {
    const DRUM_ORDER = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,:!?/-\'';
    const fromIdx = DRUM_ORDER.indexOf(fromChar);
    const toIdx = DRUM_ORDER.indexOf(toChar);

    if (fromIdx === -1 || toIdx === -1) return 0;

    let distance = toIdx - fromIdx;
    if (distance < 0) {
      distance += DRUM_ORDER.length;
    }

    return distance;
  }

  _calculatePerCharTime(distance) {
    const base = this.config.baseFlipTime;

    if (distance <= 2) return base + 16;
    if (distance <= 6) return base + 8;
    if (distance <= 12) return base + 2;
    if (distance <= 20) return Math.max(34, base - 3);
    return Math.max(30, base - 6);
  }

  _applyVariance(base, variance) {
    const randomVariance = (Math.random() - 0.5) * 2 * variance;
    return Math.max(0, Math.round(base + randomVariance));
  }
}
