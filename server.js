// ============================================================
//  Hollywood Car Wash — Inspection Server
//  Serves the inspection app, proxies AI calls to Anthropic,
//  and brokers direct-to-R2 uploads via presigned URLs.
//
//  Required env vars on Railway:
//    ANTHROPIC_API_KEY     - for /api/analyze
//    R2_ACCESS_KEY_ID      - R2 access key
//    R2_SECRET_ACCESS_KEY  - R2 secret
//    R2_BUCKET             - R2 bucket name
//    R2_ACCOUNT_ID         - Cloudflare account ID (or use R2_ENDPOINT)
//  Optional:
//    R2_ENDPOINT           - full R2 endpoint URL (overrides R2_ACCOUNT_ID,
//                            needed for EU jurisdiction buckets)
//    ANTHROPIC_MODEL, MAX_TOKENS, PORT
// ============================================================
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const PORT       = process.env.PORT || 3000;
const API_KEY    = process.env.ANTHROPIC_API_KEY;
const MODEL      = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || '1500', 10);

const R2_ACCOUNT_ID        = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID     = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET            = process.env.R2_BUCKET;
const R2_ENDPOINT          = process.env.R2_ENDPOINT
  || (R2_ACCOUNT_ID ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : null);
const R2_READY = !!(R2_ENDPOINT && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET);

if (!API_KEY)  console.warn('⚠️  ANTHROPIC_API_KEY is not set. /api/analyze will fail.');
if (!R2_READY) console.warn('⚠️  R2 env vars missing. Upload + reports endpoints will return 500.');

let s3 = null;
if (R2_READY) {
  s3 = new S3Client({
    region: 'auto',
    endpoint: R2_ENDPOINT,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '20mb' }));

app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

// ----- helpers -----
function sanitize(s) {
  return String(s || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'unnamed';
}

function requireR2(res) {
  if (!R2_READY) {
    res.status(500).json({ error: 'r2_not_configured', message: 'Server is missing R2 env vars' });
    return false;
  }
  return true;
}

const FILE_KIND = {
  pdf:      { suffix: '',          contentType: 'application/pdf', ext: '.pdf'  },
  video:    { suffix: '',          contentType: 'video/webm',      ext: '.webm' },
  // Legacy kinds — older queued jobs may still reference these.
  exterior: { suffix: '_exterior', contentType: 'video/webm',      ext: '.webm' },
  interior: { suffix: '_interior', contentType: 'video/webm',      ext: '.webm' },
};

const VIDEO_MIME_EXT = {
  'video/mp4':  '.mp4',
  'video/webm': '.webm',
};

function resolveKindMeta(kind, requestedMime) {
  const base = FILE_KIND[kind];
  if (!base) return null;
  if (kind === 'pdf' || !requestedMime) return base;
  const m = String(requestedMime).split(';')[0].trim().toLowerCase();
  const ext = VIDEO_MIME_EXT[m];
  if (!ext) return base;
  return { suffix: base.suffix, contentType: m, ext };
}

function r2KeyFor(reportId, kind, meta) {
  const m = meta || FILE_KIND[kind];
  if (!m) return null;
  return `reports/${reportId}/${reportId}${m.suffix}${m.ext}`;
}

// ============================================================
//  Static pages
// ============================================================
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/reports', (_req, res) => res.sendFile(path.join(__dirname, 'reports.html')));

// ============================================================
//  POST /api/analyze — Anthropic vision proxy
// ============================================================
app.post('/api/analyze', async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({ error: { type: 'config_error', message: 'Server is missing ANTHROPIC_API_KEY env var' } });
  }
  if (!req.body || !Array.isArray(req.body.messages)) {
    return res.status(400).json({ error: { type: 'bad_request', message: 'messages array required' } });
  }
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: req.body.messages,
      }),
    });
    const data = await r.json();
    return res.status(r.status).json(data);
  } catch (e) {
    console.error('Anthropic call failed:', e);
    return res.status(500).json({ error: { type: 'upstream_error', message: e.message } });
  }
});

// ============================================================
//  POST /api/presign-upload
//  Body: { reportId, files: ['pdf','exterior','interior'] }
//  Returns presigned PUT URLs the client uploads to directly.
// ============================================================
app.post('/api/presign-upload', async (req, res) => {
  if (!requireR2(res)) return;
  try {
    const { reportId, files, mimes } = req.body || {};
    if (!reportId || !Array.isArray(files) || !files.length) {
      return res.status(400).json({ error: 'bad_request', message: 'reportId and files[] required' });
    }
    const id = sanitize(reportId);
    const uploads = {};
    for (const kind of files) {
      const meta = resolveKindMeta(kind, mimes && mimes[kind]);
      if (!meta) continue;
      const key = r2KeyFor(id, kind, meta);
      const cmd = new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        ContentType: meta.contentType,
      });
      const url = await getSignedUrl(s3, cmd, { expiresIn: 3600 });
      uploads[kind] = { url, key, contentType: meta.contentType };
    }
    res.json({ reportId: id, uploads });
  } catch (e) {
    console.error('presign-upload failed:', e);
    res.status(500).json({ error: 'presign_failed', message: e.message });
  }
});

