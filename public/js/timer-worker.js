// Web Worker for reliable timing — not throttled in background tabs
const timers = new Map();

self.onmessage = (e) => {
  const { action, id, delay } = e.data;
  if (action === 'set') {
    const t = setTimeout(() => {
      timers.delete(id);
      self.postMessage({ id });
    }, delay);
    timers.set(id, t);
  } else if (action === 'clear') {
    if (timers.has(id)) {
      clearTimeout(timers.get(id));
      timers.delete(id);
    }
  }
};
