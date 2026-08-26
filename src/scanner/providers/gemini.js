// OCR provider: Google Gemini (Interactions API).
//
// The model reads the photo and returns structured receipt data directly, which
// is far more accurate than character-level OCR on a crumpled receipt — it knows
// that "Order #4471" is not a $44.71 item.
//
// The key comes from .env (served as config.js by `npm start`) or from what the
// user pasted in the app. Everything else about the app is unchanged: this
// provider returns the same review draft as the on-device reader.

import { scannerError } from '../errors.js';
import { createDraftFromStructured } from '../parse-receipt.js';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';

/**
 * Reading a receipt is an easy extraction job, so the newest, most in-demand
 * model buys nothing but queueing. Default to the mature workhorse and walk
 * down a chain of stable multimodal models when one is busy.
 */
export const DEFAULT_MODEL = 'gemini-2.5-flash';
export const MODEL_CHAIN = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
  'gemini-3.7-flash',
];

const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
/**
 * The first model is worth waiting on — demand spikes are usually seconds long.
 * After that we're just probing whether a different model is free, and probing
 * one three times only makes the user wait.
 */
export function attemptsForModel(modelIndex) {
  return modelIndex === 0 ? 3 : 1;
}
const BASE_BACKOFF_MS = 600;
// Someone is standing at a table waiting. Spend at most this long fighting for
// a busy model before handing over to the on-device reader, which always works.
const OVERALL_DEADLINE_MS = 9000;

/** 429/5xx are "come back in a moment"; everything else is a real problem. */
export function isRetryableStatus(status) {
  return RETRY_STATUSES.has(Number(status));
}

/** Whatever the user pinned first, then the rest of the chain as backup. */
export function buildModelChain(configured) {
  const first = String(configured || '').trim();
  const rest = MODEL_CHAIN.filter((model) => model !== first);
  return first ? [first, ...rest] : [...MODEL_CHAIN];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PROMPT = `You are reading a photo of a shop or restaurant receipt.

Reply with JSON only — no prose, no code fences — using exactly these keys:

{
  "merchant": "store name",
  "items": [
    { "name": "item as printed", "quantity": 1, "unit_price": 4.99, "total_price": 4.99, "confidence": 0.97 }
  ],
  "subtotal": 64.62,
  "tax": 1.08,
  "tip": 0,
  "fees": 0,
  "discount": 0,
  "total": 65.70
}

Rules:
- Use those key names exactly. "items", not "line_items"; "name", not "item".
- ALWAYS include "subtotal", "tax" and "total" when the receipt prints them — they are
  what the app checks the items against. Add up multiple tax lines ("Tax", "Tax2 (1.25%)")
  into the single "tax" field.
- Amounts are numbers in the receipt's currency units (14.99, not 1499).
- total_price is the line total for that row; unit_price is the per-unit price if printed.
- Omit a key entirely if the receipt does not print it. Never invent a price.
- A long item name often wraps onto the next line ("... Noodles" / "300g"): that is ONE item.
- If the same name is printed twice but priced once, return it once.

Return ONLY these as items — the things the customer paid for. Never return:
- receipt, order, check, table, invoice, register, authorization or AID numbers
- dates, times, phone numbers, addresses, store or server names
- payment lines (cash, card, VISA, change, tender, auth codes, "Verified on Device")
- loyalty points, survey codes, barcodes or footer messages
- subtotal, tax, tip or total lines — those have their own fields above

"confidence" is 0 to 1: how sure you are you read that line correctly. Use under 0.5 when
the text or price is blurry, cut off or ambiguous.`;

const SCHEMA = {
  type: 'object',
  properties: {
    merchant: { type: 'string' },
    currency: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          quantity: { type: 'number' },
          unit_price: { type: 'number' },
          total_price: { type: 'number' },
          confidence: { type: 'number' },
        },
        required: ['name', 'confidence'],
      },
    },
    subtotal: { type: 'number' },
    tax: { type: 'number' },
    tip: { type: 'number' },
    fees: { type: 'number' },
    discount: { type: 'number' },
    total: { type: 'number' },
  },
  required: ['items'],
};

function config() {
  return (typeof window !== 'undefined' && window.__RECEIPT_OCR_CONFIG__) || {};
}

