# YT2TXT — Video to Transcript

Chrome Manifest V3 extension + FastAPI backend that extracts transcripts from YouTube and any [yt-dlp](https://github.com/yt-dlp/yt-dlp)-supported site. Three-tab UI: Transcript → Format → Translation.

**Two paths for extraction:**
1. **Native subtitles available** → downloaded directly via yt-dlp (fast, free).
2. **No subtitles** → audio is downloaded and transcribed via OpenAI-compatible API (`gpt-4o-transcribe` or `gpt-4o-min-transcribe`).

Transcripts are cached in SQLite — instant return on repeat requests.

## Backends

YT2TXT uses **three backends**:

| Backend | Default Port | Purpose |
|---------|-------------|---------|
| **YT2TXT** | `8666` | Transcript extraction, caching |
| **TextKit** | `8765` | Formatting, translation |
| **File Bridge** | `8964` | Save to disk, path autocomplete |

## Prerequisites

- Python 3.10+
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) (`pip install yt-dlp`)
- ffmpeg (for audio splitting on long videos and local-file audio extraction)
- Chrome or Chromium browser
- OpenAI-compatible API key (for transcription; free if video has subtitles)
- [TextKit](https://github.com/hyperdreamer/textkit) backend (for Format and Translation tabs)
- [File Bridge](https://github.com/hyperdreamer/file-bridge) backend (for Save and path autocomplete)

## Setup

### 1. Backend

```bash
cd backend
pip install -r requirements.txt
```

### 2. Configuration

```bash
cp config.example.yaml config.yaml
```

Edit `config.yaml`:

```yaml
ai:
  api_key: "$OPENAI_API_KEY"   # or set the OPENAI_API_KEY env var
  api_base: "https://api.openai.com"
  model: "gpt-4o-transcribe"   # or gpt-4o-min-transcribe

  # Per-phase HTTP timeouts for the transcription API (all in seconds).
  # Omit to use defaults: connect=10, read=600, write=60, pool=10.
  # timeout:
  #   connect: 10
  #   read: 600
  #   write: 60
  #   pool: 10

cache:
  enabled: true
  ttl_days: 30

# Optional: restrict which local paths the backend may read.
# Empty (the default) means unrestricted.
local_files:
  allowed_roots: []
```

Or export the environment variable:

```bash
export OPENAI_API_KEY="sk-..."
```

### 3. Start the backends

```bash
# Terminal 1 — YT2TXT backend (port 8666)
cd backend && python main.py

# Terminal 2 — TextKit backend (port 8765)
# See textkit repo for setup

# Terminal 3 — File Bridge backend (port 8964)
# See file-bridge repo for setup
```

### 4. Load the extension

1. Open Chrome and navigate to `chrome://extensions`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked" and select the `extension/` directory
4. The YT2TXT icon appears in the toolbar

## Usage

### Transcript tab

1. Navigate to a video page (YouTube, Vimeo, etc.)
2. Click the YT2TXT icon — the current page URL is pre-filled
3. Optionally check **Force refresh** to bypass cache
4. Click **Get Transcript**
5. Copy or download the result

### Local video files

1. Open the video file in Chrome (a `file:///…` tab) or leave the tab anywhere
2. Click the YT2TXT icon — a `file://` tab URL is pre-filled automatically; otherwise paste the
   absolute path (or `~`-path) of the video
3. The source chip under the URL box confirms the input was recognised (`Local file · <name>`)
4. Click **Get Transcript** — sidecar/embedded subtitles are used when present, otherwise the audio
   is extracted with ffmpeg and transcribed

No Chrome file-access toggle is required: the extension only forwards the path string, and the
backend (which runs as your user) is the only component that reads the file. Set
`local_files.allowed_roots` in `backend/config.yaml` to restrict which paths the backend may read.

### Format tab

- Click **Format** to clean up the transcript via TextKit
- Toggle **Auto-copy** / **Auto-save** for automatic handling

### Translation tab

- Select target language from the dropdown
- Click **Translate** to translate the transcript via TextKit
- **Auto-translate**: when enabled, translation fires automatically after format completes

### Auto-action chain

```
Get Transcript → Format (auto) → Translate (auto, if enabled)
```

All auto-actions show desktop notifications with results. Format and translation results survive popup close and service worker restart.

### Keyboard shortcut

Press **Ctrl+Shift+T** (Mac: **Cmd+Shift+T**) on any video page to start transcript extraction immediately.

### Settings

Click the ⚙ gear icon to configure both backend addresses. TextKit host auto-fills from YT2TXT host when empty (common single-machine case).

## Backend endpoints

### `GET /health`
Returns `{"status": "ok"}`.

### `POST /transcript`
```json
{
  "url": "https://www.youtube.com/watch?v=...",
  "model": "gpt-4o-transcribe",  // optional, defaults to config
  "force": false                  // optional, bypass cache
}
```

Response:
```json
{
  "text": "...transcript...",
  "source": "subtitles",       // or "transcription"
  "model": "yt-dlp",           // or "gpt-4o-transcribe", or "cached"
  "error": null
}
```

## Architecture

```
extension/            ← Chrome MV3 extension
  manifest.json
  background.js       ← service worker (all API calls)
  popup.html          ← three-tab UI (Transcript | Format | Translation)
  popup.js            ← UI logic, delegates to background via messages
  offscreen.html      ← offscreen document for clipboard access
  offscreen.js        ← clipboard handler
  icons/              ← icon16/48/128.png

backend/              ← FastAPI backend
  main.py             ← FastAPI app with /transcript and /health
  local_file.py       ← local-file pipeline (classification, subtitles, ffmpeg)
  config.yaml         ← live config (gitignored)
  config.example.yaml ← committed template
  transcript_cache.db ← SQLite cache (gitignored)
  requirements.txt    ← Python dependencies
  start.sh            ← convenience launcher
```

The extension never calls `fetch()` from the popup — all API requests go through the background service worker, which survives popup closes. State propagates via `chrome.runtime.sendMessage`.
