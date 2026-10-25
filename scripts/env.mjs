// Tiny .env reader shared by the scripts. Real environment variables win over the file.
import { existsSync, readFileSync } from 'node:fs';

export function loadEnv(path = '.env') {
  const out = {};
  if (existsSync(path)) {
    for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      out[line.slice(0, eq).trim()] = v;
    }
  }
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && v !== '') out[k] = v;
  return out;
}
