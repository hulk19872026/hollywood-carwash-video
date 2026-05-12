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
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  CopyObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const PORT            = process.env.PORT || 3000;
const API_KEY         = process.env.ANTHROPIC_API_KEY;
const MODEL           = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
const MAX_TOKENS      = parseInt(process.env.MAX_TOKENS || '1500', 10);
const RETENTION_DAYS  = parseInt(process.env.RETENTION_DAYS || '30', 10);
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

// One-shot migration: pre-auth reports lived at reports/<id>/...; this moves
// them under reports/<owner>/<id>/... at startup so they show up for that
// user. Idempotent — runs every boot but only acts on un-migrated folders.
const MIGRATE_LEGACY_REPORTS_TO = (process.env.MIGRATE_LEGACY_REPORTS_TO || '').trim().toLowerCase();

const SESSION_TTL_MS  = 30 * 24 * 60 * 60 * 1000;
const COOKIE_NAME     = 'hcw_sess';
const SESSION_SECRET  = process.env.SESSION_SECRET || (() => {
  const s = crypto.randomBytes(32).toString('hex');
  console.warn('⚠️  SESSION_SECRET not set — generated an ephemeral secret. Sessions will be invalidated on every restart. Set SESSION_SECRET in env to make them persistent.');
  return s;
})();

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

function reportPrefix(username, reportId) {
  return `reports/${username}/${reportId}/`;
}

function r2KeyFor(username, reportId, kind, meta) {
  const m = meta || FILE_KIND[kind];
  if (!m) return null;
  return `${reportPrefix(username, reportId)}${reportId}${m.suffix}${m.ext}`;
}

// ============================================================
//  Auth — username/password with scrypt + HMAC-signed session cookies.
//  User records live at users/<username>.json in R2.
// ============================================================
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,30}$/;

function userKey(username) { return `users/${username}.json`; }

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('base64')}:${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  let salt, expected;
  try {
    salt     = Buffer.from(parts[1], 'base64');
    expected = Buffer.from(parts[2], 'base64');
  } catch { return false; }
  const actual = crypto.scryptSync(password, salt, expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function signSession(username) {
  const payload = JSON.stringify({ u: username, e: Date.now() + SESSION_TTL_MS });
  const b64 = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(b64).digest('hex');
  return `${b64}.${sig}`;
}

function verifySession(token) {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const b64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  // Strict hex validation: Buffer.from(_, 'hex') silently truncates at the
  // first non-hex character, which would otherwise let trailing junk through.
  if (!/^[0-9a-f]{64}$/.test(sig)) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(b64).digest('hex');
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')); } catch { return null; }
  if (typeof payload.u !== 'string' || typeof payload.e !== 'number' || payload.e < Date.now()) return null;
  return { username: payload.u };
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSessionCookie(req, res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: req.secure,
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

function authedUser(req) {
  return verifySession(parseCookies(req)[COOKIE_NAME]);
}

function requireAuth(req, res, next) {
  const u = authedUser(req);
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  req.user = u;
  next();
}

async function readUser(username) {
  if (!s3) return null;
  try {
    const got = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: userKey(username) }));
    const text = await got.Body.transformToString('utf8');
    return JSON.parse(text);
  } catch (e) {
    const code = e.$metadata?.httpStatusCode;
    if (e.name === 'NoSuchKey' || code === 404) return null;
    throw e;
  }
}

async function writeUser(record) {
  await s3.send(new PutObjectCommand({
    Bucket:      R2_BUCKET,
    Key:         userKey(record.username),
    Body:        JSON.stringify(record, null, 2),
    ContentType: 'application/json',
  }));
}

// ============================================================
//  Static pages
//  index.html and reports.html are versioned only by deploy SHA,
//  so keep them out of the browser cache — otherwise iOS Safari
//  serves stale JS for hours after a deploy.
// ============================================================
function noCache(res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
}
app.get('/', (_req, res) => { noCache(res); res.sendFile(path.join(__dirname, 'index.html')); });
app.get('/reports', (_req, res) => { noCache(res); res.sendFile(path.join(__dirname, 'reports.html')); });

// ============================================================
//  Auth routes
// ============================================================
app.post('/api/auth/register', async (req, res) => {
  if (!requireR2(res)) return;
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'bad_request' });
  }
  const u = username.trim().toLowerCase();
  if (!USERNAME_RE.test(u)) {
    return res.status(400).json({ error: 'bad_username', message: 'Use 2-31 characters: letters, digits, dot, dash, underscore. Must start with a letter or digit.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'weak_password', message: 'Password must be at least 6 characters.' });
  }
  try {
    if (await readUser(u)) return res.status(409).json({ error: 'taken', message: 'That username is already registered.' });
    await writeUser({ username: u, passwordHash: hashPassword(password), createdAt: new Date().toISOString() });
    setSessionCookie(req, res, signSession(u));
    res.json({ ok: true, username: u });
  } catch (e) {
    console.error('register failed:', e);
    res.status(500).json({ error: 'register_failed', message: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  if (!requireR2(res)) return;
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'bad_request' });
  }
  const u = username.trim().toLowerCase();
  try {
    const user = await readUser(u);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: 'invalid_credentials', message: 'Username or password is incorrect.' });
    }
    setSessionCookie(req, res, signSession(u));
    res.json({ ok: true, username: u });
  } catch (e) {
    console.error('login failed:', e);
    res.status(500).json({ error: 'login_failed', message: e.message });
  }
});

