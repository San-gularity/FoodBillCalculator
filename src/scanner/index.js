// Receipt scanning pipeline:
//
//   image/text -> provider.recognize() -> parseReceipt() -> review draft -> bill items
//
// Only this module knows which OCR provider exists. Everything downstream works
// on the normalized draft, so replacing the provider is a one-line change.

import { parseReceipt } from './parse-receipt.js';
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

/** Same pipeline for text someone pastes in — no camera, no network. */
export async function scanReceiptText(text) {
  const result = await textProvider.recognize(text);
  if (!result.lines.length) throw scannerError('ocr-empty');
  return parseReceipt(result.lines, { provider: 'text', capturedAt: new Date().toISOString() });
}

export { ScannerError };
export { parseReceipt };
