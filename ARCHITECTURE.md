# YT2TXT — Architecture: Format + Translation Tabs

## Overview

Add two new tabs (Format, Translation) alongside the existing Transcript tab in the YT2TXT Chrome extension. The Format and Translation operations delegate to the **TextKit backend** (port 8765), the existing Transcript extraction continues using the **YT2TXT backend** (port 8666), and all save/path-autocomplete operations route through **File Bridge** (port 8964). All API calls go through the background service worker — the popup never calls `fetch()` directly except for lightweight path-autocomplete queries.

### Tab order (yt2txt-specific)

```
Transcript  |  Format  |  Translation
```

This differs from TextKit's order (OCR | Translation | Format) because in yt2txt the primary workflow is: get transcript → format it → translate it.

---

## 1. Component Tree / Tab Structure

```
popup.html
├── .header (YT2TXT title + version)
├── .tab-bar
│   ├── button.tab[data-panel="transcript-panel"]  "Transcript"
│   ├── button.tab[data-panel="format-panel"]       "Format"
│   └── button.tab[data-panel="translation-panel"]  "Translation"
│
├── #transcript-panel (existing, renamed)
│   ├── .settings (Host/Port for yt2txt backend + Lang selector)
│   ├── .url-row (URL input)
│   ├── .actions (Get Transcript, Force refresh, Stop)
│   ├── #status-bar
│   ├── #format-retry-row (hidden, for format failure retry)
│   ├── #result (textarea)
│   └── .result-actions (Copy, Download)
│
├── #format-panel (NEW)
│   ├── h1 "Format Transcript"
│   ├── #format-status-bar
│   ├── textarea#format-result (readonly)
│   ├── .option-row
│   │   ├── label > input[checkbox]#fmt-autocopy    "Auto-copy"
│   │   └── label > input[checkbox]#fmt-autosave    "Auto-save"
│   ├── .save-row
│   │   └── label "Save path" > input#fmt-autosave-path (with datalist#fmt-path-suggestions)
│   └── .actions
│       ├── button#format-btn    "Format" (toggles to "Stop")
│       ├── button#format-copy   "Copy"
│       └── button#format-save   "Save"
│
├── #translation-panel (NEW)
│   ├── h1 "Translation"
│   ├── .settings
│   │   └── label Language > select#tl2-language
│   │       ├── option "original"
│   │       ├── option "Chinese"
│   │       ├── option "English"
│   │       ├── option "Japanese"
│   │       ├── option "Korean"
│   │       ├── option "French"
│   │       ├── option "German"
│   │       └── option "Spanish"
│   ├── #tl2-status-bar
│   ├── textarea#tl2-result (readonly)
│   ├── .option-row
│   │   ├── label > input[checkbox]#tl2-autocopy       "Auto-copy"
│   │   ├── label > input[checkbox]#tl2-autosave       "Auto-save"
│   │   └── label > input[checkbox]#tl2-autotranslate  "Auto-translate"
│   ├── .save-row
│   │   └── label "Save path" > input#tl2-autosave-path (with datalist#tl2-path-suggestions)
│   └── .actions
│       ├── button#tl2-translate  "Translate" (toggles to "Stop")
│       ├── button#tl2-copy       "Copy"
│       ├── button#tl2-save       "Save"
│       └── button#tl2-download   "Download"
│
└── .backend-settings (collapsible, at bottom)
    ├── label "YT2TXT" Host/Port (existing, port 8666)
    ├── label "TextKit" Host/Port (NEW, port 8765)
    └── label "File Bridge" Host/Port (NEW, port 8964)
```

### Design decision: Prompt placement (delegated to TextKit)

**Chosen: yt2txt does not expose prompt textareas. All prompt management is owned by the TextKit backend** (its Prompt tab, file-backed storage, `PUT /prompts/{name}`).

Rationale:
- Avoids a 4th tab and removes duplication — TextKit is already the source of truth.
- `popup.js` and `background.js` no longer fetch, cache, or pass `prompt` to `/translate` or `/format`; TextKit resolves the prompt via its own chain.
- The popup stays focused on the read/write surface (transcript, language, auto-copy, auto-save, save path).

---

## 2. Data Flow for Each Operation

### 2.1 Translate

