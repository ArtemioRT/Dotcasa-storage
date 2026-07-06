// ============================================================================
// CONCURRENCIA — pool pLimit + calibración de recursos (4 vCPU / 4 GiB RAM)
// ============================================================================
import sharp from 'sharp';

export function pLimit(concurrency) {
  const queue = [];
  let active = 0;
  const next = () => {
    if (active >= concurrency || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(
      v => { active--; resolve(v); next(); },
      e => { active--; reject(e);  next(); }
    );
  };
  const limit = fn => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
  limit.concurrency = concurrency;
  return limit;
}

// Calibración global de sharp (se aplica una sola vez al importar este módulo)
export const IMAGE_CONCURRENCY = 8;
sharp.cache({ memory: 512, items: 300 });
sharp.concurrency(2);

export const imageLimit = pLimit(IMAGE_CONCURRENCY);
export const pdfLimit   = pLimit(6);
