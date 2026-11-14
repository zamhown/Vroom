import fs from 'node:fs';
import path from 'node:path';
import { flags, root } from './lib/process.mjs';

const options = flags(['--check']);
const source = fs.readFileSync(path.join(root, 'resources/branding/vroom.svg'), 'utf8');
const foreground = source.replace(/\s*<rect\b[^>]*\/>/, '');
const background = source.replace(/\s*<path\b[^>]*\/>/, '').replace(' rx="30"', '');
const outputs = new Map([
  ['src/Vroom.Client/public/vroom.svg', source],
  ['src/Vroom.App/Resources/AppIcon/appicon.svg', background],
  ['src/Vroom.App/Resources/AppIcon/appiconfg.svg', foreground],
  ['src/Vroom.App/Resources/Splash/splash.svg', foreground],
]);
for (const [file, content] of outputs) {
  const destination = path.join(root, file);
  if (options.has('--check')) {
    if (!fs.existsSync(destination) || fs.readFileSync(destination, 'utf8') !== content)
      throw new Error(`${file} is stale. Run node scripts/sync-branding.mjs.`);
  } else {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  }
}
console.log(options.has('--check') ? 'Brand assets are synchronized.' : 'Brand assets generated.');
