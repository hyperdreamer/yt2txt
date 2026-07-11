# YT2TXT — Video to Transcript Chrome Extension

A Chromium Manifest V3 extension + FastAPI backend that extracts transcripts from YouTube and any yt-dlp-supported site. When a video has native subtitles, they are downloaded directly. Otherwise, the audio is downloaded via yt-dlp and sent to OpenAI's transcription API (gpt-4o-transcribe / gpt-4o-min-transcribe). Results are cached in SQLite with configurable TTL.

## Architecture

```
extension/          ← Chrome MV3 extension (frontend)
  manifest.json     ← permissions, commands, icons
  background.js     ← service worker: all API calls happen here (popup is torn down on close)
  popup.html        ← three-tab popup UI
  popup.js          ← popup logic, delegates to background via messages
  icons/            ← icon16.png, icon48.png, icon128.png

backend/            ← FastAPI backend
  main.py           ← FastAPI app with /transcript and /health endpoints
  config.yaml       ← live config (GITIGNORED)
  config.example.yaml ← committed example
  requirements.txt  ← Python dependencies
  transcript_cache.db ← SQLite cache (auto-created on first run)
```

## Extension patterns

### Message-passing architecture
- The popup NEVER calls fetch() for long-running operations (transcript/format/translate) — it always delegates to the background service worker via `chrome.runtime.sendMessage`.
- The background handles all backend API calls because the popup's JS context is destroyed on close, killing in-flight fetches.
- Lightweight path-autocomplete fetches are an exception: they call `fetch()` directly from the popup with 10s timeouts. This avoids message-passing latency for interactive UX.
- Popup sends `{ type: 'popup:get-state' }` on init to sync state from background.
- Popup sends `{ type: 'popup:start' }` to begin transcript extraction.
- Popup sends `{ type: 'format:start' }` / `'translate:start'` for format/translation.
- Background broadcasts `{ type: 'state:update', tabId, state }` to update popup UI.
- Background broadcasts `{ type: 'translation:update', tabId, text }` for translation results.
- Background broadcasts `{ type: 'tl2:translating', tabId, value }` for in-progress state.

### Three-tab UI
- **Transcript tab** — URL input, Get Transcript / Stop buttons, result textarea, copy/download, Force refresh checkbox, Format Retry button (shown on format error).
- **Format tab** — sends transcript to TextKit `/format`, auto-copy / auto-save checkboxes, save path with autocomplete.
- **Translation tab** — sends transcript to TextKit `/translate`, language selector (Original/Chinese/English/Japanese/Korean/French/German/Spanish), auto-copy / auto-save / auto-translate checkboxes, save path with autocomplete.
- Settings panel (gear ⚙ icon) with YT2TXT and TextKit backend host/port fields.

### Auto-action chain
Transcript → Format → Translation (sequential). Format fires automatically after transcript; format completion triggers auto-translate if enabled.

### Per-tab state
- Use a `Map<tabId, state>` for per-tab independent state.
- State shape: `{ active, status, progress, transcript, error, stopRequested, format: {...}, translate: {...} }`.
- Format sub-state: `{ sourceText, resultText, active, status, error }`.
- Translation sub-state: `{ sourceText, resultText, targetLanguage, active, status, error }`.

### Backend communication
- Two backends: YT2TXT (port 8666) and TextKit (port 8765).
- Backend URLs are user-configurable via host/port inputs in the settings panel, stored in `chrome.storage.sync`.
- Read from `chrome.storage.sync` at request time (not startup) to pick up changes without restart.
- Cache each base URL for 60 seconds.
- Add `?_=Date.now()` cache-busting to every fetch to prevent TCP connection reuse issues.

### AbortController
- Separate AbortController per tab for transcript, translation, and format operations.
- Stop buttons abort their respective controllers for instant feedback.
- Translation and format controllers tracked in separate Maps (`translateControllers`, `formatControllers`).

### Keep-alive
- `setInterval` ping via `chrome.runtime.getPlatformInfo` every 20s while translation or format is in-flight.
- Prevents the service worker from being terminated mid-operation.

### Auto-copy / auto-save
- Uses `chrome.offscreen.createDocument` for clipboard access (MV3 requires offscreen for `navigator.clipboard.writeText`).
- `chrome.notifications` for success/failure feedback.
- Separate auto-save logic for format and translation (different storage keys).

### User-edited detection
- `userEditedResult` flag set on `resultEl input` event. When true, state updates won't overwrite the textarea.
- `tlUserEdited` flag for translation result textarea.

## Backend endpoints

### GET /health
Returns `{"status": "ok"}`.