app.post('/api/auth/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const u = authedUser(req);
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  res.json({ username: u.username });
});

// Diagnostic endpoint — reports what the server sees for the current cookie
// and how many objects exist under reports/<username>/. No filesystem access,
// no cross-user data; safe to expose to logged-in users debugging their own
// state.
app.get('/api/auth/whoami', requireAuth, async (req, res) => {
  if (!requireR2(res)) return;
  const userPrefix = `reports/${req.user.username}/`;
  let folderCount = 0;
  let objectCount = 0;
  try {
    const top = await s3.send(new ListObjectsV2Command({
      Bucket: R2_BUCKET, Prefix: userPrefix, Delimiter: '/',
    }));
    folderCount = (top.CommonPrefixes || []).length;
    const all = await s3.send(new ListObjectsV2Command({
      Bucket: R2_BUCKET, Prefix: userPrefix,
    }));
    objectCount = (all.Contents || []).length;
  } catch (e) {
    return res.json({ username: req.user.username, prefix: userPrefix, error: e.message });
  }
  res.json({
    username:    req.user.username,
    prefix:      userPrefix,
    reportFolders: folderCount,
    objectCount,
  });
});

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
app.post('/api/presign-upload', requireAuth, async (req, res) => {
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
      const key = r2KeyFor(req.user.username, id, kind, meta);
      // Route the PUT through the server. Browsers never talk to R2
      // directly, so the upload doesn't depend on the bucket's CORS
      // policy lining up with whichever Railway domain is in use.
      uploads[kind] = {
        url:         `/api/proxy-upload/${encodeURIComponent(id)}/${encodeURIComponent(kind)}`,
        key,
        contentType: meta.contentType,
      };
    }
    res.json({ reportId: id, uploads });
  } catch (e) {
    console.error('presign-upload failed:', e);
    res.status(500).json({ error: 'presign_failed', message: e.message });
  }
});

// ============================================================
//  PUT /api/proxy-upload/:reportId/:kind
//  Streams the request body straight to R2 under the caller's user
//  prefix. Same-origin, so no R2 CORS preflight is involved.
// ============================================================
app.put('/api/proxy-upload/:reportId/:kind', requireAuth, async (req, res) => {
  if (!requireR2(res)) return;
  try {
    const id   = sanitize(req.params.reportId);
    const kind = String(req.params.kind || '');
    const mime = req.headers['content-type'];
    const meta = resolveKindMeta(kind, mime);
    if (!meta) return res.status(400).json({ error: 'bad_kind', message: `unknown kind: ${kind}` });
    const contentLength = parseInt(req.headers['content-length'] || '0', 10);
    if (!contentLength) {
      return res.status(411).json({ error: 'length_required', message: 'Content-Length header required' });
    }
    const key = r2KeyFor(req.user.username, id, kind, meta);
    await s3.send(new PutObjectCommand({
      Bucket:        R2_BUCKET,
      Key:           key,
      Body:          req,
      ContentType:   meta.contentType,
      ContentLength: contentLength,
    }));
    res.json({ ok: true, key });
  } catch (e) {
    console.error('proxy-upload failed:', e);
    res.status(500).json({ error: 'upload_failed', message: e.message });
  }
});

