// "Provider" for text the user pastes or types in — the always-available
// fallback when OCR can't load, and the fixture source for tests.

export const textProvider = {
  id: 'text',
  label: 'Typed / pasted receipt',
  requiresNetwork: false,
  isAvailable: () => true,
  async recognize(source) {
    const text = typeof source === 'string' ? source : String(source?.text || '');
    const lines = text
      .split(/\r?\n/)
      .map((line) => ({ text: line.trim(), confidence: 95 }))
      .filter((line) => line.text);
    return { text, lines, meanConfidence: 95 };
  },
};
