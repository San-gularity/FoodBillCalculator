/**
 * Runtime configuration for the receipt scanner.
 *
 * You normally don't touch this file: `npm start` serves it straight from .env,
 * so put your key there instead (see .env.example).
 *
 * For static hosting (GitHub Pages etc.) run `npm run config`, which rewrites
 * this file from .env — don't commit the result.
 *
 * You can also paste a key into the app: menu (⋯) → Receipt scanning.
 */
window.__RECEIPT_OCR_CONFIG__ = {
  geminiApiKey: '',
  geminiModel: '',
};