```
User clicks "Translate" in popup
  → popup.js: doTranslation()
    1. Validate: text not empty, currentTabId exists
    2. Update UI: button → "Stop" (danger style), clear result, disable Copy/Save/Download
    3. Fire-and-forget message to background:
       { type: 'translate:start', tabId, text, language }
    4. Do NOT await — popup stays responsive for Stop button

  → background.js: handleTranslateStart(msg)
    1. Validate: tabId and text present
    2. Abort any in-flight translation for this tab (handleTranslateStop)
    3. Create new AbortController → translateControllers.set(tabId, controller)
    4. Start keepAlive (prevent SW termination)
    5. Persist state: tl2Translating:{tabId}=true
    6. Broadcast { type: 'tl2:translating', tabId, value: true }
    7. Handle "original" language → pass-through (no API call, no prompt)
    8. Resolve TextKit endpoint via getTextkitEndpoint('/translate')
    9. POST { text, language }  (TextKit resolves the prompt internally)
    10. On success:
        - Store translate:result:{tabId} = payload.text
        - Update state.translate.resultText, status, active
        - Broadcast state:update
        - Broadcast translation:update { tabId, text }
        - If text: autoCopyIfEnabled(text), autoSaveIfEnabled(text)
    11. On abort (user Stop):
        - Update state.translate.status = "Translation stopped."
        - Return { ok: true }
    12. On timeout (AbortError + timedOut):
        - Update state.translate.error = "Translation timed out."
        - Broadcast error
    13. On fetch error:
        - Update state.translate.error = error message
        - Broadcast error
    14. Finally:
        - Clear timeout
        - Remove controller from translateControllers
        - Remove tl2Translating:{tabId}
        - Broadcast { type: 'tl2:translating', tabId, value: false }
        - If no controllers active: stopKeepAlive

  → popup.js: receives 'translation:update' message
    - Update tl2Result textarea
    - Enable Copy/Save/Download if text present
    - Reset button to "Translate"
    - Update status bar

  → popup.js: receives 'tl2:translating' message
    - If true: button → "Stop", disable Copy/Save/Download
    - If false: button → "Translate", update button states
```

### 2.2 Format

```
User clicks "Format" in popup
  → popup.js: doFormat()
    1. Get source text from resultEl.value (transcript textarea)
    2. Validate: source text not empty, currentTabId exists
    3. Update UI: button → "Stop" (danger style), clear result, disable Copy/Save
    4. Send message (no host/port — bg resolves via getTextkitEndpoint):
       { type: 'format:start', tabId, text }

  → background.js: handleFormatStart(msg)
    1. Validate: tabId and text present
    2. Abort any in-flight format for this tab (handleFormatStop)
    3. Create new AbortController → formatControllers.set(tabId, controller)
    4. Start keepAlive
    5. Update state.format (sourceText, resultText='', active=true, status='Formatting...', error='')
    6. Broadcast state:update (popup picks up format state from state.format)
    7. Resolve TextKit host/port via getTextkitEndpoint('/format')
    8. POST { text }  (TextKit resolves the prompt internally)
    9. On success:
        - Store fmtResult:{tabId} = payload.text
        - Update state.format.resultText, status, active
        - Broadcast state:update
        - If text: fmtAutoCopyIfEnabled(text), fmtAutoSaveIfEnabled(text)
        - Trigger autoTranslate if enabled
    10. On abort/timeout/error: update state.format.error/status, broadcast state:update
    11. Finally: clear timeout, remove controller, stopKeepAlive if idle

  → popup.js: receives state:update → renderState() updates format tab from state.format
```

### 2.3 Save (translation or format result)

```
User clicks "Save" on Translation or Format tab
  → popup.js: saveTranslation() or saveFormatResult()
    1. Get text from respective result textarea
    2. Get path from respective save-path input
    3. Validate both non-empty
    4. Send: { type: 'save:translation', text, path }
       (NOTE: message type 'save:translation' is reused for both saves —
        TextKit does the same. The endpoint /save is the same regardless.)

  → background.js: handleSaveTranslation(msg)  // reused name from TextKit
    1. Build URL via getFileBridgeEndpoint('/save') → http://{fileBridgeHost}:{fileBridgePort}/save
    2. POST { text, path }
    3. Parse response: require HTTP 200-299 AND success === true
    4. Return { ok: true, path } or { ok: false, error }

  → popup.js: on success
    - Show "Saved!" on button (1500ms)
    - Update status bar: "Saved to {path}"
```

