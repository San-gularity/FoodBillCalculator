// Receipt scanning pipeline:
//
//   image/text -> provider.recognize() -> parseReceipt() -> review draft -> bill items
//
// Only this module knows which OCR provider exists. Everything downstream works
// on the normalized draft, so replacing the provider is a one-line change.

import { parseReceipt } from './parse-receipt.js';
import { mergeReceiptDrafts } from './merge-drafts.js';
import { prepareImage } from './image.js';
import { scannerError, ScannerError } from './errors.js';
import { tesseractProvider } from './providers/tesseract.js';
import { textProvider } from './providers/text.js';
import { geminiProvider } from './providers/gemini.js';

const providers = new Map();

export function registerProvider(provider) {
  providers.set(provider.id, provider);
}

registerProvider(geminiProvider);
registerProvider(tesseractProvider);
registerProvider(textProvider);

export function getProvider(id) {
  return providers.get(id) || null;
}

export function listProviders() {
  return [...providers.values()].filter((p) => p.isAvailable());
}

/**
 * Which reader to use for an image: the AI one when it is set up and switched
 * on (much better at ignoring receipt numbers and odd layouts), otherwise the
 * on-device reader.
 */
export function chooseImageProvider({ preferAi = true } = {}) {
  if (preferAi && geminiProvider.isAvailable()) return geminiProvider;
  return tesseractProvider;
}

/**
 * Scan a receipt image.
 * @param {File|Blob} file
 * @param {{ onProgress?: Function, providerId?: string }} options
 * @returns {Promise<object>} review draft (see parse-receipt.js)
 */
export async function scanReceiptImage(file, { onProgress, providerId, preferAi = true, onNotice } = {}) {
  onProgress?.({ stage: 'preparing', progress: 0 });
  const { ocrSource, thumbnail } = await prepareImage(file);

  let provider = providerId ? getProvider(providerId) : chooseImageProvider({ preferAi });
  if (!provider) throw scannerError('ocr-unavailable');

  let draft = null;
  if (provider.structured) {
    try {
      draft = await provider.extractReceipt(ocrSource, { onProgress, onNotice });
      if (!draft?.items?.length) {
        // A reply we couldn't turn into items is no better than no reply.
        console.warn('[scanner] the AI reader returned no usable items; falling back to on-device OCR');
        draft = null;
        onNotice?.('The AI reader didn’t find any items — reading it on your device instead.');
        provider = tesseractProvider;
      }
    } catch (error) {
      if (error?.code === 'cancelled' || error?.code === 'ai-key-invalid') throw error;
      // The AI reader is a nicety, not a dependency: fall back to on-device OCR.
      onNotice?.(error?.message || 'Falling back to the on-device reader.');
      provider = tesseractProvider;
    }
  }

  if (!draft) {
    const result = await provider.recognize(ocrSource, { onProgress });
    onProgress?.({ stage: 'parsing', progress: 1 });
    draft = parseReceipt(result.lines, { provider: provider.id, capturedAt: new Date().toISOString() });
    draft.meanConfidence = result.meanConfidence;
  }

  draft.thumbnail = thumbnail;
  return draft;
}

/**
 * Scan a receipt that spans several photos. Each image goes through the same
 * pipeline, then the parts are merged into one draft — overlapping lines
 * counted once, totals taken from whichever photo shows them.
 *
 * @param {File[]|FileList} files in the order they were taken (top to bottom)
 */
export async function scanReceiptImages(files, options = {}) {
  const list = [...(files || [])];
  if (!list.length) throw scannerError('unsupported-file');
  if (list.length === 1) return scanReceiptImage(list[0], options);

  const { onProgress, onNotice, onPhoto } = options;
  const drafts = [];
  const failures = [];

  for (let index = 0; index < list.length; index++) {
    onPhoto?.({ index, count: list.length });
    try {
      const draft = await scanReceiptImage(list[index], {
        ...options,
        // Keep the per-photo progress bar inside this photo's slice of the bar.
        onProgress: (update) => onProgress?.({ ...update, photoIndex: index, photoCount: list.length }),
      });
      drafts.push(draft);
    } catch (error) {
      failures.push({ index, error });
    }
  }

  if (!drafts.length) throw failures[0]?.error || scannerError('ocr-failed');
  if (failures.length) {
    const which = failures.map((f) => f.index + 1).join(', ');
    onNotice?.(`We couldn’t read photo ${which}. The other ${drafts.length} went through — add anything missing below.`);
  }

  const merged = mergeReceiptDrafts(drafts);
  merged.failedPhotos = failures.length;
  return merged;
}

/** Same pipeline for text someone pastes in — no camera, no network. */
export async function scanReceiptText(text) {
  const result = await textProvider.recognize(text);
  if (!result.lines.length) throw scannerError('ocr-empty');
  return parseReceipt(result.lines, { provider: 'text', capturedAt: new Date().toISOString() });
}

export { ScannerError };
export { parseReceipt };
export { mergeReceiptDrafts };
