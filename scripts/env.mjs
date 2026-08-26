// Tiny .env reader — no dependencies, no surprises.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function readEnv(path = '.env') {
  let raw;
  try {
    raw = await readFile(resolve(path), 'utf8');
  } catch {
    return {};
  }
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}