### 2.4 Copy and Download (manual, in popup)

Copy uses `navigator.clipboard.writeText()` in the popup (popup has focus, so this works). For auto-copy from background (popup closed), the offscreen document pattern is used (see section 2.5).

Download creates a Blob from the text, builds an object URL via `URL.createObjectURL()`, clicks a temporary anchor element to trigger the download, then revokes the URL with `URL.revokeObjectURL()`.

### 2.5 Offscreen clipboard (for auto-copy from background)

When auto-copy fires from the background service worker (popup may be closed), the SW can't access `navigator.clipboard`. TextKit solves this with an offscreen document:

```
background.js: copyToClipboard(text)
  1. Create offscreen document: chrome.offscreen.createDocument({
       url: 'offscreen.html',
       reasons: ['CLIPBOARD', 'DOM_PARSER'],
       justification: 'Clipboard access for auto-copy results'
     })
  2. Send message to offscreen: { type: 'offscreen:copy', text }
  3. Schedule close after 2s: chrome.offscreen.closeDocument()

offscreen.js:
  - Receives 'offscreen:copy' message
  - Creates hidden textarea, selects content, uses execCommand('copy')
  - Works without document focus
```

**New files needed:**
- `extension/offscreen.html` — minimal HTML loading offscreen.js
- `extension/offscreen.js` — clipboard handler (exact copy from TextKit)

---

## 3. State Management

### 3.1 In-memory per-tab state (background.js `Map<tabId, state>`)

Extend the existing `states` Map to include new fields:

```javascript
// Existing fields (unchanged):
{
  active: false,          // transcript extraction in progress
  status: 'Idle',         // 'Idle' | 'Processing' | 'Complete' | 'Error'
  progress: 'Ready',      // status bar text
  transcript: '',         // last transcript result
  error: '',
  stopRequested: false,
  controller: null,       // AbortController for transcript fetch
}

// NEW fields — unified Format and Translate sub-states:
{
  format: {
    sourceText: '',
    resultText: '',
    active: false,
    status: '',
    error: '',
  },
  translate: {
    sourceText: '',
    resultText: '',
    targetLanguage: 'zh',
    active: false,
    status: '',
    error: '',
  },
}
```

### 3.2 chrome.storage.local keys (per-tab, survives SW restart)

| Key | Type | Description |
|-----|------|-------------|
| `transcript:${tabId}` | object | `{ text, url }` — transcript result with source URL for cache validation |
| `transcript_raw:${tabId}` | string | Original transcript text (for format retry) |
| `translate:result:${tabId}` | string | Translation result text |
| `tl2Translating:${tabId}` | boolean | Whether translation is in-flight (restores "Stop" button on popup reopen) |
| `fmtResult:${tabId}` | string | Format result text |

> **Note:** Format progress/status and translation progress/status are tracked in-memory via the per-tab `states` Map (`state.format.*`, `state.translate.*`), not in chrome.storage.local. Only results and the translation in-flight flag are persisted.

### 3.3 chrome.storage.local keys (global, not per-tab)

*(None — path autocomplete fetches suggestions from File Bridge `/paths` endpoint.)*

### 3.4 chrome.storage.sync keys (persisted across devices)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `yt2txtHost` | string | `'localhost'` | YT2TXT backend host (existing) |
| `yt2txtPort` | number | `8666` | YT2TXT backend port (existing) |
| `textkitHost` | string | `'localhost'` | **NEW** TextKit backend host |
| `textkitPort` | number | `8765` | **NEW** TextKit backend port |
| `fileBridgeHost` | string | `''` | **NEW** File Bridge host (blank = localhost) |
| `fileBridgePort` | number | `8964` | **NEW** File Bridge port |
| `tl2AutoCopy` | boolean | `false` | **NEW** Auto-copy translation |
| `tl2AutoSave` | boolean | `false` | **NEW** Auto-save translation |
| `tl2AutoSavePath` | string | `''` | **NEW** Save path for translation auto-save |
| `yt2txtAutoTranslate` | boolean | `false` | **NEW** Auto-translate when transcript completes |
| `tl2Language`         | string  | `'original'` | **NEW** Global translation target language |
| `fmtAutoCopy` | boolean | `false` | **NEW** Auto-copy format result |
| `fmtAutoSave` | boolean | `false` | **NEW** Auto-save format result |
| `fmtAutoSavePath` | string | `''` | **NEW** Save path for format auto-save |