/** Settings the user saved in-app win over the build-time config. */
let overrides = { apiKey: '', model: '' };
export function configureGemini({ apiKey, model } = {}) {
  overrides = { apiKey: apiKey || '', model: model || '' };
}

export function getGeminiKey() {
  return overrides.apiKey || config().geminiApiKey || '';
}

function getModel() {
  return overrides.model || config().geminiModel || '';
}

/** Canvas/blob/File -> base64 without the data: prefix. */
async function toBase64(source) {
  if (typeof source === 'string') return source.replace(/^data:[^,]+,/, '');
  if (source && typeof source.toDataURL === 'function') {
    return source.toDataURL('image/jpeg', 0.85).replace(/^data:[^,]+,/, '');
  }
  const blob = source;
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]+,/, ''));
    reader.onerror = () => reject(scannerError('image-decode-failed'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Pull the model's answer out of the response. Thinking steps also carry text,
 * so prefer the model_output steps and only fall back to a broad sweep.
 */
export function extractText(payload) {
  const fromSteps = [];
  const steps = Array.isArray(payload?.steps) ? payload.steps : [];
  for (const step of steps) {
    if (step?.type && step.type !== 'model_output') continue;
    for (const part of Array.isArray(step?.content) ? step.content : []) {
      if (typeof part?.text === 'string' && part.type !== 'thought') fromSteps.push(part.text);
    }
  }
  if (fromSteps.length) return fromSteps.join('\n').trim();

  if (typeof payload?.output_text === 'string') return payload.output_text.trim();

  // Older/other shapes: candidates[].content.parts[].text
  const chunks = [];
  const walk = (node, insideThought) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((child) => walk(child, insideThought));
      return;
    }
    const thought = insideThought || node.type === 'thought' || node.thought === true;
    if (typeof node.text === 'string' && !thought) chunks.push(node.text);
    // 'content' and 'parts' are both walked below, so don't descend twice.
    for (const key of ['steps', 'content', 'output', 'candidates', 'parts', 'message']) {
      if (node[key]) walk(node[key], thought);
    }
  };
  walk(payload, false);
  return chunks.join('\n').trim();
}

/** The first complete {...} in the text, brace-balanced and string-aware. */
function firstJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') inString = !inString;
    if (inString) continue;
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function parseJson(text) {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    /* the model wrapped it in prose */
  }
  const candidate = firstJsonObject(cleaned);
  if (!candidate) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

async function callGemini({ model, apiKey, base64, signal, withSchema = true }) {
  const body = {
    model,
    input: [
      { type: 'text', text: PROMPT },
      { type: 'image', data: base64, mime_type: 'image/jpeg' },
    ],
  };
  // Structured output is the happy path; without it we still ask for JSON in
  // the prompt, which keeps the feature working if the schema is rejected.
  if (withSchema) body.response_format = { type: 'text', mime_type: 'application/json', schema: SCHEMA };

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    signal,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const error = new Error(`Gemini ${response.status}: ${body.slice(0, 300)}`);
    error.status = response.status;
    error.body = body;
    error.response = response;
    throw error;
  }
  return response.json();
}

function mapHttpError(error) {
  const status = error?.status;
  const overloaded = /high demand|overload|unavailable|try again later/i.test(error?.body || '');
  if (status === 401 || status === 403) return scannerError('ai-key-invalid', error);
  if (status === 429) return scannerError(overloaded ? 'ai-busy' : 'ai-rate-limited', error);
  if (status === 503 || overloaded) return scannerError('ai-busy', error);
  if (status >= 500) return scannerError('ai-unavailable', error);
  return scannerError('ai-failed', error);
}

/**
 * Check the key/model with a tiny text-only request and report exactly what the
 * API said, so a failure can be acted on instead of guessed at.
 */
