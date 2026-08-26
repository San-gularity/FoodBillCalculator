// Camera/gallery image -> something OCR can actually read.
// Big phone photos are slow and noisy for OCR, so we downscale, desaturate and
// stretch contrast before handing the pixels over.

import { scannerError } from './errors.js';

const MAX_BYTES = 12 * 1024 * 1024;
const MAX_DIMENSION = 1600;
const THUMB_DIMENSION = 360;

export function validateImageFile(file) {
  if (!file) throw scannerError('unsupported-file');
  if (file.type && !file.type.startsWith('image/')) throw scannerError('unsupported-file');
  if (file.size > MAX_BYTES) throw scannerError('file-too-large');
  return true;
}

async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      /* fall through to <img> */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(scannerError('image-decode-failed'));
      img.src = url;
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}

function draw(source, maxDimension) {
  const width = source.width || source.naturalWidth;
  const height = source.height || source.naturalHeight;
  if (!width || !height) throw scannerError('image-decode-failed');
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return { canvas, ctx };
}

/** Grayscale + contrast stretch. Text gets darker, paper gets whiter. */
function enhance(canvas, ctx) {
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  let min = 255;
  let max = 0;
  const gray = new Uint8ClampedArray(data.length / 4);

  for (let i = 0, g = 0; i < data.length; i += 4, g++) {
    const value = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
    gray[g] = value;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const range = Math.max(1, max - min);

  for (let i = 0, g = 0; i < data.length; i += 4, g++) {
    let value = ((gray[g] - min) * 255) / range;
    value = value < 128 ? value * 0.8 : 255 - (255 - value) * 0.8; // gentle S-curve
    data[i] = data[i + 1] = data[i + 2] = value;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * @returns {Promise<{ ocrSource: HTMLCanvasElement, thumbnail: string, width: number, height: number }>}
 */
export async function prepareImage(file, { maxDimension = MAX_DIMENSION } = {}) {
  validateImageFile(file);
  const source = await decode(file);

  const { canvas, ctx } = draw(source, maxDimension);
  enhance(canvas, ctx);

  const thumb = draw(source, THUMB_DIMENSION);
  const thumbnail = thumb.canvas.toDataURL('image/jpeg', 0.7);

  if (typeof source.close === 'function') source.close();
  return { ocrSource: canvas, thumbnail, width: canvas.width, height: canvas.height };
}
