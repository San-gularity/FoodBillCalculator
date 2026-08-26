import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModelChain, isRetryableStatus, attemptsForModel, MODEL_CHAIN, DEFAULT_MODEL } from '../src/scanner/providers/gemini.js';

test('the default model is a steady one, not the newest and busiest', () => {
  assert.equal(DEFAULT_MODEL, 'gemini-2.5-flash');
  assert.equal(MODEL_CHAIN[0], DEFAULT_MODEL);
  assert.ok(MODEL_CHAIN.length >= 3, 'there are backups to fall through');
});

test('a pinned model is tried first, with the rest as backup and no duplicates', () => {
  const chain = buildModelChain('gemini-3.7-flash');
  assert.equal(chain[0], 'gemini-3.7-flash');
  assert.equal(new Set(chain).size, chain.length);
  assert.deepEqual(new Set(chain), new Set(MODEL_CHAIN));
});

test('no pinned model means the default chain, in order', () => {
  assert.deepEqual(buildModelChain(''), MODEL_CHAIN);
  assert.deepEqual(buildModelChain(null), MODEL_CHAIN);
  assert.deepEqual(buildModelChain('   '), MODEL_CHAIN);
});

test('an unknown pinned model still falls back to the known ones', () => {
  const chain = buildModelChain('gemini-made-up');
  assert.equal(chain[0], 'gemini-made-up');
  assert.equal(chain[1], DEFAULT_MODEL);
});

test('busy and rate-limited responses are retried; real errors are not', () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    assert.equal(isRetryableStatus(status), true, `${status} should retry`);
  }
  for (const status of [400, 401, 403, 404, 422, undefined, null]) {
    assert.equal(isRetryableStatus(status), false, `${status} should not retry`);
  }
});

test('the first model gets retries; later ones are only probed once', () => {
  assert.equal(attemptsForModel(0), 3);
  assert.equal(attemptsForModel(1), 1);
  assert.equal(attemptsForModel(4), 1);
  // Worst case: 3 attempts + one probe per remaining model.
  const worstCaseCalls = attemptsForModel(0) + (MODEL_CHAIN.length - 1);
  assert.ok(worstCaseCalls <= 8, `bounded number of calls before falling back (${worstCaseCalls})`);
});

import { extractText, parseJson } from '../src/scanner/providers/gemini.js';

test('the answer is read from the model output, not from its thinking', () => {
  const payload = {
    steps: [
      { type: 'thought', content: [{ type: 'text', text: 'Let me look at the receipt {maybe}' }] },
      { type: 'model_output', content: [{ type: 'text', text: '{"items":[]}' }] },
    ],
  };
  assert.equal(extractText(payload), '{"items":[]}');
});

test('older response shapes still work', () => {
  assert.equal(extractText({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }), 'hi');
  assert.equal(extractText({ output_text: 'hello' }), 'hello');
  assert.equal(extractText({}), '');
  assert.equal(extractText(null), '');
});

test('JSON is recovered from fences and surrounding prose', () => {
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJson('Here you go:\n{"a":1}\nHope that helps!'), { a: 1 });
  assert.deepEqual(parseJson('{"items":[{"name":"A {weird} name","total_price":1}]}'), {
    items: [{ name: 'A {weird} name', total_price: 1 }],
  });
  assert.equal(parseJson('no json here'), null);
  assert.equal(parseJson(''), null);
  assert.equal(parseJson('{"broken":'), null);
});
