# YT2TXT — Video to Transcript Chrome Extension

A Chromium Manifest V3 extension + FastAPI backend that extracts transcripts from YouTube and any yt-dlp-supported site. When a video has native subtitles, they are downloaded directly. Otherwise, the audio is downloaded via yt-dlp and sent to an OpenAI-compatible transcription API. Results are cached in SQLite.

Three-tab UI: Transcript → Format → Translation. Format and Translation delegate to the **TextKit backend** (separate server on port 8765).

## Architecture

```
extension/               ← Chrome MV3 extension (frontend)
  manifest.json
  background.js          ← service worker: all API calls (transcript, format, translate, save)
  popup.html             ← three-tab UI (Transcript | Format | Translation)
  popup.js               ← UI logic, delegates to background via messages
  offscreen.html         ← offscreen document for clipboard access from SW
  offscreen.js           ← clipboard handler (hidden textarea + execCommand)
  icons/                 ← icon16.png, icon48.png, icon128.png

backend/                 ← FastAPI backend (transcript extraction only)
  main.py                ← FastAPI app with /transcript and /health endpoints
  config.yaml            ← live config (GITIGNORED)
  config.example.yaml    ← committed template
  transcript_cache.db    ← SQLite transcript cache (GITIGNORED)
  requirements.txt       ← Python dependencies
  start.sh               ← convenience launcher
```

## Three backends

| Backend | Default Port | Purpose |
|---------|-------------|---------|
| YT2TXT | 8666 | Transcript extraction, caching |
| TextKit | 8765 | Formatting, translation |
| File Bridge | 8964 | Save to disk, path autocomplete |

Popup shows backend settings behind a ⚙ gear icon. TextKit host auto-fills from YT2TXT host when empty.

## Extension patterns

### Message-passing architecture
- The popup NEVER calls fetch() directly for operations — it always delegates to the background service worker via chrome.runtime.sendMessage.
- **Exception**: lightweight path-autocomplete fetches (to File Bridge `/paths`) use direct `_popupFetch()` from popup with 10s timeout. These are low-stakes, read-only, and benefit from lower latency.
- Background handles all transcript, format, translate, and save API calls.
- Popup sends `{ type: 'popup:get-state' }` on init to sync state from background.
- Popup sends `{ type: 'popup:start' }` to begin transcript extraction.
- Popup sends `{ type: 'format:start' }` / `{ type: 'translate:start' }` for format/translate.
- Background broadcasts `{ type: 'state:update', tabId, state }` for all state changes.
- Background sends `{ type: 'translation:update', tabId, text }` for translation results.
- Background sends `{ type: 'tl2:translating', tabId, value }` for in-flight state.

### Per-tab state
- `Map<tabId, state>` for per-tab independent state.
- State shape: `{ active, status, progress, transcript, error, stopRequested, format: { sourceText, resultText, active, status, error }, translate: { sourceText, resultText, targetLanguage, active, status, error } }`.
- Separate AbortController Maps: `translateControllers`, `formatControllers`.
- keepAlive prevents SW termination during long operations.

### Backend communication
- Three cached URL builders: `getYt2txtEndpoint()` (port 8666), `getTextkitEndpoint()` (port 8765), and `getFileBridgeEndpoint()` (port 8964), each with 60-second cache expiry.
- All use shared `buildBackendEndpoint()` + `normalizeBackendSettings()`.
- File Bridge host defaults to blank (meaning localhost); blank host is resolved to `DEFAULT_HOST` (localhost) with the configured File Bridge port.
- Cache invalidation via `chrome.storage.onChanged` — each backend's cache is invalidated independently when its settings change.
- Cache-busting: `?_=Date.now()` on every fetch.
- Read from chrome.storage.sync at request time (not startup).

### Auto-action chain
```
Transcript completes → auto-format fires
  → Format completes → auto-copy + auto-save fire
    → auto-translate fires (if yt2txtAutoTranslate enabled)
      → Translation completes → auto-copy + auto-save fire
```
- Auto-format always fires after transcript (unconditional).
- Auto-translate fires after format (conditional on checkbox).
- All auto-actions use offscreen document for clipboard + notifications for user feedback.
- Save and path autocomplete route through File Bridge, not TextKit.
- Results persist to chrome.storage.local so popup reopen restores them.

## Backend endpoints

### GET /health
Returns `{"status": "ok"}`.

### POST /transcript
Request: `{"url": "https://...", "model": "gpt-4o-transcribe", "force": false}`
Response: `{"text": "...", "source": "subtitles"|"transcription", "model": "...", "error": null}`

Flow:
1. Validate URL is a non-empty string.
2. Check SQLite cache (skip if force=true). Return cached result on hit.
3. Try downloading manual subtitles via yt-dlp, then auto-generated captions.
4. If subtitles found → parse to plain text, cache, return.
5. If no subtitles → download audio via yt-dlp (64kbps mono mp3).
6. If audio exceeds 24MB or 1300s → split into chunks with overlap, transcribe each, deduplicate.
7. Send to OpenAI `/v1/audio/transcriptions`, cache, return.

## Backend config (config.yaml)
```yaml
host: "127.0.0.1"
port: 8666
ai:
  api_base: "https://api.openai.com"
  api_key: "$OPENAI_API_KEY"
  model: "gpt-4o-transcribe"
cache:
  enabled: true
  ttl_days: 30
debug: false
```

- `api_key` supports `$ENV_VAR` references.
- Falls back to `OPENAI_API_KEY` env var if no api_key configured.
- `api_base` auto-appends `/v1` if missing.
- `model` is the default transcription model.
- Cache uses SQLite with WAL mode, proactive expiry (on read, write, startup, daily 8 PM).

## Backend hardening
- Input validation: URL is required, non-empty string.
- Request logging with middleware (request ID, method, path, status, elapsed).
- Graceful shutdown with SIGTERM/SIGINT handlers.
- Error message sanitization: client errors show real messages; server errors show generic messages in production.
- `Connection: close` header on every response to avoid TCP reuse issues with Chrome MV3.
- Config cached in-memory with asyncio.Lock (reads config.yaml at most every 60s).
- Sync callers (debug, signals, middleware) use `load_config()` directly; async endpoints use `await get_config()`.

## Popup UI design
- Three tabs: Transcript | Format | Translation.
- Backend settings behind ⚙ gear icon (collapsible panel).
- URL input pre-filled with current tab URL on popup open.
- "Get Transcript" button with Force refresh checkbox (disables cache).
- Stop button (visible only while active).
- Result textarea (editable, non-readonly).
- Copy and Download buttons.
- Format tab: Format button (toggles to Stop), auto-copy/auto-save checkboxes, save path with autocomplete from TextKit.
- Translation tab: language selector, Translate button (toggles to Stop), auto-copy/auto-save/auto-translate checkboxes, save path with autocomplete.
- Status bars on all tabs showing progress.

## Keyboard shortcut (Ctrl+Shift+T)
- Gets current tab URL, starts transcript extraction in the background.
- User sees progress if popup is open, or opens popup to check.

## Conventions
- All API keys from environment variables (never hardcoded).
- config.yaml is gitignored; config.example.yaml is committed.
- Use async/await throughout the backend.
- No TypeScript — plain JavaScript for the extension.
- yt-dlp must be installed on the system.
- Format and Translation are delegated entirely to TextKit — yt2txt backend handles only transcript extraction.

## Not in the repo
- config.yaml (live config with secrets)
- backend/transcript_cache.db (SQLite cache)
- backend/tmp/ (temp audio downloads)
- prompt (agent prompt file)
