# YT2TXT — Video to Transcript

A Chrome Manifest V3 extension + FastAPI backend that extracts transcripts from YouTube and any [yt-dlp](https://github.com/yt-dlp/yt-dlp)-supported site.

**Two paths:**
1. **Native subtitles available** → downloaded directly via yt-dlp (fast, free).
2. **No subtitles** → audio is downloaded and transcribed via OpenAI's `gpt-4o-transcribe` or `gpt-4o-min-transcribe`.

## Prerequisites

- Python 3.10+
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) (`pip install yt-dlp`)
- Chrome or Chromium browser
- OpenAI API key (for transcription; free if video has subtitles)

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

Edit `config.yaml` and set your OpenAI API key:

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

### From the popup

1. Navigate to a video page (YouTube, Vimeo, etc.)
2. Click the YT2TXT icon — the current page URL is pre-filled
3. Click **Get Transcript**
4. Watch the status bar — it will show progress (checking subtitles → downloading audio → transcribing)
5. Copy or download the result

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
  "model": "gpt-4o-transcribe"  // optional, defaults to config
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
  background.js     ← service worker (all API calls)
  popup.html        ← popup UI
  popup.js          ← popup logic

backend/            ← FastAPI backend
  main.py           ← FastAPI app
  config.yaml       ← live config (gitignored)
  config.example.yaml ← committed example
  requirements.txt
```

The extension never calls `fetch()` from the popup — all API requests go through the background service worker, which survives popup closes.