### 3.5 Tab-close cleanup

```javascript
chrome.tabs.onRemoved.addListener((tabId) => {
  const state = states.get(tabId);
  if (state?.controller) state.controller.abort();
  handleTranslateStop(tabId);
  handleFormatStop(tabId);
  states.delete(tabId);
  chrome.storage.local
    .remove([
      `transcript:${tabId}`,
      `transcript_raw:${tabId}`,
      `tl2Translating:${tabId}`,
      `fmtResult:${tabId}`,
      `translate:result:${tabId}`,
    ])
    .catch(() => {});
});
```

---

## 4. Message Types (chrome.runtime.sendMessage)

### 4.1 Popup → Background (request/response)

| Type | Direction | Payload | Response | Description |
|------|-----------|---------|----------|-------------|
| `popup:start` | popup→bg | `{url, lang, force}` | `{ok, error?}` | Start transcript extraction (existing) |
| `popup:stop` | popup→bg | (none) | `{ok, error?}` | Stop transcript extraction (existing) |
| `popup:get-state` | popup→bg | (none) | `{ok, state, tabId}` | Get current state (existing) |
| `translate:start` | popup→bg | `{tabId, text, language}` | `{ok, error?}` | **NEW** Start translation (bg resolves TextKit endpoint internally) |
| `translate:stop` | popup→bg | `{tabId}` | `{ok}` | **NEW** Stop translation |
| `format:start` | popup→bg | `{tabId, text}` | `{ok, error?}` | **NEW** Start formatting (no `prompt` — TextKit owns it; bg resolves host/port via `getTextkitEndpoint`) |
| `format:stop` | popup→bg | `{tabId}` | `{ok}` | **NEW** Stop formatting |
| `save:translation` | popup→bg | `{text, path}` | `{ok, path?, error?}` | **NEW** Save text via TextKit `/save` |

### 4.2 Background → Popup (broadcast, no response expected)

| Type | Payload | Description |
|------|---------|-------------|
| `state:update` | `{tabId, state}` | Full state update — includes transcript, format, and translate sub-states |
| `translation:update` | `{tabId, text, error?}` | Translation result or error |
| `tl2:translating` | `{tabId, value}` | Translation in-flight state changed |

> **Note:** Format state is propagated through `state:update` (via `state.format`), not through dedicated `format:update` or `fmt:formatting` messages.

### 4.3 Background → Offscreen (for clipboard)

| Type | Payload | Description |
|------|---------|-------------|
| `offscreen:copy` | `{text}` | Copy text to clipboard via offscreen document |

---

## 5. Auto-Action Chains

### 5.1 Trigger: Transcript completes

```
handleStart() completes successfully
  │
  └─→ handleFormatStart({ tabId: tab.id, text: resultText })
        Calls TextKit /format (TextKit resolves the prompt internally)
        On success → stores fmtResult:{tabId}, broadcasts state:update
        On failure → broadcasts state:update with error (no translate)
```

### 5.2 Trigger: Translation completes

```
handleTranslateStart() completes successfully (translated text is non-empty)
  │
  ├─→ [if tl2AutoCopy] copyToClipboard(translatedText)
  │     Uses offscreen document pattern
  │     Shows notification
  │
  └─→ [if tl2AutoSave AND tl2AutoSavePath] handleSaveTranslation({text, path})
        Calls TextKit /save
        Shows notification on success/failure
```

### 5.3 Trigger: Format completes

```
handleFormatStart() completes successfully (formatted text is non-empty)
  │
  ├─→ [if fmtAutoCopy] copyToClipboard(formattedText)
  │     Uses offscreen document pattern
  │     Shows notification
  │
  ├─→ [if fmtAutoSave AND fmtAutoSavePath] handleSaveTranslation({text, path})
  │     Calls TextKit /save
  │     Shows notification on success/failure
  │
  └─→ [if yt2txtAutoTranslate] autoTranslate(tabId, formattedText)
        Reads tl2Language from chrome.storage.sync (global)
        If language is "original" → skip
        Calls TextKit /translate (TextKit resolves the prompt internally)
        On success → stores translate:result:{tabId}, broadcasts translation:update
          └─→ triggers auto-copy/auto-save for translation (see 5.2)
```

