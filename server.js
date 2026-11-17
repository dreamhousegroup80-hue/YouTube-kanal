const express = require('express');
const multer = require('multer');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const app = express();
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 300 * 1024 * 1024 } });

const W = 900;
const H = 1600;
const FPS = 30;

const FIELDS = ['fon', 'transport', 'niz-pravo', 'vid', 'ramka1', 'ramka2', 'ramka3', 'item', 'topleft'];

app.get('/health', (req, res) => res.json({ ok: true }));

function probeDuration(file) {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
      (err, out) => {
        const d = parseFloat(String(out || '').trim());
        resolve(err || !isFinite(d) ? null : d);
      });
  });
}

app.post('/render', upload.fields(FIELDS.map((name) => ({ name, maxCount: 1 }))), async (req, res) => {
  const f = req.files || {};
  const file = (k) => (f[k] && f[k][0] ? f[k][0].path : null);
  const tmpFiles = Object.values(f).flat().map((x) => x.path);
  const cleanup = () => tmpFiles.forEach((p) => { try { fs.unlinkSync(p); } catch (e) {} });

  let payload = {};
  try { payload = JSON.parse(req.body.payload || '{}'); }
  catch (e) { cleanup(); return res.status(400).json({ error: 'BAD_PAYLOAD', detail: String(e) }); }

  for (const k of FIELDS) {
    if (!file(k)) { cleanup(); return res.status(400).json({ error: 'MISSING_FILE', field: k }); }
  }

  const layers = Array.isArray(payload.layers) ? payload.layers : [];
  const vidCfg = layers.find((l) => l.name === 'vid') || {};
  const ramkaCfg = layers.find((l) => l.name === 'ramka') || {};
  const vidH = Number(vidCfg.scale_to || 750);          // высота vid
  const vidY = Number(vidCfg.y != null ? vidCfg.y : 0); // отступ сверху
  const sec = Number(ramkaCfg.seconds_each || 3);       // сколько секунд каждая рамка
  const cycle = sec * 3;

  // Длительность ролика = длительность vid
  const vidDur = await probeDuration(file('vid'));
  const duration = Number(payload.duration || vidDur || 15);

  const outPath = path.join(os.tmpdir(), 'out_' + Date.now() + '.mp4');

  const args = ['-y',
    '-stream_loop', '-1', '-i', file('fon'),  // 0 фон (видео, зациклен, без звука)
    '-i', file('vid'),                        // 1 vid (основной звук)
    '-loop', '1', '-i', file('transport'),    // 2
    '-loop', '1', '-i', file('niz-pravo'),    // 3
    '-loop', '1', '-i', file('ramka1'),       // 4
    '-loop', '1', '-i', file('ramka2'),       // 5
    '-loop', '1', '-i', file('ramka3'),       // 6
    '-loop', '1', '-i', file('item'),         // 7
    '-loop', '1', '-i', file('topleft'),      // 8
  ];

  const full = (i, label) => `[${i}:v]scale=${W}:${H},setsar=1,format=rgba[${label}]`;

  const segs = [
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${FPS}[bg]`,
    full(2, 'tr'), full(3, 'np'), full(4, 'r1'), full(5, 'r2'), full(6, 'r3'), full(7, 'it'), full(8, 'tl'),
    `[1:v]scale=-2:${vidH},setsar=1,fps=${FPS},setpts=PTS-STARTPTS[vd]`,
    `[bg][tr]overlay=0:0[l1]`,
    `[l1][np]overlay=0:0[l2]`,
    `[l2][vd]overlay=x=(W-w)/2:y=${vidY}:eof_action=pass[l3]`,
    `[l3][r1]overlay=0:0:enable='lt(mod(t,${cycle}),${sec})'[l4]`,
    `[l4][r2]overlay=0:0:enable='gte(mod(t,${cycle}),${sec})*lt(mod(t,${cycle}),${2 * sec})'[l5]`,
    `[l5][r3]overlay=0:0:enable='gte(mod(t,${cycle}),${2 * sec})'[l6]`,
    `[l6][it]overlay=0:0[l7]`,
    `[l7][tl]overlay=0:0,format=yuv420p[vout]`,
  ];

  args.push(
    '-filter_complex', segs.join(';'),
    '-map', '[vout]',
    '-map', '1:a?',               // звук только из vid
    '-t', String(duration),
    '-r', String(FPS),
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    '-threads', '2',
    '-filter_complex_threads', '1',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    outPath
  );

  const ff = spawn('ffmpeg', args);
  let stderr = '';
  ff.stderr.on('data', (d) => { stderr += d.toString(); });

  ff.on('close', (code) => {
    cleanup();
    if (code !== 0 || !fs.existsSync(outPath)) {
      console.error('FFMPEG FAILED code=' + code);
      console.error(stderr);
      return res.status(500).json({ error: 'FFMPEG_FAILED', exitCode: code, stderr: stderr.slice(-4000) });
    }
    res.setHeader('Content-Type', 'video/mp4');
    const stream = fs.createReadStream(outPath);
    stream.pipe(res);
    stream.on('close', () => { try { fs.unlinkSync(outPath); } catch (e) {} });
  });

  ff.on('error', (err) => {
    cleanup();
    console.error('SPAWN ERROR', err);
    res.status(500).json({ error: 'SPAWN_ERROR', detail: String(err) });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Render server on ' + PORT));