### POST /transcript
Request: `{"url": "https://...", "model": "gpt-4o-transcribe", "force": false}` (model and force optional)
Response: `{"text": "...", "source": "subtitles"|"transcription"|"cached", "model": "...", "error": null|"..."}`

Flow:
1. Validate URL is a non-empty string.
2. Extract `video_id` via yt-dlp `--print id`, then regex fallback for YouTube, then SHA-256 hash.
3. Check SQLite cache (skip if `force: true`). Cache hit → return instantly.
4. Try manual subtitles via `yt-dlp --write-subs --no-write-auto-subs`.
5. If no manual subs, try auto-generated captions via `yt-dlp --write-auto-subs --no-write-subs`.
6. If subtitles found → parse .srt/.vtt to plain text, cache, return.
7. If no subtitles → download audio via `yt-dlp -f bestaudio --extract-audio --audio-format mp3 --postprocessor-args "ffmpeg:-b:a 64k -ac 1"`.
8. Transcribe audio via OpenAI `/v1/audio/transcriptions` (raw multipart form-data).
9. Cache result, return.

### Audio chunking
- Files >24MB or >1300s are split with ffmpeg into ∼20-minute chunks.
- Chunks overlap by 10s to prevent word-boundary cuts.
- Adjacent chunk transcriptions are deduplicated by finding longest common suffix/prefix.
- Last chunk omits `-to` to avoid dropping audio at ffprobe duration rounding.

### Cache
- SQLite database (`transcript_cache.db`) with table `transcript_cache(video_id, text, source, created_at)`.
- TTL configured via `cache.ttl_days` (default 30).
- Expired rows deleted on read, on write (auto-prune), and on startup.
- Daily cleanup task runs at 8 PM local time.

## Backend config (config.yaml)
```yaml
host: "127.0.0.1"
port: 8666

ai:
  model: "gpt-4o-transcribe"
  api_base: "https://api.openai.com"
  api_key: "$OPENAI_API_KEY"

cache:
  enabled: true
  ttl_days: 30

# debug: true
```

- `api_key` supports `$ENV_VAR` references.
- Falls back to `OPENAI_API_KEY` env var if no api_key configured.
- `api_base` auto-appends `/v1` if not present.
- `model` is the default transcription model.
- Debug mode enabled via `YT2TXT_DEBUG` or `FLASK_DEBUG` env vars, or `debug: true` in config.
- Config is hot-reloaded every 60s (no restart needed).

## Backend hardening
- Input validation: check URL is non-empty string, model is sanitized (CR/LF stripped for multipart injection prevention).
- Request logging middleware (request ID, method, path, status, elapsed).
- `Connection: close` header to prevent Chrome MV3 TCP connection reuse issues.
- Graceful shutdown with SIGTERM/SIGINT handlers.
- Error message sanitization: client errors (400-level) show real messages; server errors (500-level) show generic messages in production.
- Audio file empty check before transcription.
- yt-dlp process timeout with kill-on-timeout.
- Model name sanitization: CR/LF stripped before multipart body interpolation.
- config.example.yaml committed, config.yaml gitignored.
- transcript_cache.db gitignored.

## Popup UI design
- Three-tab interface: Transcript, Format, Translation.
- Gear icon opens collapsible backend settings panel (YT2TXT + TextKit host/port).
- URL input pre-filled with current tab URL on popup open.
- "Get Transcript" button (disabled while active). "Stop" button (visible only while active).
- "Force refresh" checkbox (disabled while active, unchecked after each request).
- Result textarea (editable, non-readonly). Copy and Download buttons.
- Format Retry button row (hidden by default, shown only when format failed).
- Format tab: auto-copy / auto-save checkboxes, save path with datalist autocomplete.
- Translation tab: language selector, auto-copy / auto-save / auto-translate checkboxes, save path with datalist autocomplete.
- Status bars per tab showing progress/errors.
- Dark/light theme via `@media (prefers-color-scheme: light)`.

## Keyboard shortcut (Ctrl+Shift+T / Cmd+Shift+T)
- Gets current tab URL, starts transcript extraction in the background.
- Skips chrome:// and about: pages.
- User sees progress if popup is open, or opens popup to check.

## Conventions
- All API keys from environment variables (never hardcoded).
- config.yaml is gitignored; config.example.yaml is committed.
- README.md with setup instructions.
- Use async/await throughout.
- No TypeScript — plain JavaScript for the extension.
- yt-dlp and ffmpeg must be installed on the system (documented in README).
- Version strings in three places: main.py (`FastAPI(title=..., version=...)`), manifest.json (`version`), popup.html (version span).

## Not in the repo
- config.yaml (live config with secrets)
- backend/transcript_cache.db (SQLite cache)
- backend/tmp/ (temp audio downloads)
- prompt (agent prompt file)