export async function testGeminiConnection() {
  const apiKey = getGeminiKey();
  if (!apiKey) return { ok: false, message: 'No API key is set yet.' };

  const model = getModel() || DEFAULT_MODEL;
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ model, input: 'Reply with the single word: ready' }),
    });
    if (response.ok) {
      const text = extractText(await response.json());
      return { ok: true, model, message: `${model} replied “${text.slice(0, 40) || 'ok'}”.` };
    }
    const body = await response.text().catch(() => '');
    let detail = body.slice(0, 200);
    try {
      detail = JSON.parse(body)?.error?.message || detail;
    } catch {
      /* keep the raw text */
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, model, message: `Key rejected (${response.status}). ${detail}` };
    }
    if (response.status === 404) {
      return { ok: false, model, message: `${model} isn’t available to this key. Try another model. ${detail}` };
    }
    return { ok: false, model, message: `${model} returned ${response.status}. ${detail}` };
  } catch (error) {
    return { ok: false, model, message: `Couldn’t reach Google: ${error?.message || 'network error'}.` };
  }
}

export const geminiProvider = {
  id: 'gemini',
  label: 'AI receipt reader (Gemini)',
  requiresNetwork: true,
  structured: true,
  isAvailable() {
    return typeof fetch === 'function' && Boolean(getGeminiKey());
  },
  /** @returns {Promise<object>} the same review draft shape as the text parser */
  async extractReceipt(source, { onProgress, onNotice, signal } = {}) {
    const apiKey = getGeminiKey();
    if (!apiKey) throw scannerError('ai-no-key');

    onProgress?.({ stage: 'reading', progress: 0.15 });
    const base64 = await toBase64(source);

    const models = buildModelChain(getModel());
    const deadline = Date.now() + OVERALL_DEADLINE_MS;
    let lastError = null;
    let noticed = false;
    let schemaRejected = false;

    for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
      const model = models[modelIndex];
      if (modelIndex > 0 && Date.now() > deadline) break;
      const attempts = attemptsForModel(modelIndex);

      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          onProgress?.({ stage: attempt ? 'retrying' : 'reading', progress: 0.4 });
          let payload;
          try {
            payload = await callGemini({ model, apiKey, base64, signal, withSchema: !schemaRejected });
          } catch (error) {
            // A 400 usually means this build's schema isn't what the API wants.
            // Ask again in plain JSON mode rather than losing the AI reader.
            if (!schemaRejected && error?.status === 400) {
              console.warn('[gemini] structured output rejected, retrying without a schema:', error.body || error.message);
              schemaRejected = true;
              payload = await callGemini({ model, apiKey, base64, signal, withSchema: false });
            } else {
              throw error;
            }
          }
          onProgress?.({ stage: 'parsing', progress: 0.9 });
          const text = extractText(payload);
          const data = parseJson(text);
          if (!data) {
            console.warn('[gemini] could not parse a receipt out of the reply:', String(text).slice(0, 500));
            throw scannerError('ai-failed');
          }
          const draft = createDraftFromStructured(data, {
            provider: 'gemini',
            capturedAt: new Date().toISOString(),
          });
          draft.model = model;
          return draft;
        } catch (error) {
          if (error?.name === 'AbortError') throw scannerError('cancelled', error);
          lastError = error;
          if (error?.status) console.warn(`[gemini] ${model} → ${error.status}:`, String(error.body || '').slice(0, 400));

          // A busy or rate-limited model: wait a moment and ask again.
          if (isRetryableStatus(error?.status) && attempt < attempts - 1 && Date.now() < deadline) {
            await sleep(retryDelay(attempt, error.response));
            continue;
          }
          // Out of attempts on this model, or the model name isn't recognised:
          // try the next one in the chain before giving up on AI altogether.
          const tryNextModel =
            isRetryableStatus(error?.status) ||
            error?.status === 404 ||
            (error?.status === 400 && /model/i.test(error?.body || ''));
          if (tryNextModel && modelIndex < models.length - 1 && Date.now() < deadline) {
            // Say this once; repeating it for every model is just noise.
            if (!noticed) {
              noticed = true;
              onNotice?.(`${model} is busy — trying ${models[modelIndex + 1]} instead.`);
            }
            break;
          }
          if (tryNextModel) throw scannerError('ai-busy', error);
          if (error?.code) throw error;
          throw mapHttpError(error);
        }
      }
    }

    if (lastError?.code) throw lastError;
    if (lastError?.status) throw mapHttpError(lastError);
    throw scannerError('ai-unavailable', lastError);
  },
};