**Manual format also triggers auto-translate** — `handleFormatStart()` always calls `autoTranslate()` on success, whether format was triggered automatically (from transcript completion) or manually (user clicked Format button).

### 5.4 Cascade scenario

```
Transcript completes
  → handleFormatStart fires (auto)
    → Format completes → auto-copy + auto-save fire
      → auto-translate fires (if enabled, formatted text)
        → Translation completes → auto-copy + auto-save fire
```

**Important**: Format always fires after transcript extraction (unconditional). Translation only fires after format when `yt2txtAutoTranslate` is enabled. Format does NOT fire again after translation — the chain ends at Translate.

### 5.5 Auto-format

No separate `autoFormat` wrapper exists — `handleStart()` calls `handleFormatStart()` directly:

```javascript
// In handleStart, after transcript completes:
if (resultText) {
  await chrome.storage.local.set({ [`transcript_raw:${tab.id}`]: resultText });
  try {
    await handleFormatStart({ tabId: tab.id, text: resultText });
  } catch (e) {
    console.error('auto-format failed:', e);
  }
}
```

`handleFormatStart` resolves the TextKit host/port internally via `getTextkitEndpoint('/format')`.

---

## 6. Storage Keys Summary

### chrome.storage.sync

```
yt2txtHost          string   "localhost"
yt2txtPort          number   8666
textkitHost         string   "localhost" (NEW)
textkitPort         number   8765        (NEW)
tl2AutoCopy         boolean  false       (NEW)
tl2AutoSave         boolean  false       (NEW)
tl2AutoSavePath     string   ""          (NEW)
yt2txtAutoTranslate boolean  false       (NEW)
fileBridgeHost      string   ""          (NEW)
fileBridgePort      number   8964        (NEW)
tl2Language         string   "original"  (NEW)
fmtAutoCopy         boolean  false       (NEW)
fmtAutoSave         boolean  false       (NEW)
fmtAutoSavePath     string   ""          (NEW)
```

### chrome.storage.local (global)

```
(none — prompts live in TextKit, path autocomplete fetches from File Bridge /paths)
```

### chrome.storage.local (per-tab, suffixed with `:${tabId}`)

```
transcript:${tabId}          object   (existing, {text, url})
transcript_raw:${tabId}      string   (existing, for format retry)
translate:result:${tabId}    string   (translation result)
tl2Translating:${tabId}      boolean  (in-flight flag)
fmtResult:${tabId}           string   (format result)
```

---

## 7. Backend URL Resolution for Two Backends

YT2TXT uses **three distinct backends**:

| Backend | Default Port | Purpose | Config Keys |
|---------|-------------|---------|-------------|
| YT2TXT | 8666 | Transcript extraction (`/transcript`) | `yt2txtHost`, `yt2txtPort` |
| TextKit | 8765 | Format (`/format`), Translate (`/translate`) | `textkitHost`, `textkitPort` |
| File Bridge | 8964 | Save (`/save`), Path autocomplete (`/paths`) | `fileBridgeHost`, `fileBridgePort` |

### Background.js: three cached URL builders

```javascript
let _yt2txtBaseUrl = null;
let _yt2txtBaseUrlExpiry = 0;

async function getYt2txtEndpoint(path) {
  if (!_yt2txtBaseUrl || Date.now() > _yt2txtBaseUrlExpiry) {
    const items = await chrome.storage.sync.get({
      yt2txtHost: DEFAULT_HOST,
      yt2txtPort: 8666,
    });
    _yt2txtBaseUrl = buildBackendEndpoint(items.yt2txtHost, items.yt2txtPort, '');
    _yt2txtBaseUrlExpiry = Date.now() + 60_000;
  }
  return _yt2txtBaseUrl + path;
}

let _textkitBaseUrl = null;
let _textkitBaseUrlExpiry = 0;

async function getTextkitEndpoint(path) {
  if (!_textkitBaseUrl || Date.now() > _textkitBaseUrlExpiry) {
    const items = await chrome.storage.sync.get({
      textkitHost: DEFAULT_HOST,
      textkitPort: 8765,
    });
    _textkitBaseUrl = buildBackendEndpoint(items.textkitHost, items.textkitPort, '');
    _textkitBaseUrlExpiry = Date.now() + 60_000;
  }
  return _textkitBaseUrl + path;
}
```

