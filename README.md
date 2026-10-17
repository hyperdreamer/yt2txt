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

## Force refresh, recovery, and backend compatibility

### Checkbox Force applies to the whole chain

**Force refresh** on the Transcript tab applies to the transcript request *and* to the
formatting and translation stages that the transcript starts automatically. When a
forced extraction is accepted, the same root operation keeps Force across the
auto-format stage and the conditional auto-translate stage, so a forced refresh
never mixes fresh transcript text with stale formatted or translated output. Force
does not enable translation and never changes the selected language: auto-translate
still fires only when **Auto-translate** is checked and a concrete language is set.

Standalone actions stay ordinary, cacheable requests. **Format** pressed on the
Format tab, **Translate** pressed on the Translation tab, and the Ctrl+Shift+T
keyboard shortcut always run with Force off, even if the checkbox is still ticked.

### What is on the wire

- Force off is *omitted*, not sent as `false`. An ordinary request contains only
  the fields an older backend already requires, so a backend that predates `force`
  sees exactly the request shape it always saw.
- Force on is `force: true` on `POST /transcript`, `POST /format`, and
  `POST /translate`. Only a TextKit that understands the field accepts it.
- If an older TextKit rejects `force`, the rejection is surfaced as the normal
  stage error and nothing else happens. The extension never silently retries the
  same stage without Force — a forced refresh that quietly fell back to the cache
  would report success while returning stale text. Untick the box and press the
  button again to run the ordinary request.

### Deployment order: TextKit first

Deploy the updated **TextKit first**. The extension is the component that starts
sending the optional `force` field, so a new extension in front of an old TextKit
works for ordinary requests but fails with a visible error on every forced
format or translation. The order is:

1. Update and start **TextKit** (port 8765) so `POST /format` and `POST /translate`
   accept an optional Boolean `force`.
2. Update and start the **YT2TXT** backend (port 8666) — `POST /transcript`
   already accepted `force`.
3. Reload the unpacked extension from `chrome://extensions`.

Steps 1 and 2 are independent of each other; only the extension has to come last.

Successful `POST /format` and `POST /translate` responses may carry an additive
`X-TextKit-Cache` response header. It is diagnostic only: the JSON body keeps its
existing `text` shape, and the extension does not need it to work. Non-success
responses omit the header.

### Cache hits are still accepted results

A cache hit is a normal success. Auto-copy, auto-save, and the conditional
auto-translate handoff all run on an accepted formatted or translated result
whether the text came from TextKit's cache or from a fresh provider call, and the
result is persisted the same way. `X-TextKit-Cache: skipped`, `disabled`,
`uncacheable`, and `refresh` are likewise ordinary successes.

### Recovery after a service worker restart

MV3 service workers are terminated when idle. The background worker therefore
keeps a small durable operation record per tab so an interrupted stage survives a
restart instead of vanishing or being silently re-run:

- `transform:operation:<tabId>` holds the version-1 record for an in-flight or
  failed format/translation stage (stage, status, exact source text, source URL,
  source kind, language, Force, error).
- `transcript_recovery:<tabId>` holds the version-1 terminal marker that tells
  reconciliation whether an operation completed, was stopped, or is still
  available for a **manual retry**.
- `transcript_force:<tabId>` remembers the Force provenance of the saved
  transcript so a **manual retry** of formatting reuses it.

Recovery is explicitly user-driven through the existing controls. Reopening the
popup reconciles the record and shows a **Format Transcript** retry row next to
the transcript, or relabels the Translation button to **Retry**. The retry uses the
**saved source** text, the saved language, and the saved Force provenance rather
than whatever is currently in the textarea or language dropdown, so a retry still
works when the textareas are empty and cannot accidentally translate into a
different language.

Recovery itself never calls a provider and never replays an effect: it does not
re-request TextKit, and it does not copy, save, or translate on its own. A retry
only happens when you click it, and it is a fresh request like any other. Results
that were already saved stay visible next to a retryable record.

### Stop, tab close, and storage lifetime

**Stop** invalidates the running operation immediately, then waits for the queued
storage work to settle before it answers. That acknowledgment can therefore be
slightly delayed while the worker removes the operation record and its transient
activity marker. If that durable cleanup fails, the worker's Stop response reports
the failure (`ok: false`) instead of claiming the operation was durably stopped.

Reconciliation is deliberately conservative. A record with an unknown version,
malformed fields, a mismatched tab ID, an unsupported language, empty source text,
or a source URL that no longer matches the tab never triggers provider work; it is
ignored and the tab is left idle.

Closing a tab fences it for the worker's lifetime and deletes every
`<name>:<tabId>` record for it through the same serialized storage path, so a
reopened tab starts clean rather than recovering a dead tab's transcript.

Saved transcripts, formatted text, and translations are retained locally in
`chrome.storage.local` until the tab is closed or a new extraction supersedes
them. They are plain text only: no provider credentials ever reach extension
storage, because API keys live exclusively in the backend's gitignored
`config.yaml` or environment.

### Verifying a checkout

Run JavaScript tests from the repository root, never from `extension/tests/`:

```sh
node --check extension/operation_ownership.js
node --check extension/storage_queue.js
node --check extension/background.js
node --check extension/popup.js
node --test tests/background.test.js tests/popup.test.js tests/filebridge.test.js \
  tests/storage_queue.test.js tests/operation_lifecycle.test.js \
  tests/storage_reconciliation.test.js tests/popup_recovery.test.js \
  tests/force_propagation.test.js
```

The suite covers the classic-worker seams (`operation_ownership.js`,
`storage_queue.js`), lifecycle and restart reconciliation, storage rollback,
Force propagation, popup hydration and retry provenance, and the pre-existing
background and popup behaviours those changes must not disturb.

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

### `POST /format` and `POST /translate` (TextKit)

```json
{
  "text": "...source text...",
  "language": "Spanish",        // /translate only, required
  "force": true                  // optional Boolean, omitted when Force is off
}
```

Both keep their existing required fields (`text`, plus `language` for
`/translate`) and their existing JSON response shape. `force` is an optional
Boolean that defaults to `false`/omitted. Successful responses may include an
additive `X-TextKit-Cache` header whose value is one of `skipped`, `disabled`,
`hit`, `error`, `uncacheable`, `refresh`, or `miss`; non-success responses omit the
header. The header is diagnostic — the extension never depends on it.

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
