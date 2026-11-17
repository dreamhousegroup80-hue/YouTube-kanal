const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VERSION = 'tiles-v1';
const W = 900;
const H = 1600;
const FPS = 30;

const app = express();
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 500 * 1024 * 1024 },
});

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => {
      err += d;
      if (err.length > 20000) err = err.slice(-20000);
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(cmd + ' exited ' + code + ': ' + err.slice(-3000)));
    });
  });
}

async function probe(file) {
  const out = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type',
    '-of', 'json',
    file,
  ]);
  const j = JSON.parse(out);
  return {
    duration: parseFloat(j.format && j.format.duration) || 0,
    hasAudio: (j.streams || []).some((s) => s.codec_type === 'audio'),
  };
}

function isVideo(file) {
  if (file.mimetype && file.mimetype.startsWith('video/')) return true;
  return /\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(file.originalname || '');
}

app.get('/health', (req, res) => {
  res.json({ ok: true, version: VERSION });
});

app.post('/render', upload.any(), async (req, res) => {
  const files = req.files || [];
  const f = {};
  for (const file of files) f[file.fieldname] = file;
  if (!f['niz-pravo'] && f.nizpravo) f['niz-pravo'] = f.nizpravo;

  const outFile = path.join(
    os.tmpdir(),
    'tiles_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.mp4'
  );
  const cleanup = () => {
    for (const file of files) fs.unlink(file.path, () => {});
    fs.unlink(outFile, () => {});
  };

  try {
    if (!f.fon || !f.vid) {
      cleanup();
      return res.status(400).json({
        error: 'fon and vid are required',
        received: Object.keys(f),
      });
    }

    let payload = {};
    try { payload = JSON.parse(req.body.payload || '{}'); } catch (e) { payload = {}; }
    const layers = Array.isArray(payload.layers) ? payload.layers : [];
    const vidLayer = layers.find((l) => l.name === 'vid') || {};
    const ramkaLayer = layers.find((l) => l.name === 'ramka') || {};
    const vidH = Number(vidLayer.scale_to) || 750;
    const vidY = Number(vidLayer.y) || 0;
    const ramkaSec = Number(ramkaLayer.seconds_each) || 3;

    const info = await probe(f.vid.path);
    if (!info.duration) throw new Error('Cannot read vid duration');
    const D = info.duration;

    // ---------- inputs ----------
    const args = ['-y'];
    const idx = {};
    let n = 0;
    const addInput = (key, loop) => {
      const file = f[key];
      if (isVideo(file)) {
        if (loop) args.push('-stream_loop', '-1');
        args.push('-i', file.path);
      } else {
        args.push('-loop', '1', '-framerate', String(FPS), '-i', file.path);
      }
      idx[key] = n++;
    };

    addInput('fon', true);
    for (const key of ['transport', 'niz-pravo']) if (f[key]) addInput(key, true);
    addInput('vid', false);
    const ramkaKeys = ['ramka1', 'ramka2', 'ramka3'].filter((k) => f[k]);
    for (const key of ramkaKeys) addInput(key, true);
    for (const key of ['item', 'topleft']) if (f[key]) addInput(key, true);

    // ---------- filters ----------
    const filters = [];
    filters.push(
      '[' + idx.fon + ':v]scale=' + W + ':' + H +
      ':force_original_aspect_ratio=increase,crop=' + W + ':' + H +
      ',setsar=1,fps=' + FPS + ',format=rgba[base0]'
    );
    let cur = 'base0';
    let k = 0;

    const overlay = (label, x, y, enable) => {
      const out = 'base' + (++k);
      let s = '[' + cur + '][' + label + ']overlay=x=' + x + ':y=' + y;
      if (enable) s += ":enable='" + enable + "'";
      s += '[' + out + ']';
      filters.push(s);
      cur = out;
    };

    const fullLayer = (key) => {
      const label = 'L' + key.replace(/\W/g, '');
      filters.push(
        '[' + idx[key] + ':v]scale=' + W + ':' + H + ',setsar=1,fps=' + FPS + ',format=rgba[' + label + ']'
      );
      overlay(label, 0, 0);
    };

    // 2-3: transport, niz-pravo
    if (f.transport) fullLayer('transport');
    if (f['niz-pravo']) fullLayer('niz-pravo');

    // 4: vid — height vidH, centered horizontally, at the top
    filters.push(
      '[' + idx.vid + ':v]scale=-2:' + vidH + ',setsar=1,fps=' + FPS + ',format=rgba[Lvid]'
    );
    overlay('Lvid', '(main_w-overlay_w)/2', vidY);

    // 5: ramka 1,2,3 — ramkaSec seconds each, looping
    if (ramkaKeys.length) {
      const cycle = ramkaKeys.length * ramkaSec;
      ramkaKeys.forEach((key, i) => {
        const label = 'Lr' + i;
        filters.push(
          '[' + idx[key] + ':v]scale=' + W + ':' + H + ',setsar=1,fps=' + FPS + ',format=rgba[' + label + ']'
        );
        const a = i * ramkaSec;
        const b = (i + 1) * ramkaSec;
        overlay(label, 0, 0, 'gte(mod(t,' + cycle + '),' + a + ')*lt(mod(t,' + cycle + '),' + b + ')');
      });
    }

    // 6-7: item, topleft
    if (f.item) fullLayer('item');
    if (f.topleft) fullLayer('topleft');

    filters.push('[' + cur + ']format=yuv420p[vout]');

    args.push('-filter_complex', filters.join(';'));
    args.push('-map', '[vout]');
    if (info.hasAudio) {
      args.push('-map', idx.vid + ':a', '-c:a', 'aac', '-b:a', '160k');
    } else {
      args.push('-an');
    }
    args.push(
      '-t', String(D),
      '-r', String(FPS),
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      outFile
    );

    console.log('Rendering', payload.title || '', 'duration', D, 'inputs', Object.keys(idx));
    await run('ffmpeg', args);

    const name = (payload.title || 'tiles_hop').replace(/[^\w#-]+/g, '_') + '.mp4';
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="' + name + '"');
    res.sendFile(outFile, () => cleanup());
  } catch (e) {
    console.error(e);
    cleanup();
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server ' + VERSION + ' on ' + PORT));
