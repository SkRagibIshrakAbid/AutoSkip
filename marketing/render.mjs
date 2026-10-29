/**
 * Renders promo.html to out/autoskip-promo.mp4.
 *
 *   npm run setup      one-time: installs the render tools (see below)
 *   npm run render     full 30s video at 1080p30, plus out/poster.png
 *   npm run stills     a handful of key frames to out/stills/ for review
 *
 * The page exposes render(t), a pure function of time, so each frame is set
 * exactly and then captured — the result doesn't depend on capture speed.
 *
 * The tools live in ~/.cache/autoskip-render, deliberately OUTSIDE the repo.
 * This folder is the extension root, and Chrome refuses to load an unpacked
 * extension that contains any file whose name starts with "_" — which
 * node_modules always does (readable-stream ships _stream_*.js). Installing
 * them here would break "Load unpacked" for everyone.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TOOLS = process.env.AUTOSKIP_RENDER_TOOLS || path.join(os.homedir(), '.cache', 'autoskip-render');
const requireTool = createRequire(path.join(TOOLS, 'index.js'));
let puppeteer, ffmpegPath;
try {
  puppeteer = requireTool('puppeteer-core');
  ffmpegPath = requireTool('ffmpeg-static');
} catch {
  console.error(`Render tools not found in ${TOOLS}.\nRun once:  npm run setup`);
  process.exit(1);
}

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(DIR, 'out');
const W = 1920, H = 1080, FPS = 30;
const CHROME = process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const STILLS = process.argv.includes('--stills');
const STILL_TIMES = [1.6, 3.0, 5.2, 8.4, 9.1, 10.2, 14.2, 16.5, 17.0, 18.0, 20.8, 21.4, 22.8, 25.6, 29.2];
const POSTER_T = 10.6;   // the toast + headline: the product in one frame

mkdirSync(path.join(OUT, 'stills'), { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none']
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(path.join(DIR, 'promo.html')).href, { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);
const DURATION = await page.evaluate(() => window.DURATION);

async function frameAt(t, opts) {
  await page.evaluate(x => window.render(x), t);
  return page.screenshot({ type: 'jpeg', quality: 95, ...opts });
}

if (STILLS) {
  for (const t of STILL_TIMES) {
    await page.evaluate(x => window.render(x), t);
    await page.screenshot({ path: path.join(OUT, 'stills', `t${t.toFixed(1).padStart(4, '0')}.png`) });
  }
  console.log(`wrote ${STILL_TIMES.length} stills to out/stills/`);
} else {
  const file = path.join(OUT, 'autoskip-promo.mp4');
  const ff = spawn(ffmpegPath, [
    '-y', '-loglevel', 'error',
    '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '17',
    '-pix_fmt', 'yuv420p',          // plays everywhere, including Safari and social apps
    '-movflags', '+faststart',      // starts playing before fully downloaded
    file
  ], { stdio: ['pipe', 'inherit', 'inherit'] });

  const write = buf => new Promise(res => (ff.stdin.write(buf) ? res() : ff.stdin.once('drain', res)));
  const total = Math.round(DURATION * FPS);
  const started = Date.now();

  for (let i = 0; i < total; i++) {
    await write(await frameAt(i / FPS));
    if (i % FPS === 0) process.stdout.write(`\r  rendering ${Math.round((i / total) * 100)}%`);
  }
  ff.stdin.end();
  await new Promise((res, rej) => ff.on('close', c => (c === 0 ? res() : rej(new Error('ffmpeg exit ' + c)))));
  console.log(`\r  rendered ${total} frames in ${((Date.now() - started) / 1000).toFixed(0)}s → out/autoskip-promo.mp4`);

  await page.evaluate(x => window.render(x), POSTER_T);
  await page.screenshot({ path: path.join(OUT, 'poster.png') });
  console.log('  poster → out/poster.png');
}

await browser.close();