// ============================================================
//  POST /api/finalize-report
//  Body: { reportId, metadata, uploadedKeys }
//  Writes metadata.json into the report folder in R2.
// ============================================================
app.post('/api/finalize-report', async (req, res) => {
  if (!requireR2(res)) return;
  try {
    const { reportId, metadata, uploadedKeys } = req.body || {};
    if (!reportId || !metadata) {
      return res.status(400).json({ error: 'bad_request', message: 'reportId and metadata required' });
    }
    const id = sanitize(reportId);
    const body = JSON.stringify({
      ...metadata,
      reportId: id,
      uploadedKeys: uploadedKeys || {},
      finalizedAt: new Date().toISOString(),
    }, null, 2);
    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: `reports/${id}/metadata.json`,
      Body: body,
      ContentType: 'application/json',
    }));
    console.log(`✓ Finalized report ${id}`);
    res.json({ ok: true, reportId: id });
  } catch (e) {
    console.error('finalize-report failed:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================================
//  GET /api/reports — list saved inspections from R2
// ============================================================
app.get('/api/reports', async (_req, res) => {
  if (!requireR2(res)) return;
  try {
    const top = await s3.send(new ListObjectsV2Command({
      Bucket: R2_BUCKET,
      Prefix: 'reports/',
      Delimiter: '/',
    }));
    const ids = (top.CommonPrefixes || [])
      .map(p => p.Prefix.replace(/^reports\//, '').replace(/\/$/, ''))
      .filter(Boolean);

    const reports = [];
    for (const id of ids) {
      let metadata = null;
      let createdAt = null;
      try {
        const got = await s3.send(new GetObjectCommand({
          Bucket: R2_BUCKET,
          Key: `reports/${id}/metadata.json`,
        }));
        const text = await got.Body.transformToString('utf8');
        metadata = JSON.parse(text);
        createdAt = metadata.timestamp || metadata.finalizedAt || null;
      } catch {}

      let files = [];
      try {
        const inner = await s3.send(new ListObjectsV2Command({
          Bucket: R2_BUCKET,
          Prefix: `reports/${id}/`,
        }));
        files = (inner.Contents || [])
          .map(c => c.Key.slice(`reports/${id}/`.length))
          .filter(f => f && f !== 'metadata.json');
        if (!createdAt) {
          const newest = (inner.Contents || [])
            .map(c => c.LastModified)
            .filter(Boolean)
            .sort((a, b) => b - a)[0];
          if (newest) createdAt = new Date(newest).toISOString();
        }
      } catch {}

      reports.push({ id, createdAt, files, metadata });
    }

    reports.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    res.json({ reports, count: reports.length });
  } catch (e) {
    console.error('list reports failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
//  GET /api/reports/:id/:file
//  Redirects to a short-lived presigned R2 GET URL.
// ============================================================
app.get('/api/reports/:id/:file', async (req, res) => {
  if (!requireR2(res)) return;
  try {
    const id   = sanitize(req.params.id);
    const file = sanitize(req.params.file);
    const url  = await getSignedUrl(s3, new GetObjectCommand({
      Bucket: R2_BUCKET,
      Key: `reports/${id}/${file}`,
    }), { expiresIn: 600 });
    res.redirect(302, url);
  } catch (e) {
    console.error('presign-get failed:', e);
    res.status(404).end();
  }
});

// ============================================================
//  Health check
// ============================================================
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    hasAnthropicKey: !!API_KEY,
    r2Ready: R2_READY,
    bucket: R2_READY ? R2_BUCKET : null,
    model: MODEL,
  });
});

// ============================================================
//  404 + error handlers
// ============================================================
app.use((req, res) => {
  res.status(404).json({ error: 'not_found', path: req.url });
});

app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'internal_error', message: err.message });
});

process.on('unhandledRejection', (r) => console.error('unhandledRejection', r));
process.on('uncaughtException',  (e) => console.error('uncaughtException', e));

const BUILD_TAG = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) || 'BUILD-CHECK-A1B2C3';

app.get('/api/version', (_req, res) => {
  res.json({
    build: BUILD_TAG,
    branch: process.env.RAILWAY_GIT_BRANCH || null,
    deployedAt: new Date().toISOString(),
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n★ Hollywood Car Wash listening on 0.0.0.0:${PORT}`);
  console.log(`★ Build: ${BUILD_TAG}`);
  console.log(`★ R2 ready: ${R2_READY}${R2_READY ? ` (${R2_BUCKET})` : ''}`);
  console.log(`★ Anthropic key: ${!!API_KEY}\n`);
});