// ============================================================
//  POST /api/finalize-report
//  Body: { reportId, metadata, uploadedKeys }
//  Writes metadata.json into the report folder in R2.
// ============================================================
app.post('/api/finalize-report', requireAuth, async (req, res) => {
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
      owner: req.user.username,
      uploadedKeys: uploadedKeys || {},
      finalizedAt: new Date().toISOString(),
    }, null, 2);
    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: `${reportPrefix(req.user.username, id)}metadata.json`,
      Body: body,
      ContentType: 'application/json',
    }));
    console.log(`✓ Finalized report ${id} for ${req.user.username}`);
    res.json({ ok: true, reportId: id });
  } catch (e) {
    console.error('finalize-report failed:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================================
//  GET /api/reports — list saved inspections from R2
// ============================================================
app.get('/api/reports', requireAuth, async (req, res) => {
  if (!requireR2(res)) return;
  try {
    const userPrefix = `reports/${req.user.username}/`;
    console.log(`list reports for ${req.user.username} (prefix=${userPrefix})`);
    const top = await s3.send(new ListObjectsV2Command({
      Bucket: R2_BUCKET,
      Prefix: userPrefix,
      Delimiter: '/',
    }));
    const ids = (top.CommonPrefixes || [])
      .map(p => p.Prefix.replace(userPrefix, '').replace(/\/$/, ''))
      .filter(Boolean);

    const reports = [];
    for (const id of ids) {
      const folder = `${userPrefix}${id}/`;
      let metadata = null;
      let createdAt = null;
      try {
        const got = await s3.send(new GetObjectCommand({
          Bucket: R2_BUCKET,
          Key: `${folder}metadata.json`,
        }));
        const text = await got.Body.transformToString('utf8');
        metadata = JSON.parse(text);
        createdAt = metadata.timestamp || metadata.finalizedAt || null;
      } catch {}

      let files = [];
      try {
        const inner = await s3.send(new ListObjectsV2Command({
          Bucket: R2_BUCKET,
          Prefix: folder,
        }));
        files = (inner.Contents || [])
          .map(c => c.Key.slice(folder.length))
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
    console.log(`  -> ${reports.length} reports for ${req.user.username}`);
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
app.get('/api/reports/:id/:file', requireAuth, async (req, res) => {
  if (!requireR2(res)) return;
  try {
    const id   = sanitize(req.params.id);
    const file = sanitize(req.params.file);
    const url  = await getSignedUrl(s3, new GetObjectCommand({
      Bucket: R2_BUCKET,
      Key: `${reportPrefix(req.user.username, id)}${file}`,
    }), { expiresIn: 600 });
    res.redirect(302, url);
  } catch (e) {
    console.error('presign-get failed:', e);
    res.status(404).end();
  }
});

// ============================================================
//  Retention sweep — delete report folders older than RETENTION_DAYS
// ============================================================
async function pruneFolder(folderPrefix, cutoff) {
  const inner = await s3.send(new ListObjectsV2Command({
    Bucket: R2_BUCKET,
    Prefix: folderPrefix,
  }));
  const contents = inner.Contents || [];
  if (!contents.length) return { deleted: false, count: 0 };

  let folderTime = null;
  const metaObj = contents.find(c => c.Key.endsWith('/metadata.json'));
  if (metaObj) {
    try {
      const got = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: metaObj.Key }));
      const text = await got.Body.transformToString('utf8');
      const j = JSON.parse(text);
      const ts = j.timestamp || j.finalizedAt;
      if (ts) folderTime = Date.parse(ts);
    } catch {}
  }
  if (!folderTime) {
    const newest = contents.map(c => c.LastModified ? +new Date(c.LastModified) : 0).sort((a, b) => b - a)[0];
    folderTime = newest || null;
  }
  if (!folderTime || folderTime > cutoff) return { deleted: false, count: 0 };

  const result = await s3.send(new DeleteObjectsCommand({
    Bucket: R2_BUCKET,
    Delete: { Objects: contents.map(c => ({ Key: c.Key })), Quiet: true },
  }));
  if (result.Errors && result.Errors.length) {
    console.error(`prune ${folderPrefix} partial errors:`, result.Errors);
  }
  console.log(`✓ Pruned ${folderPrefix} (${contents.length} objects)`);
  return { deleted: true, count: contents.length };
}

async function pruneOldReports() {
  if (!R2_READY) return;
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let deletedFolders = 0;
  let deletedObjects = 0;
  try {
    const top = await s3.send(new ListObjectsV2Command({
      Bucket: R2_BUCKET,
      Prefix: 'reports/',
      Delimiter: '/',
    }));
    const folders = (top.CommonPrefixes || []).map(p => p.Prefix);

    for (const folder of folders) {
      try {
        // Detect new format (reports/<user>/<id>/) vs legacy (reports/<id>/)
        // by looking one level deeper for sub-folders.
        const sub = await s3.send(new ListObjectsV2Command({
          Bucket: R2_BUCKET,
          Prefix: folder,
          Delimiter: '/',
        }));
        const subfolders = (sub.CommonPrefixes || []).map(p => p.Prefix);
        const targets = subfolders.length ? subfolders : [folder];

        for (const target of targets) {
          try {
            const r = await pruneFolder(target, cutoff);
            if (r.deleted) { deletedFolders++; deletedObjects += r.count; }
          } catch (e) {
            console.error(`prune ${target} failed:`, e.message);
          }
        }
      } catch (e) {
        console.error(`prune scan ${folder} failed:`, e.message);
      }
    }
    if (deletedFolders) {
      console.log(`★ Retention sweep: removed ${deletedFolders} folders / ${deletedObjects} objects (>${RETENTION_DAYS}d)`);
    }
  } catch (e) {
    console.error('pruneOldReports failed:', e);
  }
}

// ============================================================
//  One-shot migration: move legacy reports/<id>/* under reports/<owner>/<id>/*
// ============================================================
async function migrateLegacyReports(owner) {
  if (!R2_READY) return;
  if (!USERNAME_RE.test(owner)) {
    console.warn(`migrate-legacy: invalid owner "${owner}", skipping`);
    return;
  }
  let migrated = 0;
  let skipped  = 0;
  try {
    const [topReports, knownUsers] = await Promise.all([
      s3.send(new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: 'reports/', Delimiter: '/' })),
      s3.send(new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: 'users/' })),
    ]);
    const usernames = new Set(
      (knownUsers.Contents || [])
        .map(c => c.Key.match(/^users\/([^/]+)\.json$/)?.[1])
        .filter(Boolean)
    );
    const legacyFolders = (topReports.CommonPrefixes || [])
      .map(p => p.Prefix)
      .filter(prefix => {
        const id = prefix.replace(/^reports\//, '').replace(/\/$/, '');
        return id && !usernames.has(id);
      });

    if (!legacyFolders.length) {
      console.log(`migrate-legacy: nothing to do for owner=${owner}`);
      return;
    }

    for (const folder of legacyFolders) {
      const id = folder.replace(/^reports\//, '').replace(/\/$/, '');
      const destPrefix = `reports/${owner}/${id}/`;
      try {
        const inner = await s3.send(new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: folder }));
        const objects = inner.Contents || [];
        if (!objects.length) { skipped++; continue; }

        for (const obj of objects) {
          const rel  = obj.Key.slice(folder.length);
          const dest = `${destPrefix}${rel}`;
          await s3.send(new CopyObjectCommand({
            Bucket:     R2_BUCKET,
            Key:        dest,
            CopySource: `/${R2_BUCKET}/${encodeURIComponent(obj.Key).replace(/%2F/g, '/')}`,
          }));
        }
        await s3.send(new DeleteObjectsCommand({
          Bucket: R2_BUCKET,
          Delete: { Objects: objects.map(o => ({ Key: o.Key })), Quiet: true },
        }));
        console.log(`✓ migrated ${folder} -> ${destPrefix} (${objects.length} objects)`);
        migrated++;
      } catch (e) {
        console.error(`migrate-legacy ${folder} failed:`, e.message);
      }
    }
    console.log(`★ migrate-legacy: ${migrated} folder(s) moved to reports/${owner}/, ${skipped} skipped`);
  } catch (e) {
    console.error('migrateLegacyReports failed:', e);
  }
}

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

const BUILD_TAG = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) || 'BUILD-CHECK-A1B2C3';

app.get('/api/version', (_req, res) => {
  res.json({
    build: BUILD_TAG,
    branch: process.env.RAILWAY_GIT_BRANCH || null,
    deployedAt: new Date().toISOString(),
  });
});

// ============================================================
//  404 + error handlers (must be registered last so real routes win)
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n★ Hollywood Car Wash listening on 0.0.0.0:${PORT}`);
  console.log(`★ Build: ${BUILD_TAG}`);
  console.log(`★ R2 ready: ${R2_READY}${R2_READY ? ` (${R2_BUCKET})` : ''}`);
  console.log(`★ Anthropic key: ${!!API_KEY}`);
  console.log(`★ Retention: ${RETENTION_DAYS} days\n`);

  if (R2_READY) {
    if (MIGRATE_LEGACY_REPORTS_TO) migrateLegacyReports(MIGRATE_LEGACY_REPORTS_TO);
    pruneOldReports();
    setInterval(pruneOldReports, PRUNE_INTERVAL_MS);
  }
});
