# YT2TXT — Video to Transcript

A Chrome Manifest V3 extension + FastAPI backend that extracts transcripts from YouTube and any [yt-dlp](https://github.com/yt-dlp/yt-dlp)-supported site.

**Two paths:**
1. **Native subtitles available** → downloaded directly via yt-dlp (fast, free).
2. **No subtitles** → audio is downloaded and transcribed via OpenAI-compatible API (`gpt-4o-transcribe` or `gpt-4o-min-transcribe`).

**Two-tab UI:**
- **Transcript tab** — transcript extraction, formatting
- **Translation tab** — translate transcripts with configurable prompts, auto-copy/auto-save

## Prerequisites

- Python 3.10+
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) (`pip install yt-dlp`)
- Chrome or Chromium browser
- OpenAI-compatible API key (for transcription and formatting; free if video has subtitles)
- [TextKit](https://github.com/hyperdreamer/textkit) backend (for translation and formatting)

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

Edit `config.yaml` and set your API key:

```yaml
ai:
  api_key: "$OPENAI_API_KEY"   # or set the OPENAI_API_KEY env var
  model: "gpt-4o-transcribe"   # or gpt-4o-min-transcribe
```

Or export the environment variable:

```bash
export OPENAI_API_KEY="sk-..."
```

### 3. Start the backend

```bash
python main.py
```

The server starts on `http://127.0.0.1:8666` by default.

### 4. Load the extension

1. Open Chrome and navigate to `chrome://extensions`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked" and select the `extension/` directory
4. The YT2TXT icon appears in the toolbar

## Usage

### Transcript tab

1. Navigate to a video page (YouTube, Vimeo, etc.)
2. Click **Get Transcript**
3. Watch the status bar — it will show progress (checking subtitles → downloading audio → transcribing)
4. **Format** the result with AI for improved readability
5. Copy or download

### Translation tab

1. Select a target language
2. Optionally customize the translation prompt
3. Click **Translate** — or enable **Auto-translate** to translate automatically after extraction
4. Enable **Auto-copy** / **Auto-save** for hands-off workflow
5. When the transcript language matches the target, no API call is made — text passes through directly

### Keyboard shortcut

Press **Ctrl+Shift+T** (Mac: **Cmd+Shift+T**) on any video page to start transcript extraction immediately.

### Manual URL

You can paste any video URL into the popup's URL field — it doesn't have to be the current tab.

## Backend endpoints

### `GET /health`
Returns `{"status": "ok"}`.

### `POST /transcript`
```json
{
  "url": "https://www.youtube.com/watch?v=...",
  "model": "gpt-4o-transcribe",      // optional, defaults to config
  "force": false                     // optional, bypass cache
}
```

Response:
```json
{
  "text": "...transcript...",
  "source": "subtitles",       // or "transcription"
  "model": "yt-dlp",           // or "gpt-4o-transcribe"
  "error": null
}
```

## Architecture

```
extension/          ← Chrome MV3 extension
  manifest.json
  background.js     ← service worker (all API calls, translation, formatting)
  popup.html        ← popup UI (Transcript + Translation tabs)
  popup.js          ← popup logic, delegates to background via messages
  icons/             ← icon16.png, icon48.png, icon128.png

backend/            ← FastAPI backend
  main.py           ← FastAPI app with /transcript and /health
  config.yaml       ← live config (gitignored)
  config.example.yaml ← committed example
  requirements.txt
```

The extension never calls `fetch()` from the popup for transcript/translation/format — all long-running API requests go through the background service worker, which survives popup closes.
