// ============================================================
//  Hollywood Car Wash — Inspection Server
//  Serves the inspection app, proxies AI calls to Anthropic,
//  and saves PDF + video reports to disk.
// ============================================================
import express from 'express';
import multer from 'multer';
import { promises as fs, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const PORT       = process.env.PORT || 3000;
const REPORT_DIR = process.env.REPORT_DIR || path.join(__dirname, 'reports');
const API_KEY    = process.env.ANTHROPIC_API_KEY;
const MODEL      = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || '1500', 10);

if (!API_KEY) {
  console.warn('⚠️  ANTHROPIC_API_KEY is not set. /api/analyze will fail until you set it.');
}

mkdirSync(REPORT_DIR, { recursive: true });
console.log('★ Report directory:', REPORT_DIR);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '20mb' }));

app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

// ============================================================
//  GET / — serve the inspection app
// ============================================================
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 250 * 1024 * 1024 }, // 250MB per file
});

// ----- helpers -----
function sanitize(s) {
  return String(s || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'unnamed';
}
function safeJoin(base, ...parts) {
  const fp = path.join(base, ...parts);
  const resolved = path.resolve(fp);
  if (!resolved.startsWith(path.resolve(base))) {
    throw new Error('Path traversal blocked');
  }
  return resolved;
}

// ============================================================
//  POST /api/analyze
//  Proxies the inspection app's vision request to Anthropic.
// ============================================================
app.post('/api/analyze', async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({
      error: { type: 'config_error', message: 'Server is missing ANTHROPIC_API_KEY env var' }
    });
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
//  POST /api/save-report
//  Multipart upload: pdf + exterior video + interior video + metadata json
// ============================================================
app.post('/api/save-report',
  upload.fields([
    { name: 'pdf',      maxCount: 1 },
    { name: 'exterior', maxCount: 1 },
    { name: 'interior', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const reportId = sanitize(req.body.reportId || ('REPORT-' + Date.now()));
      const dir = safeJoin(REPORT_DIR, reportId);
      await fs.mkdir(dir, { recursive: true });

      const saved = [];
      const fileMap = {
        pdf:      reportId + '.pdf',
        exterior: reportId + '_exterior.webm',
        interior: reportId + '_interior.webm',
      };
      for (const [field, name] of Object.entries(fileMap)) {
        const f = (req.files[field] || [])[0];
        if (f) {
          await fs.writeFile(safeJoin(dir, name), f.buffer);
          saved.push(name);
        }
      }
      if (req.body.metadata) {
        try {
          const parsed = JSON.parse(req.body.metadata);
          await fs.writeFile(safeJoin(dir, 'metadata.json'), JSON.stringify(parsed, null, 2));
          saved.push('metadata.json');
        } catch {
          await fs.writeFile(safeJoin(dir, 'metadata.txt'), String(req.body.metadata));
          saved.push('metadata.txt');
        }
      }

      console.log(`✓ Saved report ${reportId} (${saved.length} files)`);
      res.json({ ok: true, reportId, dir: path.relative(__dirname, dir), saved });
    } catch (e) {
      console.error('Save failed:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  }
);

// ============================================================
//  GET /api/reports — list saved inspections
// ============================================================
app.get('/api/reports', async (_req, res) => {
  try {
    const entries = await fs.readdir(REPORT_DIR, { withFileTypes: true });
    const reports = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = safeJoin(REPORT_DIR, e.name);
      const stat = await fs.stat(dir);
      const files = await fs.readdir(dir);
      let metadata = null;
      if (files.includes('metadata.json')) {
        try {
          metadata = JSON.parse(await fs.readFile(safeJoin(dir, 'metadata.json'), 'utf8'));
        } catch {}
      }
      reports.push({
        id: e.name,
        createdAt: stat.mtime.toISOString(),
        files,
        metadata,
      });
    }
    reports.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json({ reports, count: reports.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
//  GET /api/reports/:id/:file — download a specific report file
// ============================================================
app.get('/api/reports/:id/:file', async (req, res) => {
  try {
    const id   = sanitize(req.params.id);
    const file = sanitize(req.params.file);
    const fp   = safeJoin(REPORT_DIR, id, file);
    res.sendFile(fp);
  } catch (e) {
    res.status(404).end();
  }
});

// ============================================================
//  GET /reports — simple browser-friendly listing page
// ============================================================
app.get('/reports', (_req, res) => {
  res.sendFile(path.join(__dirname, 'reports.html'));
});

// ============================================================
//  Health check
// ============================================================
app.get('/health', (_req, res) => {
  res.json({ ok: true, hasKey: !!API_KEY, model: MODEL, reportDir: REPORT_DIR });
});

// ============================================================
//  404 fallback — last route, after every real handler
// ============================================================
app.use((req, res) => {
  res.status(404).json({ error: 'not_found', path: req.url });
});

// ============================================================
//  Error handler
// ============================================================
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'internal_error', message: err.message });
});

process.on('unhandledRejection', (r) => console.error('unhandledRejection', r));
process.on('uncaughtException', (e) => console.error('uncaughtException', e));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n★ Hollywood Car Wash listening on 0.0.0.0:${PORT}`);
  console.log(`★ Health  /health`);
  console.log(`★ Reports /reports\n`);
});
