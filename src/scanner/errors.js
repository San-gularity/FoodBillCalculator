/** Errors the scanner can raise. `message` is always safe to show to a user. */
export class ScannerError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'ScannerError';
    this.code = code;
    this.cause = cause;
  }
}

export const SCANNER_ERRORS = {
  'unsupported-file': 'That file isn’t an image. Please choose a photo of the receipt.',
  'file-too-large': 'That image is too large. Try a photo under 12 MB.',
  'image-decode-failed': 'We couldn’t open that image. Try taking the photo again.',
  'ocr-unavailable': 'Receipt scanning needs an internet connection the first time. You can still type the receipt in.',
  'ocr-failed': 'We couldn’t read that receipt. Try a brighter, straighter photo — or enter the items yourself.',
  'ocr-empty': 'We couldn’t find any text in that image. Make sure the whole receipt is in frame.',
  'ai-no-key': 'No AI key is set up yet. Add one under Receipt scanning, or use the on-device reader.',
  'ai-key-invalid': 'That Gemini API key was rejected. Check it under Receipt scanning.',
  'ai-rate-limited': 'The AI reader is over its free quota right now. We’ll use the on-device reader instead.',
  'ai-busy': 'Google’s models are busy right now. We’ll use the on-device reader instead.',
  'ai-unavailable': 'We couldn’t reach the AI reader. We’ll use the on-device reader instead.',
  'ai-failed': 'The AI reader couldn’t make sense of that photo.',
  cancelled: 'Scan cancelled.',
};

export function scannerError(code, cause) {
  return new ScannerError(code, SCANNER_ERRORS[code] || 'Something went wrong while reading the receipt.', cause);
}
