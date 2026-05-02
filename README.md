# 🎬 Hollywood Car Wash — Inspection App

A vehicle inspection tool for car washes. Tech records exterior and interior video on a phone or tablet, AI scans for dents and scratches, reads the license plate, and drops a PDF report into a folder.

![Stack](https://img.shields.io/badge/stack-Node.js%20%2B%20Express-black?style=flat-square&color=FFD400)
![Deploy](https://img.shields.io/badge/deploy-Railway-black?style=flat-square&color=E10600)

## What it does

1. Tech taps **Start Inspection**, fills in their name and the bay number.
2. Records a walk-around video of the **exterior** (showing all four sides + license plate).
3. Records the **interior** (front seats, rear seats, dashboard, trunk).
4. Taps **Send & Analyze** — frames are extracted and sent to Claude vision AI.
5. AI identifies visible dents/scratches, reads the plate, judges interior condition.
6. A PDF report is generated with findings, frame appendix, and metadata.
7. PDF + both videos are saved to the server's report folder *and* (optionally) to a local folder on the device.

Every saved inspection is browseable at `/reports`.

## Architecture

```
┌──────────────┐      ┌────────────────────┐      ┌───────────┐
│  Tech tablet │◄────►│ Express server     │◄────►│ Anthropic │
│  (browser)   │      │ - serves index.html│      │ API       │
│              │      │ - /api/analyze     │      └───────────┘
│  records     │      │ - /api/save-report │
│  video       │      │ - /api/reports     │
└──────────────┘      └─────────┬──────────┘
                                │
                                ▼
                       ┌──────────────────┐
                       │ /data/reports    │ ◄── Railway Volume
                       │   HCW-2026.../   │     (persistent)
                       │     report.pdf   │
                       │     exterior.webm│
                       │     interior.webm│
                       │     metadata.json│
                       └──────────────────┘
```

The Anthropic API key lives **only on the server** — the browser never sees it.

## Quick start (local)

Requires Node.js 20+.

```bash
# 1. Install dependencies
npm install

# 2. Create your .env file
cp .env.example .env
# then edit .env and paste your Anthropic API key

# 3. Run it
npm start
```

Open `http://localhost:3000` and you're inspecting cars. Reports save to `./reports/`.

## Deploy to Railway

### 1. Push this code to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/hollywood-car-wash.git
git push -u origin main
```

### 2. Create a Railway project

1. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
2. Pick the `hollywood-car-wash` repo
3. Railway auto-detects Node.js and starts building

### 3. Set environment variables

In the Railway project → **Variables** tab, add:

| Variable | Value | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-...` | Required. Get one from [console.anthropic.com](https://console.anthropic.com/) |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-20250514` | Optional. Default works. |
| `REPORT_DIR` | `/data/reports` | Required for persistent storage (see step 4) |

### 4. Add a Volume for persistent reports

By default, Railway containers have ephemeral storage — every redeploy wipes saved reports. To keep them:

1. In your Railway service → **Settings** → **Volumes** → **+ New Volume**
2. Mount path: `/data`
3. Save

Combined with `REPORT_DIR=/data/reports`, every inspection persists across deploys and restarts.

### 5. Generate a public URL

In the Railway service → **Settings** → **Networking** → **Generate Domain**.

You'll get a URL like `hollywood-car-wash.up.railway.app`. Open it on your shop's tablet and bookmark it.

## URLs

Once deployed, your app exposes:

| Path | What |
|---|---|
| `/` | Inspection app (tech-facing) |
| `/reports` | Browse all saved inspections |
| `/api/analyze` | (POST) AI proxy — used by frontend |
| `/api/save-report` | (POST) save PDF + videos — used by frontend |
| `/api/reports` | (GET) JSON list of all reports |
| `/api/reports/:id/:file` | (GET) download a specific file |
| `/health` | Server health check |

## Project structure

```
hollywood-car-wash/
├── server.js            # Express server (AI proxy + report storage)
├── package.json
├── railway.json         # Railway build/deploy config
├── .env.example         # Environment variable template
├── .gitignore
├── README.md
└── public/
    ├── index.html       # The inspection app (tech-facing UI)
    └── reports.html     # Reports browser
```

## Notes & limitations

**Browser support.** The inspection app uses `MediaRecorder` and `getUserMedia`. Works great in Chrome, Edge, and Safari on modern devices. The optional "save to local folder" feature uses the File System Access API (Chrome/Edge only) — Safari and Firefox fall back to download.

**Plate registration lookup.** The app extracts the plate number, state, and a confidence score from the video. Pulling the actual *owner registration* requires a paid DMV/data-broker API (NMVTIS providers, LicensePlateLookup.org, etc.). To wire one in, add another env var (`DMV_API_KEY`) and a route in `server.js` that calls your provider after the plate is read.

**File sizes.** Each inspection saves ~10–50MB (two videos + a PDF). At 50 inspections/day on a 5GB volume, that's roughly two months of storage. Expand the volume size in Railway if needed, or add a cleanup job.

**Anthropic costs.** Each inspection calls the Anthropic API twice (exterior + interior) with ~5 frames each. At Claude Sonnet 4 prices and ~150KB JPEGs, expect a few cents per inspection. Watch your usage at [console.anthropic.com](https://console.anthropic.com/).

**Authentication.** This app has no login — anyone with the URL can run inspections (and burn your Anthropic credits). Before going live, put it behind:
- Cloudflare Access (free, easy)
- Railway's built-in HTTP basic auth (paid plans)
- A `BASIC_AUTH_PASSWORD` env var + middleware in `server.js` (DIY)

## Customization

- **Branding:** edit the CSS variables `--yellow`, `--red`, `--black` at the top of `public/index.html` and `public/reports.html`.
- **Prompts:** the AI inspection logic lives in `EXTERIOR_PROMPT` and `INTERIOR_PROMPT` inside `public/index.html`. Tweak them to match what your business cares about (specific damage thresholds, missing trim, tire condition, etc.).
- **Report layout:** the PDF is generated by `buildPdf()` in `public/index.html` using jsPDF. Add your shop logo, change the header colors, add disclaimer text, etc.

## License

MIT
