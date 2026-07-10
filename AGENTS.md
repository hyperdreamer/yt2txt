# YT2TXT — Video to Transcript Chrome Extension

A Chromium Manifest V3 extension + FastAPI backend that extracts transcripts from YouTube and any yt-dlp-supported site. When a video has native subtitles, they are downloaded directly. Otherwise, the audio is downloaded via yt-dlp and sent to OpenAI's transcription API (gpt-4o-transcribe / gpt-4o-min-transcribe).

## Architecture

```
extension/          ← Chrome MV3 extension (frontend)
  manifest.json
  background.js     ← service worker: all API calls happen here (popup is torn down on close)
  popup.html        ← popup UI
  popup.js          ← popup logic, delegates to background via messages
  icons/             ← icon16.png, icon48.png, icon128.png

backend/            ← FastAPI backend
  main.py           ← FastAPI app with /transcript and /health endpoints
  config.yaml       ← live config (GITIGNORED)
  config.example.yaml ← committed example
  requirements.txt  ← Python dependencies
```

### Host permissions rationale
The manifest uses wildcard ports (`localhost:*`, `127.0.0.1:*`, `[::1]:*`) because
both the YT2TXT and TextKit backend ports are user-configurable via the popup UI.
Restricting to specific ports would break setups using non-default ports.
The extension validates that `host` is always localhost/127.0.0.1/::1, so the
wildcard does not expand the attack surface beyond the local machine.

## Extension patterns (follow ai-ocr exactly)

### Message-passing architecture
- The popup NEVER calls fetch() directly — it always delegates to the background service worker via chrome.runtime.sendMessage.
- The background handles all backend API calls because the popup's JS context is destroyed on close, killing in-flight fetches.
- Popup sends `{ type: 'popup:get-state' }` on init to sync state from background.
- Popup sends `{ type: 'popup:start' }` to begin transcript extraction.
- Background broadcasts `{ type: 'state:update', tabId, state }` to update popup UI.

### Per-tab state
- Use a `Map<tabId, state>` for per-tab independent state (not a single global object).
- State shape: `{ active, status, progress, transcript, error, stopRequested }`.

### Backend communication
- Backend URL is user-configurable via host/port inputs in popup, stored in chrome.storage.sync.
- Read from chrome.storage.sync at request time (not startup) to pick up changes without restart.
- Cache the base URL for 60 seconds.
- Add `?_=Date.now()` cache-busting to every fetch to prevent TCP connection reuse issues.

### AbortController
- Use AbortController per tab for the in-flight transcript fetch.
- Stop button aborts the controller so the user gets instant feedback.

## Backend endpoints

### GET /health
Returns `{"status": "ok"}`.

### POST /transcript
Request: `{"url": "https://...", "model": "gpt-4o-transcribe"}` (model optional)
Response: `{"text": "...", "source": "subtitles"|"transcription", "model": "...", "error": null|"..."}`

Flow:
1. Validate URL is a non-empty string.
2. Run `yt-dlp --list-subs --skip-download <url>` to check for available subtitles.
3. If subtitles exist for the desired language → run `yt-dlp --write-subs --write-auto-subs --sub-langs <lang> --skip-download --convert-subs srt -o "%(id)s" <url>` and read the .srt/.vtt file. Process it to plain text (strip timestamps, join lines). Return with `source: "subtitles"`.
4. If no subtitles → run `yt-dlp -f "bestaudio" --extract-audio --audio-format mp3 -o "tmp/%(id)s.%(ext)s" <url>` to download audio.
5. Send the audio file to OpenAI's `/v1/audio/transcriptions` endpoint with the configured model (gpt-4o-transcribe or gpt-4o-min-transcribe).
6. Clean up the temp audio file. Return with `source: "transcription"`.

## Backend config (config.yaml)
```yaml
host: "127.0.0.1"
port: 8766
ai:
  provider: "openai"
  api_base: "https://api.openai.com"
  api_key: "$OPENAI_API_KEY"
  model: "gpt-4o-transcribe"
debug: false
```

- `api_key` supports `$ENV_VAR` references.
- Falls back to `OPENAI_API_KEY` env var if no api_key configured.
- `model` is the default transcription model.
- Use the same config-loading pattern as ai-ocr: YAML file → env var override → hardcoded default.

## Backend hardening (python-web-server patterns)
- Input validation: check URL is non-empty string, model is a valid string.
- Request logging with before_request/after_request hooks (request ID, method, path, status, elapsed).
- Graceful shutdown with SIGTERM/SIGINT handlers.
- Error message sanitization: client errors (400-level) show real messages; server errors (500-level) show generic messages in production.
- Use uvicorn to serve (not waitress — this is async).
- Health endpoint at /health.
- config.example.yaml committed, config.yaml gitignored.

## Popup UI design
- Single tab (no multi-tab like ai-ocr — much simpler).
- Host/port inputs at top (saved to chrome.storage.sync).
- URL input pre-filled with current tab URL on popup open.
- "Get Transcript" button (disabled while active).
- Stop button (visible only while active).
- Result textarea (editable, non-readonly).
- Copy and Download buttons (disabled when no result).
- Status bar showing progress (e.g., "Checking subtitles...", "Downloading audio...", "Transcribing...").

## Keyboard shortcut (Ctrl+Shift+T)
- Gets current tab URL, starts transcript extraction in the background.
- User sees progress if popup is open, or opens popup to check.

## Conventions
- All API keys from environment variables (never hardcoded).
- config.yaml is gitignored; config.example.yaml is committed.
- README.md with setup instructions.
- Use async/await throughout.
- No TypeScript — plain JavaScript for the extension.
- yt-dlp must be installed on the system (documented in README).

## Not in the repo
- config.yaml (live config with secrets)
- backend/tmp/ (temp audio downloads)
- prompt (agent prompt file)