### Background.js: File Bridge endpoint cache

```javascript
const FILE_BRIDGE_DEFAULT_PORT = 8964;

let _fileBridgeBaseUrl = null;
let _fileBridgeBaseUrlExpiry = 0;

async function getFileBridgeEndpoint(path) {
  if (!_fileBridgeBaseUrl || Date.now() > _fileBridgeBaseUrlExpiry) {
    const items = await chrome.storage.sync.get({
      fileBridgeHost: '',
      fileBridgePort: FILE_BRIDGE_DEFAULT_PORT,
    });
    const hasFileBridgeHost = String(items.fileBridgeHost || '').trim().length > 0;
    const host = hasFileBridgeHost ? items.fileBridgeHost : DEFAULT_HOST;
    const port = items.fileBridgePort || FILE_BRIDGE_DEFAULT_PORT;
    _fileBridgeBaseUrl = buildBackendEndpoint(host, port, '');
    _fileBridgeBaseUrlExpiry = Date.now() + 60_000;
  }
  return _fileBridgeBaseUrl + path;
}
```

The File Bridge host defaults to blank (meaning localhost). Changing `fileBridgeHost` or `fileBridgePort` in sync storage invalidates only the File Bridge cache via `chrome.storage.onChanged`.

#### Cache invalidation

```javascript
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') return;
  if (changes.fileBridgeHost || changes.fileBridgePort) {
    _fileBridgeBaseUrl = null;
    _fileBridgeBaseUrlExpiry = 0;
  }
  // ... similar for yt2txt and textkit caches
});
```

The `buildBackendEndpoint` and `normalizeBackendSettings` functions are reused — they don't care about the port, and the host validation (localhost-only) is the same for all three backends.

### Popup.js: settings UI

The popup shows both backend settings. The existing Host/Port fields are for yt2txt. TextKit Host/Port fields are added. Both save to `chrome.storage.sync`.

Both `translate:start` and `format:start` do not include host/port — the background resolves the TextKit endpoint via `getTextkitEndpoint()`.

### TextKit backend discovery

When both backends run on the same machine (the common case), the user only needs to change the port. The host defaults to `localhost` for both. The popup auto-detects this by checking if `textkitHost` is empty and falling back to `yt2txtHost`.

```javascript
// popup.js init:
const items = await chrome.storage.sync.get({
  yt2txtHost: 'localhost', yt2txtPort: 8666,
  textkitHost: '', textkitPort: 8765,
});
if (!items.textkitHost) items.textkitHost = items.yt2txtHost;
```

---

## 8. Error Handling Strategy

### 8.1 Network errors

- All `fetch()` calls in background.js are wrapped in try/catch
- `AbortError` is handled specially: check `timedOut` flag to distinguish user stop vs timeout
- User stop: store status message, return `{ ok: true }` (not an error)
- Timeout: store error status, broadcast error to popup, return `{ ok: false, error }`
- Other fetch errors: store error message, broadcast to popup

### 8.2 Empty results

- If `/translate` returns empty text: store empty string, broadcast normally. The popup shows the empty textarea with Copy/Save/Download disabled.
- If `/format` returns empty text: same pattern.

### 8.3 Backend unreachable

- `fetch()` throws — caught by the error handler
- Popup receives error via `state:update` or `translation:update` messages
- Status bar shows the error message
- Button resets to normal state

### 8.4 Invalid input

- Empty source text → Format/Translate button is disabled (UI-level guard)
- Empty save path → save function returns early with status message "Set a Save path first."
- Invalid host/port → `normalizeBackendSettings()` throws, caught by caller, shown in status bar

### 8.5 Concurrent operations

- Starting a new translate while one is in-flight: `handleTranslateStop(tabId)` aborts the old one first
- Starting a new format while one is in-flight: `handleFormatStop(tabId)` aborts the old one first
- Transcript extraction is independent — can run alongside translate/format

### 8.6 SW termination during operation

- `keepAliveIntervalId` prevents SW termination while any operation is in-flight
- All progress state is persisted to `chrome.storage.local` before starting.
- On popup reopen, `init()` reads `tl2Translating:{tabId}` to restore "Stop" button state for translation.
- Format progress is tracked in-memory via `state.format.active` and restored from the `states` Map via `popup:get-state`.
- If an operation completed while popup was closed, results are loaded from `fmtResult:{tabId}` and `translate:result:{tabId}`.

