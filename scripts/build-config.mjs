// Builds ./dist: a copy of ./web with config.js filled in from .env or the environment.
// GitHub Actions runs this on every deploy. Usage: node scripts/build-config.mjs
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { loadEnv } from './env.mjs';

const env = loadEnv();
const need = ['SUPABASE_URL', 'SUPABASE_ANON_KEY'];
const missing = need.filter((k) => !env[k] || env[k].includes('YOUR-'));
if (missing.length) {
  console.error('Missing or still a placeholder: ' + missing.join(', ') + '. Fill them in .env (or GitHub variables).');
  process.exit(1);
}
const cfg = {
  SUPABASE_URL: env.SUPABASE_URL,
  SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY,
  GOOGLE_HOSTED_DOMAIN: env.GOOGLE_HOSTED_DOMAIN || '',
  APP_TITLE: env.APP_TITLE || 'Class slot booking',
};
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
cpSync('web', 'dist', { recursive: true });
writeFileSync('dist/config.js', 'window.APP_CONFIG = ' + JSON.stringify(cfg, null, 2) + ';\n');
writeFileSync('dist/.nojekyll', '');
console.log('Built dist/ for ' + cfg.SUPABASE_URL);
