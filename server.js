import express from 'express';
import { google } from 'googleapis';
import { spawn } from 'node:child_process';
import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const PORT = process.env.PORT || 8080;
const RENDER_TOKEN = process.env.RENDER_TOKEN || '';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');

function driveClient() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var is not set');
  let creds;
  try { creds = JSON.parse(raw); }
  catch (e) { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON: ' + e.message); }
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

async function listFolder(drive, folderId) {
  const files = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, size)',
      pageSize: 1000, pageToken,
      supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return files;
}

async function downloadFile(drive, fileId, destPath) {
  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' }
  );
  await new Promise((resolve, reject) => {
    const out = createWriteStream(destPath);
    res.data.on('error', reject).pipe(out).on('error', reject).on('finish', resolve);
  });
}

async function uploadFile(drive, folderId, localPath, name, mimeType) {
  const res = await drive.files.create({
    requestBody: { name, parents: [folderId] },
    media: { mimeType, body: createReadStream(localPath) },
    fields: 'id, name, webViewLink, webContentLink',
    supportsAllDrives: true,
  });
  try {
    await drive.permissions.create({
      fileId: res.data.id,
      requestBody: { role: 'reader', type: 'anyone' },
      supportsAllDrives: true,
    });
  } catch (e) { console.warn('Could not set public permission:', e.message); }
  return res.data;
}

function runScript(scriptPath, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [scriptPath], { cwd, env: process.env });
    let stderr = '';
    child.stdout.on('data', (d) => process.stdout.write(d));
    child.stderr.on('data', (d) => { stderr += d.toString(); process.stderr.write(d); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('render script exited with code ' + code + '\n' + stderr.slice(-4000)));
    });
  });
}

const app = express();
app.use(express.json({ limit: '5mb' }));
const rendered = new Map();

function checkAuth(req, res) {
  if (!RENDER_TOKEN) return true;
  const ok = (req.get('authorization') || '') === `Bearer ${RENDER_TOKEN}`;
  if (!ok) { res.status(401).json({ error: 'unauthorized' }); return false; }
  return true;
}

app.get('/', (_req, res) => res.json({ ok: true, service: 'railway-github-ffmpeg' }));
app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/render', async (req, res) => {
  if (!checkAuth(req, res)) return;
  const { topic_title, drive_folder_id } = req.body || {};
  if (!drive_folder_id) return res.status(400).json({ error: 'drive_folder_id is required' });

  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'render-'));
  console.log(`[render] topic="${topic_title || ''}" folder=${drive_folder_id} work=${work}`);
  try {
    const drive = driveClient();
    const files = await listFolder(drive, drive_folder_id);
    if (files.length === 0)
      return res.status(422).json({ error: 'drive folder is empty or not shared with the service account' });

    const shFiles = [];
    for (const f of files) {
      if (f.mimeType === 'application/vnd.google-apps.folder') continue;
      if (/^final_video.*\.mp4$/i.test(f.name)) continue;
      const dest = path.join(work, f.name);
      await downloadFile(drive, f.id, dest);
      if (/\.sh$/i.test(f.name) || /ffmpeg/i.test(f.name)) shFiles.push(f.name);
      console.log(`[render] downloaded ${f.name}`);
    }

    shFiles.sort();
    const scriptName = shFiles[shFiles.length - 1];
    if (!scriptName) return res.status(422).json({ error: 'no Documentary_FFmpeg_*.sh found in the folder' });
    console.log(`[render] running ${scriptName}`);
    await runScript(path.join(work, scriptName), work);

    const finalPath = path.join(work, 'final.mp4');
    try { await fs.access(finalPath); }
    catch { return res.status(500).json({ error: 'render finished but final.mp4 was not produced' }); }

    const outName = `final_video_${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}.mp4`;

    if (PUBLIC_BASE_URL) {
      const token = crypto.randomBytes(16).toString('hex');
      const keep = path.join(os.tmpdir(), `out-${token}.mp4`);
      await fs.copyFile(finalPath, keep);
      rendered.set(token, { path: keep, name: outName });
      const video_url = `${PUBLIC_BASE_URL}/file/${token}`;
      let drive_file_id = null;
      try { drive_file_id = (await uploadFile(drive, drive_folder_id, finalPath, outName, 'video/mp4')).id; }
      catch (e) { console.warn('Drive archive upload failed:', e.message); }
      return res.json({ video_url, file_name: outName, drive_file_id });
    }

    const up = await uploadFile(drive, drive_folder_id, finalPath, outName, 'video/mp4');
    const publicUrl = up.webContentLink || `https://drive.google.com/uc?export=download&id=${up.id}`;
    return res.json({ video_url: publicUrl, file_name: outName, drive_file_id: up.id });
  } catch (err) {
    console.error('[render] error:', err);
    return res.status(500).json({ error: err.message });
  } finally {
    fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
});

app.get('/file/:token', (req, res) => {
  const entry = rendered.get(req.params.token);
  if (!entry) return res.status(404).json({ error: 'not found or expired' });
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="${entry.name}"`);
  createReadStream(entry.path).on('error', () => res.status(500).end()).pipe(res);
});

app.listen(PORT, () => console.log(`railway-github-ffmpeg listening on :${PORT}`));
