// ─────────────────────────────────────────────────────────────────────────────
// railway-github-ffmpeg
//
// HTTP ffmpeg render service for the n8n "Scheduled and Manual Start" pipeline.
//
// NO Google authentication needed here. n8n lists the Drive folder itself and
// passes PUBLIC download links; this service just downloads each URL, runs the
// generated .sh, and streams the finished final.mp4 straight back in the HTTP
// response. n8n then uploads that mp4 to Drive.
//
// Contract with n8n (node "Call Railway FFmpeg"):
//   POST /render
//   body: {
//     topic_title?: string,                       // for logging only
//     files: [ { name: "S0001.jpg", url: "https://drive.google.com/uc?..." }, ... ]
//   }
//   -> response: the finished final.mp4 (Content-Type: video/mp4) as a binary body.
//
// What it does per request:
//   1. Downloads every file in `files[]` into a temp working dir under its `name`
//      (skips any previous final_video*.mp4).
//   2. Finds the newest Documentary_FFmpeg_*.sh (any *.sh) among them.
//   3. Runs it with bash (ffmpeg must be on PATH -> installed via Dockerfile).
//   4. Streams the resulting final.mp4 back to the caller.
//
// Auth (inbound, optional): set RENDER_TOKEN and send it from n8n as
//   Authorization: Bearer <RENDER_TOKEN>
// ─────────────────────────────────────────────────────────────────────────────

import express from 'express';
import { spawn } from 'node:child_process';
import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';

const PORT = process.env.PORT || 8080;
const RENDER_TOKEN = process.env.RENDER_TOKEN || '';

// ── download a single public URL to a local path ─────────────────────────────
async function downloadUrl(url, destPath) {
  const resp = await fetch(url, { redirect: 'follow' });
  if (!resp.ok || !resp.body) {
    throw new Error(`download failed (${resp.status}) for ${url}`);
  }
  // Guard against Google Drive's HTML "virus scan" interstitial for big files.
  const ctype = resp.headers.get('content-type') || '';
  if (ctype.includes('text/html')) {
    const html = await resp.text();
    const m = html.match(/href="(\/uc\?export=download[^"]+)"/);
    if (m) {
      const retryUrl = 'https://drive.google.com' + m[1].replace(/&amp;/g, '&');
      const r2 = await fetch(retryUrl, { redirect: 'follow' });
      if (!r2.ok || !r2.body) throw new Error(`download retry failed (${r2.status}) for ${url}`);
      await pipeline(Readable.fromWeb(r2.body), createWriteStream(destPath));
      return;
    }
    throw new Error(`got HTML instead of file for ${url} (is it shared "anyone with link"?)`);
  }
  await pipeline(Readable.fromWeb(resp.body), createWriteStream(destPath));
}

// ── run the generated bash/ffmpeg script ─────────────────────────────────────
function runScript(scriptPath, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [scriptPath], { cwd, env: process.env });
    let stderr = '';
    child.stdout.on('data', (d) => process.stdout.write(d));
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      process.stderr.write(d);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('render script exited with code ' + code + '\n' + stderr.slice(-4000)));
    });
  });
}

// ── HTTP server ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '5mb' }));

function checkAuth(req, res) {
  if (!RENDER_TOKEN) return true; // auth disabled
  const hdr = req.get('authorization') || '';
  if (hdr === `Bearer ${RENDER_TOKEN}`) return true;
  res.status(401).json({ error: 'unauthorized' });
  return false;
}

app.get('/', (_req, res) => res.json({ ok: true, service: 'railway-github-ffmpeg' }));
app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/render', async (req, res) => {
  if (!checkAuth(req, res)) return;

  const { topic_title, files } = req.body || {};
  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'files[] is required (array of { name, url })' });
  }

  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'render-'));
  console.log(`[render] topic="${topic_title || ''}" files=${files.length} work=${work}`);

  try {
    for (const f of files) {
      if (!f || !f.name || !f.url) continue;
      if (/^final_video.*\.mp4$/i.test(f.name)) continue; // skip prior outputs
      await downloadUrl(f.url, path.join(work, f.name));
      console.log(`[render] downloaded ${f.name}`);
    }

    // Pick the newest generated ffmpeg .sh (workflow names them Documentary_FFmpeg_*.sh)
    const local = await fs.readdir(work);
    const shFiles = local.filter((n) => /\.sh$/i.test(n) || /ffmpeg/i.test(n)).sort();
    const scriptName = shFiles[shFiles.length - 1];
    if (!scriptName) {
      return res.status(422).json({ error: 'no Documentary_FFmpeg_*.sh found in files[]' });
    }
    console.log(`[render] running ${scriptName}`);
    await runScript(path.join(work, scriptName), work);

    const finalPath = path.join(work, 'final.mp4');
    try {
      await fs.access(finalPath);
    } catch {
      return res.status(500).json({ error: 'render finished but final.mp4 was not produced' });
    }

    const outName = `final_video_${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}.mp4`;
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${outName}"`);
    console.log(`[render] done -> streaming ${outName}`);
    await pipeline(createReadStream(finalPath), res);
  } catch (err) {
    console.error('[render] error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
  } finally {
    fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
});

app.listen(PORT, () => console.log(`railway-github-ffmpeg listening on :${PORT}`));
