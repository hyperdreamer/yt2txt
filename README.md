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
- ffmpeg (for audio splitting on long videos)
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

cache:
  enabled: true
  ttl_days: 30
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
  config.yaml         ← live config (gitignored)
  config.example.yaml ← committed template
  transcript_cache.db ← SQLite cache (gitignored)
  requirements.txt    ← Python dependencies
  start.sh            ← convenience launcher
```

The extension never calls `fetch()` from the popup — all API requests go through the background service worker, which survives popup closes. State propagates via `chrome.runtime.sendMessage`.
