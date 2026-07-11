# YT2TXT — Video to Transcript Chrome Extension

A Chromium Manifest V3 extension + FastAPI backend that extracts transcripts from YouTube and any yt-dlp-supported site. When a video has native subtitles, they are downloaded directly. Otherwise, the audio is downloaded via yt-dlp and sent to an OpenAI-compatible transcription API (gpt-4o-transcribe / gpt-4o-min-transcribe).

## Architecture

```
extension/          ← Chrome MV3 extension (frontend)
  manifest.json
  background.js     ← service worker: all API calls happen here (popup is torn down on close)
  popup.html        ← popup UI (Transcript + Translation tabs)
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
- The popup NEVER calls fetch() directly for transcript/translation/format — it always delegates to the background service worker via chrome.runtime.sendMessage.
- The background handles all backend API calls because the popup's JS context is destroyed on close, killing in-flight fetches.
- Lightweight config fetches (prompts, path autocomplete) use direct fetch from popup with short timeouts.
- Popup sends `{ type: 'popup:get-state' }` on init to sync state from background.
- Popup sends `{ type: 'popup:start' }` to begin transcript extraction.
- Popup sends `{ type: 'translate:start' }` to begin translation.
- Popup sends `{ type: 'format:start' }` to trigger formatting.
- Background broadcasts `{ type: 'state:update', tabId, state }` to update popup UI.

### Per-tab state
- Use a `Map<tabId, state>` for per-tab independent state (not a single global object).
- State shape: `{ active, status, progress, transcript, error, stopRequested }`.
- Translation and format each have their own controller Maps.

### Backend communication
- Backend URL is user-configurable via host/port inputs in popup, stored in chrome.storage.sync.
- Read from chrome.storage.sync at request time (not startup) to pick up changes without restart.
- Cache the base URL for 60 seconds.
- Add `?_=Date.now()` cache-busting to every fetch to prevent TCP connection reuse issues.

### AbortController
- Use AbortController per tab for the in-flight transcript fetch.
- Stop button aborts the controller so the user gets instant feedback.
- Translation and formatting each have their own AbortController per tab.

## Backend endpoints

### GET /health
Returns `{"status": "ok"}`.

### POST /transcript
Request: `{"url": "https://...", "model": "gpt-4o-transcribe", "force": false}`
Response: `{"text": "...", "source": "subtitles"|"transcription", "model": "...", "error": null|"..."}`

Flow:
1. Validate URL is a non-empty string.
2. Check SQLite cache (30-day TTL, keyed by video ID). Skip if `force: true`.
3. Try to download manual subtitles (no language filter — yt-dlp picks the video's default).
4. If manual subs aren't available, try to download auto-generated captions (no language filter).
5. If a subtitle file is produced → parse to plain text and return.
6. Otherwise, download audio (64kbps mono mp3) and transcribe via OpenAI-compatible API. No language hint is passed — the API auto-detects the spoken language.
7. For large audio (>24MB or >1300s) → split into overlapping chunks with ffmpeg, transcribe each, deduplicate overlap text.
8. Cache the result in SQLite for 30 days. Return with source and model info.

## Backend config (config.yaml)
```yaml
host: "127.0.0.1"
port: 8666
ai:
  api_base: "https://api.openai.com"
  api_key: "$OPENAI_API_KEY"
  model: "gpt-4o-transcribe"
debug: false
cache:
  enabled: true
  ttl_days: 30
```

- `api_key` supports `$ENV_VAR` references.
- Falls back to `OPENAI_API_KEY` env var if no api_key configured.
- `model` is the default transcription model.
- `api_base` auto-appends `/v1` if not present.
- Config is re-read at most every 60 seconds (no restart needed).

## Backend hardening (python-web-server patterns)
- Input validation: check URL is non-empty string, model is a valid string.
- Request logging with middleware (request ID, method, path, status, elapsed).
- Graceful shutdown with SIGTERM/SIGINT handlers.
- Error message sanitization: client errors (400-level) show real messages; server errors (500-level) show generic messages in production.
- Uses uvicorn to serve (async).
- Health endpoint at /health.
- Connection: close header to prevent TCP reuse issues with Chrome MV3 fetch.
- config.example.yaml committed, config.yaml gitignored.

## Popup UI design

### Transcript tab
- Host/port inputs for YT2TXT backend (saved to chrome.storage.sync).
- Host/port inputs for TextKit backend (auto-filled from YT2TXT host if empty).
- URL input pre-filled with current tab URL on popup open.
- "Get Transcript" button (disabled while active).
- "Force refresh" checkbox (bypass cache, auto-clears after start).
- Stop button (visible only while active).
- Status bar showing progress.
- Editable result textarea.
- Copy, Download buttons (disabled when no result).
- **Format button**: always visible, sends text to TextKit `/format`. Auto-format fires after successful transcript extraction. Button stays available after success for re-formatting.

### Translation tab
- Language selector (Original, Chinese, English, Japanese, Korean, French, German, Spanish).
- Collapsible translation prompt textarea (per-language, fetched from TextKit backend with local-storage fallback).
- Status bar and result textarea.
- Auto-copy, Auto-save, Auto-translate checkboxes.
- Save path input with TextKit backend path autocomplete.
- Translate/Stop, Copy, Save, Download buttons.
- **Same-language skip**: when transcript language matches target (e.g. JA→Japanese), no API call — text passes through directly, triggering auto-copy/auto-save if enabled.

### Format flow
- Auto-format fires from background after transcript extraction and after translation.
- Format prompt fetched from TextKit `/prompts/format`, falls back to local storage, then a sensible default.
- Formatted text replaces the transcript cache (`transcript:${tabId}`) preserving the URL for tab-reopen validation.
- Raw transcript cached separately (`transcript_raw:${tabId}`) for retry on format failure.
- Format button in Transcript tab is always visible for manual fail-safe re-formatting.

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
