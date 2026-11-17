const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VERSION = 'tiles-v2';
const W = 900;
const H = 1600;
const FPS = 30;

const app = express();
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 500 * 1024 * 1024 } });

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-20000); });
    p.on('error', reject);
    p.on('close', (code, signal) => {
      if (code === 0) return resolve(out);
      reject(new Error(cmd + ' exited code=' + code + ' signal=' + signal + ': ' + err.slice(-2000)));
    });
  });
}

async function probe(file) {
  const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file]);
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

// Resize a still image to W x H RGBA PNG once
async function prescale(file, tmpList) {
  const out = file.path + '_scaled.png';
  tmpList.push(out);
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', file.path,
    '-vf', 'scale=' + W + ':' + H + ',format=rgba', '-frames:v', '1', out]);
  return out;
}

app.get('/health', (req, res) => res.json({ ok: true, version: VERSION }));

app.post('/render', upload.any(), async (req, res) => {
  const files = req.files || [];
  const f = {};
  for (const file of files) f[file.fieldname] = file;
  if (!f['niz-pravo'] && f.nizpravo) f['niz-pravo'] = f.nizpravo;

  const tmp = [];
  const outFile = path.join(os.tmpdir(), 'tiles_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.mp4');
  const cleanup = () => {
    for (const file of files) fs.unlink(file.path, () => {});
    for (const t of tmp) fs.unlink(t, () => {});
    fs.unlink(outFile, () => {});
  };

  try {
    if (!f.fon || !f.vid) {
      cleanup();
      return res.status(400).json({ error: 'fon and vid are required', received: Object.keys(f) });
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
    const D = info.duration.toFixed(3);

    // Pre-scale still layers once
    const stillPath = {};
    for (const key of ['transport', 'niz-pravo', 'ramka1', 'ramka2', 'ramka3', 'item', 'topleft']) {
      if (f[key] && !isVideo(f[key])) stillPath[key] = await prescale(f[key], tmp);
    }

    // ---------- inputs ----------
    const args = ['-y', '-loglevel', 'error', '-nostats', '-filter_complex_threads', '1'];
    const idx = {};
    let n = 0;
    const addInput = (key, loop) => {
      if (stillPath[key]) {
        args.push('-loop', '1', '-framerate', String(FPS), '-t', D, '-i', stillPath[key]);
      } else if (isVideo(f[key])) {
        if (loop) args.push('-stream_loop', '-1');
        args.push('-i', f[key].path);
      } else {
        args.push('-loop', '1', '-framerate', String(FPS), '-t', D, '-i', f[key].path);
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
    filters.push('[' + idx.fon + ':v]scale=' + W + ':' + H + ':force_original_aspect_ratio=increase,crop=' + W + ':' + H + ',setsar=1,fps=' + FPS + '[base0]');
    let cur = 'base0';
    let k = 0;
    const overlay = (src, x, y, enable) => {
      const out = 'base' + (++k);
      let s = '[' + cur + '][' + src + ']overlay=x=' + x + ':y=' + y;
      if (enable) s += ":enable='" + enable + "'";
      filters.push(s + '[' + out + ']');
      cur = out;
    };
    const layer = (key, enable) => {
      if (stillPath[key]) {
        overlay(idx[key] + ':v', 0, 0, enable);
      } else {
        const label = 'L' + key.replace(/\W/g, '');
        filters.push('[' + idx[key] + ':v]scale=' + W + ':' + H + ',setsar=1,fps=' + FPS + '[' + label + ']');
        overlay(label, 0, 0, enable);
      }
    };

    if (f.transport) layer('transport');
    if (f['niz-pravo']) layer('niz-pravo');

    filters.push('[' + idx.vid + ':v]scale=-2:' + vidH + ',setsar=1,fps=' + FPS + '[Lvid]');
    overlay('Lvid', '(main_w-overlay_w)/2', vidY);

    if (ramkaKeys.length) {
      const cycle = ramkaKeys.length * ramkaSec;
      ramkaKeys.forEach((key, i) => {
        const a = i * ramkaSec;
        const b = (i + 1) * ramkaSec;
        layer(key, 'gte(mod(t,' + cycle + '),' + a + ')*lt(mod(t,' + cycle + '),' + b + ')');
      });
    }

    if (f.item) layer('item');
    if (f.topleft) layer('topleft');

    filters.push('[' + cur + ']format=yuv420p[vout]');

    args.push('-filter_complex', filters.join(';'), '-map', '[vout]');
    if (info.hasAudio) args.push('-map', idx.vid + ':a', '-c:a', 'aac', '-b:a', '160k');
    else args.push('-an');
    args.push(
      '-t', D, '-r', String(FPS),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
      '-threads', '2', '-x264-params', 'rc-lookahead=10',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      outFile
    );

    console.log('Rendering', payload.title || '', 'duration', D, 'inputs', Object.keys(idx));
    await run('ffmpeg', args);

    const name = (payload.title || 'tiles_hop').replace(/[^\w#-]+/g, '_') + '.mp4';
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="' + name + '"');
    res.sendFile(outFile, () => cleanup());
  } catch (e) {
    console.error(e.message);
    cleanup();
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server ' + VERSION + ' on ' + PORT));
