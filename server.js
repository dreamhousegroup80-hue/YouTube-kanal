const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const VERSION = 'tiles-v3';
const W = 720, H = 1280, FPS = 30;
const S = H / 1600; // масштаб от старого холста 900x1600

const app = express();

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      if (!req.jobDir) req.jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-'));
      cb(null, req.jobDir);
    },
    filename: (req, file, cb) =>
      cb(null, file.fieldname + (path.extname(file.originalname || '') || '.bin')),
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
});

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; if (err.length > 8000) err = err.slice(-8000); });
    p.on('error', reject);
    p.on('close', (code, signal) => code === 0
      ? resolve(out)
      : reject(new Error(`${cmd} exited code=${code} signal=${signal}: ${err.slice(-1500)}`)));
  });
}
const ff = args => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const even = n => Math.max(2, Math.round(n / 2) * 2);

async function probeDuration(file) {
  const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', file]);
  const d = parseFloat(out);
  if (!d || !isFinite(d)) throw new Error('cannot read vid duration');
  return Math.min(d, 600);
}

// Склеить PNG-слои в одну прозрачную картинку W x H
async function composite(layers, out) {
  const args = ['-f', 'lavfi', '-i', `color=c=black@0.0:s=${W}x${H},format=rgba`];
  layers.forEach(f => args.push('-i', f));
  let fc = '[0:v]format=rgba[c0]';
  layers.forEach((f, i) => {
    fc += `;[${i + 1}:v]scale=${W}:${H},format=rgba[l${i}]` +
          `;[c${i}][l${i}]overlay=0:0:format=rgb[c${i + 1}]`;
  });
  fc += `;[c${layers.length}]format=rgba[out]`;
  args.push('-filter_complex', fc, '-map', '[out]', '-frames:v', '1', '-update', '1', out);
  await ff(args);
}

// Один рендер за раз, чтобы не удваивать память
let queue = Promise.resolve();
const serial = fn => { const r = queue.then(fn, fn); queue = r.catch(() => {}); return r; };

app.get('/health', (req, res) => res.json({ ok: true, version: VERSION, size: `${W}x${H}` }));

app.post('/render', upload.any(), async (req, res) => {
  const dir = req.jobDir || fs.mkdtempSync(path.join(os.tmpdir(), 'job-'));
  const cleanup = () => fs.rm(dir, { recursive: true, force: true }, () => {});
  try {
    const f = {};
    (req.files || []).forEach(file => { f[file.fieldname] = file; });
    if (!f.vid) throw new Error('missing field: vid');
    if (!f.fon) throw new Error('missing field: fon');

    let payload = {};
    try { payload = typeof req.body.payload === 'string' ? JSON.parse(req.body.payload) : (req.body.payload || {}); } catch (e) {}

    const out = await serial(async () => {
      const p = n => path.join(dir, n);
      const D = (await probeDuration(f.vid.path)).toFixed(3);
      const vidH = even((Number(payload.scale_to) || 750) * S);
      const y = Math.round((Number(payload.y) || 0) * S);

      // 1. Неподвижные слои
      const under = p('under.png');
      await composite(['transport', 'niz-pravo'].filter(k => f[k]).map(k => f[k].path), under);

      const topsFixed = ['item', 'topleft'].filter(k => f[k]).map(k => f[k].path);
      const ramkas = ['ramka1', 'ramka2', 'ramka3'].filter(k => f[k]).map(k => f[k].path);
      const tops = [];
      if (ramkas.length) {
        for (let i = 0; i < ramkas.length; i++) {
          const t = p(`top${i + 1}.png`);
          await composite([ramkas[i], ...topsFixed], t);
          tops.push(t);
        }
      } else if (topsFixed.length) {
        const t = p('top1.png');
        await composite(topsFixed, t);
        tops.push(t);
      }

      // 2. Фон: зациклить, без звука, W x H
      const fonS = p('fon_s.mp4');
      const fonIsImage = /^image\//.test(f.fon.mimetype || '');
      await ff([
        ...(fonIsImage ? ['-loop', '1', '-framerate', String(FPS)] : ['-stream_loop', '-1']),
        '-threads', '1', '-t', D, '-i', f.fon.path,
        '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS}`,
        '-an', '-t', D, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22',
        '-pix_fmt', 'yuv420p', '-threads', '1', fonS,
      ]);

      // 3. Vid: уменьшить, звук оставить
      const vidS = p('vid_s.mp4');
      await ff([
        '-threads', '1', '-i', f.vid.path,
        '-vf', `scale=-2:${vidH},fps=${FPS}`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-threads', '1', vidS,
      ]);

      // 4. Финальная сборка
      const result = p('out.mp4');
      const args = [
        '-threads', '1', '-i', fonS,
        '-loop', '1', '-framerate', String(FPS), '-t', D, '-i', under,
        '-threads', '1', '-i', vidS,
      ];
      tops.forEach(t => args.push('-loop', '1', '-framerate', String(FPS), '-t', D, '-i', t));

      let fc = `[0:v][1:v]overlay=0:0[b1];[b1][2:v]overlay=(W-w)/2:${y}:eof_action=pass[b2]`;
      let last = 'b2';
      const n = tops.length, cycle = n * 3;
      tops.forEach((t, i) => {
        const en = n > 1 ? `:enable='gte(mod(t,${cycle}),${i * 3})*lt(mod(t,${cycle}),${(i + 1) * 3})'` : '';
        fc += `;[${last}][${3 + i}:v]overlay=0:0${en}[t${i}]`;
        last = `t${i}`;
      });
      fc += `;[${last}]format=yuv420p[v]`;

      args.push(
        '-filter_complex', fc, '-filter_complex_threads', '1',
        '-map', '[v]', '-map', '2:a?', '-t', D,
        '-c:v', 'libx264', '-preset', 'superfast', '-crf', '23', '-threads', '2',
        '-c:a', 'copy', '-movflags', '+faststart', result,
      );
      await ff(args);
      return result;
    });

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="tiles_hop.mp4"');
    res.sendFile(out, err => { cleanup(); if (err && !res.headersSent) res.status(500).end(); });
  } catch (e) {
    cleanup();
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`render server ${VERSION} on ${PORT}`));