### 8.7 Popup close during operation

- Operations continue in the background service worker (this is why all API calls are in background)
- Auto-copy uses offscreen document (SW can't access clipboard)
- Auto-save uses background fetch (SW can access fetch)
- When popup reopens, it reads latest results from `chrome.storage.local`

---

## 9. Key Implementation Details

### 9.1 Extension manifest (`manifest.json`)

Permissions: `activeTab`, `tabs`, `scripting`, `downloads`, `storage`, `offscreen`, `notifications`.
Host permissions: localhost wildcards for both YT2TXT and TextKit backends.
Commands: `Ctrl+Shift+T` / `Cmd+Shift+T` triggers transcript extraction.

### 9.2 Background service worker (`background.js`)

**Two cached URL builders:** `getYt2txtEndpoint()` (port 8666) and `getTextkitEndpoint()` (port 8765),
each with 60-second cache expiry. Both use `buildBackendEndpoint()` + `normalizeBackendSettings()`.

**State management:**
| `states` Map: per-tab state including transcript, format, and translate sub-states
| `translateControllers` / `formatControllers` Maps: separate AbortController per tab per operation
| `keepAliveIntervalId`: prevents SW termination during long operations

**Auto-action triggers:**
- Transcript completes → `handleFormatStart()` directly — calls TextKit `/format` (unconditional)
- Format completes → `autoTranslate()` — reads global `tl2Language` from sync, calls TextKit `/translate` (if enabled)
- Translation completes → auto-copy + auto-save (if enabled)

**Clipboard:** `copyToClipboard()` uses offscreen document for auto-copy from background.

### 9.3 Popup (`popup.html` + `popup.js`)

Three-tab layout: Transcript | Format | Translation. Backend settings behind gear icon.
All long-running API calls go through background; lightweight path-autocomplete fetches
use direct `fetch()` from popup with 10s timeout.

### 9.4 Offscreen document (`offscreen.html` + `offscreen.js`)

Minimal HTML loading `offscreen.js`. Handles clipboard via hidden textarea + `execCommand('copy')`.
Created on-demand by `copyToClipboard()`, closed after 2s.

---

## 10. Popup Init Flow (restore state on reopen)

```
popup.js init()
  1. Query active tab → currentTabId
  2. Load sync settings:
     - yt2txtHost, yt2txtPort (existing)
     - textkitHost, textkitPort (NEW)
     - tl2AutoCopy, tl2AutoSave, tl2AutoSavePath, yt2txtAutoTranslate (NEW)
     - fmtAutoCopy, fmtAutoSave, fmtAutoSavePath (NEW)
  3. Pre-fill URL from current tab (existing)
  4. Refresh transcript state from background (existing)
  5. Load persisted transcript result (existing)
  6. Load translation tab state:
     - tl2Language (sync, global) → set language selector
     - translate:result:{tabId} → fill textarea, enable buttons
     - tl2Translating:{tabId} → restore "Stop" button if was translating
  7. Load format tab state:
     - fmtResult:{tabId} → fill textarea, enable buttons
  8. Load path suggestions from File Bridge backend /paths
  9. Update all button states
```

---

## 11. Design Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Prompt ownership | Delegated entirely to TextKit (its Prompt tab + `PUT /prompts/{name}`) | Single source of truth. yt2txt popup stays focused on the read/write surface (text, language, auto-copy, auto-save, save path). |
| Format source default | "Transcript" | Primary workflow: get transcript → clean it up. Translation is secondary. |
| Auto-format chain | Sequential: Transcript → Format → Translate (no format after translate) | Primary workflow: transcribe → clean → translate. Format fires once after transcript. Manual format also triggers auto-translate. |
| Save message type | Reuse `save:translation` for both | TextKit does this — the `/save` endpoint is the same regardless of what text is being saved |
| Backend discovery | Auto-fill textkitHost from yt2txtHost if empty | Common case: both backends on same machine, different ports |
| Notifications | Use `chrome.notifications` for auto-copy/auto-save | User needs feedback when auto-actions fire while popup is closed |
| Tab order | Transcript → Format → Translation | Matches primary workflow: extract → clean → translate |
