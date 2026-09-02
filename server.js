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
    // Newer interstitial: a <form action="...drive.usercontent.google.com/download"> with hidden inputs.
    const formAction = html.match(/action="(https:\/\/drive\.usercontent\.google\.com\/download[^"]*)"/);
    if (formAction) {
      const params = {};
      const re = /name="([^"]+)"\s+value="([^"]*)"/g;
      let mm;
      while ((mm = re.exec(html)) !== null) params[mm[1]] = mm[2];
      const usp = new URLSearchParams(params);
      const retryUrl = formAction[1].replace(/&amp;/g, '&') + (formAction[1].includes('?') ? '&' : '?') + usp.toString();
      const r2 = await fetch(retryUrl, { redirect: 'follow' });
      if (!r2.ok || !r2.body) throw new Error(`download retry failed (${r2.status}) for ${url}`);
      await pipeline(Readable.fromWeb(r2.body), createWriteStream(destPath));
      return;
    }
    // Older interstitial: an <a href="/uc?export=download&confirm=..."> link.
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

// ── run any command, resolve with { code, stdout, stderr } ────────────────────
function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// ── measure media duration in seconds via ffprobe ─────────────────────────────
async function probeDuration(filePath, cwd) {
  const r = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath], cwd);
  const val = parseFloat((r.stdout || '').trim());
  return Number.isFinite(val) ? val : 0;
}

// ── A/V sync fix ──────────────────────────────────────────────────────────────
// The .sh times each shot from an ESTIMATED duration (~2.5 words/sec), but real
// ElevenLabs narration runs at its own pace, so image cuts drift ahead of the
// voice. Here we stretch the whole silent video uniformly so its length matches
// the real voiceover, then remux audio. This re-seats every cut on its narration.
async function fixSync(cwd) {
  const silent = path.join(cwd, 'video_no_audio.mp4');
  const voice = path.join(cwd, 'voiceover.mp3');
  const music = path.join(cwd, 'music.mp3');
  try {
    await fs.access(silent);
    await fs.access(voice);
  } catch {
    console.log('[sync] intermediates missing (video_no_audio.mp4 / voiceover.mp3) — keeping .sh final.mp4');
    return; // fall back to whatever the .sh produced
  }

  const vDur = await probeDuration(silent, cwd);
  const aDur = await probeDuration(voice, cwd);
  if (vDur <= 0 || aDur <= 0) {
    console.log(`[sync] bad durations v=${vDur} a=${aDur} — keeping .sh final.mp4`);
    return;
  }

  // setpts factor: >1 slows video down (lengthens), <1 speeds up (shortens).
  const factor = aDur / vDur;
  console.log(`[sync] video=${vDur.toFixed(2)}s voice=${aDur.toFixed(2)}s -> setpts factor ${factor.toFixed(4)}`);

  const stretched = path.join(cwd, 'video_synced.mp4');
  const r1 = await run('ffmpeg', ['-y', '-i', silent, '-filter:v', `setpts=${factor}*PTS`, '-r', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', stretched], cwd);
  if (r1.code !== 0) {
    console.error('[sync] stretch failed — keeping .sh final.mp4\n' + r1.stderr.slice(-2000));
    return;
  }

  const outFinal = path.join(cwd, 'final.mp4');
  let hasMusic = false;
  try { await fs.access(music); hasMusic = true; } catch { hasMusic = false; }

  let r2;
  if (hasMusic) {
    r2 = await run('ffmpeg', ['-y', '-i', stretched, '-i', voice, '-i', music,
      '-filter_complex', '[2:a]volume=0.15[m];[1:a][m]amix=inputs=2:duration=first[a]',
      '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-shortest', outFinal], cwd);
  } else {
    r2 = await run('ffmpeg', ['-y', '-i', stretched, '-i', voice,
      '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-shortest', outFinal], cwd);
  }
  if (r2.code !== 0) {
    console.error('[sync] remux failed — keeping .sh final.mp4\n' + r2.stderr.slice(-2000));
    return;
  }
  console.log('[sync] final.mp4 rebuilt in sync with voiceover');
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

    // Re-seat image cuts on the real narration (fix A/V drift). Best-effort:
    // on any problem it keeps the .sh-produced final.mp4.
    try { await fixSync(work); } catch (e) { console.error('[sync] skipped:', e.message); }

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
