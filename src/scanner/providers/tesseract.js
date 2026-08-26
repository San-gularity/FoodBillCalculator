// OCR provider: Tesseract.js (WebAssembly, runs entirely in the browser).
//
// It is loaded lazily from a CDN the first time someone scans, so the app keeps
// its zero-build, zero-dependency setup and pays nothing on first paint.
// To swap in a cloud OCR service, write another module with this same shape
// (`id`, `label`, `isAvailable`, `recognize`) and register it in ../index.js.

import { scannerError } from '../errors.js';

const DEFAULT_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

function config() {
  return (typeof window !== 'undefined' && window.__RECEIPT_OCR_CONFIG__) || {};
}

let loader = null;
function loadTesseract() {
  if (typeof window === 'undefined') return Promise.reject(scannerError('ocr-unavailable'));
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (loader) return loader;

  loader = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = config().scriptUrl || DEFAULT_SCRIPT_URL;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onload = () =>
      window.Tesseract ? resolve(window.Tesseract) : reject(scannerError('ocr-unavailable'));
    script.onerror = () => {
      loader = null;
      reject(scannerError('ocr-unavailable'));
    };
    document.head.appendChild(script);
  });
  return loader;
}

/** Tesseract v5 returns blocks; v4 returned lines. Handle both. */
function extractLines(data) {
  const lines = [];
  const push = (line) => {
    const text = String(line?.text || '').trim();
    if (text) lines.push({ text, confidence: Number(line.confidence) || 0 });
  };

  if (Array.isArray(data?.lines) && data.lines.length) {
    data.lines.forEach(push);
    return lines;
  }
  if (Array.isArray(data?.blocks)) {
    for (const block of data.blocks) {
      for (const paragraph of block?.paragraphs || []) {
        for (const line of paragraph?.lines || []) push(line);
      }
    }
    if (lines.length) return lines;
  }
  // Last resort: split the flat text and use the page-level confidence.
  return String(data?.text || '')
    .split(/\r?\n/)
    .map((text) => ({ text: text.trim(), confidence: Number(data?.confidence) || 70 }))
    .filter((line) => line.text);
}

let workerPromise = null;
async function getWorker(onProgress) {
  const Tesseract = await loadTesseract();
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker('eng', 1, {
      logger: (m) => {
        if (m.status === 'recognizing text') onProgress?.({ stage: 'reading', progress: m.progress });
        else if (/loading|initializing|downloading/i.test(m.status)) {
          onProgress?.({ stage: 'loading', progress: m.progress });
        }
      },
      ...(config().workerOptions || {}),
    }).catch((error) => {
      workerPromise = null;
      throw scannerError('ocr-unavailable', error);
    });
  }
  return workerPromise;
}

export const tesseractProvider = {
  id: 'tesseract',
  label: 'On-device OCR',
  requiresNetwork: true, // only for the first load; then it is cached
  isAvailable() {
    return typeof window !== 'undefined' && typeof document !== 'undefined';
  },
  async warmUp(onProgress) {
    await getWorker(onProgress);
  },
  async recognize(source, { onProgress } = {}) {
    const worker = await getWorker(onProgress);
    let result;
    try {
      onProgress?.({ stage: 'reading', progress: 0 });
      result = await worker.recognize(source);
    } catch (error) {
      throw scannerError('ocr-failed', error);
    }
    const lines = extractLines(result?.data);
    if (!lines.length) throw scannerError('ocr-empty');
    return {
      text: result?.data?.text || lines.map((l) => l.text).join('\n'),
      lines,
      meanConfidence: Number(result?.data?.confidence) || null,
    };
  },
  async dispose() {
    if (!workerPromise) return;
    try {
      const worker = await workerPromise;
      await worker.terminate();
    } catch {
      /* nothing useful to do */
    }
    workerPromise = null;
  },
};
