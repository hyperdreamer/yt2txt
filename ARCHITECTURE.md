# YT2TXT — Architecture: Format + Translation Tabs

## Overview

Add two new tabs (Format, Translation) alongside the existing Transcript tab in the YT2TXT Chrome extension. The Format and Translation operations delegate to the **TextKit backend** (port 8765), while the existing Transcript extraction continues using the **YT2TXT backend** (port 8666). All API calls go through the background service worker — the popup never calls `fetch()` directly.

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
│   ├── #result (textarea)
│   └── .result-actions (Copy, Download)
│
├── #format-panel (NEW)
│   ├── h1 "Format"
│   ├── .settings
│   │   └── label Source > select#fmt-source
│   │       ├── option "Transcript" (default)
│   │       └── option "Translation"
│   ├── .collapsible-section "Prompt"
│   │   └── textarea#format-prompt (custom format prompt)
│   ├── #fmt-status-bar
│   ├── textarea#fmt-result (readonly)
│   ├── .option-row
│   │   ├── label > input[checkbox]#fmt-autocopy    "Auto-copy"
│   │   ├── label > input[checkbox]#fmt-autosave    "Auto-save"
│   │   └── label > input[checkbox]#fmt-autoformat  "Auto-format"
│   ├── .save-row
│   │   └── label "Save path" > input#fmt-save-path (with datalist#fmt-path-suggestions)
│   └── .actions
│       ├── button#fmt-format    "Format" (toggles to "Stop")
│       ├── button#fmt-copy      "Copy"
│       ├── button#fmt-save      "Save"
│       └── button#fmt-download  "Download"
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
│   ├── .collapsible-section "Prompt"
│   │   └── textarea#translate-prompt (per-language, loaded from TextKit backend)
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
    └── label "TextKit" Host/Port (NEW, port 8765)
```

### Design decision: Prompt placement

**Chosen: Prompts inline in each tab, inside a collapsible `<details>` element.**

Rationale:
- Each prompt is specific to its tab (format prompt lives in Format tab, translation prompt lives in Translation tab). No context-switching needed.
- Avoids a 4th "Prompt" tab (TextKit has 4 tabs; yt2txt stays at 3).
- The collapsible `<details>` element keeps the UI clean when prompts aren't being edited, while being always accessible.

The translation prompt is **per-language** — changing the language selector loads the prompt for that language from `chrome.storage.local` (keyed `translatePrompt:${language}`), with the TextKit backend's `/prompts/translate?language=X` as the source of truth.

The format prompt is **global** — stored as a single key `formatPrompt` in `chrome.storage.local`.

---

## 2. Data Flow for Each Operation

### 2.1 Translate

```
User clicks "Translate" in popup
  → popup.js: doTranslation()
    1. Validate: text not empty, currentTabId exists
    2. Normalize TextKit backend settings (host/port from inputs)
    3. Update UI: button → "Stop" (danger style), clear result, disable Copy/Save/Download
    4. Fire-and-forget message to background:
       { type: 'translate:start', tabId, text, language, host, port }
    5. Do NOT await — popup stays responsive for Stop button

  → background.js: handleTranslateStart(msg)
    1. Validate: tabId and text present
    2. Abort any in-flight translation for this tab (handleTranslateStop)
    3. Create new AbortController → translateControllers.set(tabId, controller)
    4. Start keepAlive (prevent SW termination)
    5. Persist state: tl2Translating:{tabId}=true, tl2Status:{tabId}="Translating to {lang}..."
    6. Clear stale result: remove tl2Result:{tabId}
    7. Broadcast { type: 'tl2:translating', tabId, value: true }
    8. Handle "original" language with no custom prompt → pass-through (no API call)
    9. Load per-language prompt from chrome.storage.local (key: translatePrompt:{language})
    10. Build URL: http://{host}:{port}/translate?_={Date.now()}
    11. POST { text, language, prompt: stored[key] || undefined }
    12. On success:
        - Store tl2Result:{tabId} = payload.text
        - Broadcast { type: 'translation:update', tabId, text }
        - If text: autoCopyIfEnabled(text), autoSaveIfEnabled(text)
        - If text: autoFormatIfEnabled(tabId, text, host, port)
    13. On abort (user Stop):
        - Store tl2Status:{tabId} = "Translation stopped."
        - Return { ok: true }
    14. On timeout (AbortError + timedOut):
        - Store tl2Status:{tabId} = "Translation timed out."
        - Broadcast error
    15. On fetch error:
        - Store tl2Status:{tabId} = error message
        - Broadcast error
    16. Finally:
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
    1. Determine source text:
       - fmtSource="Transcript" → resultEl.value (transcript textarea)
       - fmtSource="Translation" → tl2Result.value (translation textarea)
    2. Validate: source text not empty, currentTabId exists, prompt not empty
    3. Normalize TextKit backend settings
    4. Update UI: button → "Stop" (danger style), clear result, disable Copy/Save/Download
    5. Fire-and-forget:
       { type: 'format:start', tabId, text, prompt, host, port }

  → background.js: handleFormatStart(msg)
    1. Validate: tabId, text, prompt present
    2. Abort any in-flight format for this tab (handleFormatStop)
    3. Create new AbortController → formatControllers.set(tabId, controller)
    4. Start keepAlive
    5. Persist state: fmtFormatting:{tabId}=true, fmtStatus:{tabId}="Formatting..."
    6. Clear stale result: remove fmtResult:{tabId}
    7. Broadcast { type: 'fmt:formatting', tabId, value: true }
    8. Build URL: http://{host}:{port}/format?_={Date.now()}
    9. POST { text, prompt }
    10. On success:
        - Store fmtResult:{tabId} = payload.text
        - Broadcast { type: 'format:update', tabId, text }
        - If text: fmtAutoCopyIfEnabled(text), fmtAutoSaveIfEnabled(text)
    11. On abort/timeout/error: same pattern as translate (store status, broadcast)
    12. Finally: clear timeout, remove controller, broadcast fmt:formatting=false, stopKeepAlive if idle

  → popup.js: receives 'format:update' and 'fmt:formatting' messages
    - Same pattern as translation update messages
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
    1. Build URL: http://{textkitHost}:{textkitPort}/save
    2. POST { text, path }
    3. Return { ok: true, path } or { ok: false, error }

  → popup.js: on success
    - Show "Saved!" on button (1500ms)
    - Update status bar: "Saved to {path}"
    - Show notification
```

### 2.4 Copy and Download (manual, in popup)

Copy uses `navigator.clipboard.writeText()` in the popup (popup has focus, so this works). For auto-copy from background (popup closed), the offscreen document pattern is used (see section 2.5).

Download uses `chrome.downloads.download()` with a blob URL, same as existing transcript download.

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

// NEW fields:
{
  // No additional fields needed in the main state object.
  // Translation and Format have their own controllers/state in
  // separate Maps (see below).
}
```

Actually, **transcript state stays in `states` Map**. Translation and Format state is managed in **separate Maps** (exactly like TextKit):

```javascript
// background.js — new Maps
const translateControllers = new Map();  // Map<tabId, AbortController>
const formatControllers = new Map();     // Map<tabId, AbortController>
let keepAliveIntervalId = null;          // keepAlive timer handle
```

Translation/Format progress is stored in `chrome.storage.local` (survives SW restart), not in the in-memory state object. The popup reads it on init.

### 3.2 chrome.storage.local keys (per-tab, survives SW restart)

| Key | Type | Description |
|-----|------|-------------|
| `transcript:${tabId}` | string | Transcript result text (existing) |
| `tl2Result:${tabId}` | string | Translation result text |
| `tl2Language:${tabId}` | string | Selected language for this tab |
| `tl2Status:${tabId}` | string | Status text ("Translating to Chinese...", "Translation complete.", etc.) |
| `tl2Translating:${tabId}` | boolean | Whether translation is in-flight |
| `fmtResult:${tabId}` | string | Format result text |
| `fmtStatus:${tabId}` | string | Status text ("Formatting...", "Formatting complete.", etc.) |
| `fmtFormatting:${tabId}` | boolean | Whether formatting is in-flight |

### 3.3 chrome.storage.local keys (global, not per-tab)

| Key | Type | Description |
|-----|------|-------------|
| `formatPrompt` | string | Global format prompt text |
| `translatePrompt:${language}` | string | Per-language translation prompt (e.g., `translatePrompt:Chinese`) |
| `tl2PathHistory` | array | Save path history for autocomplete (max 20 entries) |

### 3.4 chrome.storage.sync keys (persisted across devices)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `yt2txtHost` | string | `'localhost'` | YT2TXT backend host (existing) |
| `yt2txtPort` | number | `8666` | YT2TXT backend port (existing) |
| `yt2txtLang` | string | `''` | Language for transcript extraction (existing) |
| `textkitHost` | string | `'localhost'` | **NEW** TextKit backend host |
| `textkitPort` | number | `8765` | **NEW** TextKit backend port |
| `tl2AutoCopy` | boolean | `false` | **NEW** Auto-copy translation |
| `tl2AutoSave` | boolean | `false` | **NEW** Auto-save translation |
| `tl2AutoSavePath` | string | `''` | **NEW** Save path for translation auto-save |
| `yt2txtAutoTranslate` | boolean | `false` | **NEW** Auto-translate when transcript completes |
| `fmtAutoCopy` | boolean | `false` | **NEW** Auto-copy format result |
| `fmtAutoSave` | boolean | `false` | **NEW** Auto-save format result |
| `fmtAutoFormat` | boolean | `false` | **NEW** Auto-format when source text completes |
| `fmtSavePath` | string | `''` | **NEW** Save path for format auto-save |
| `fmtSourceVal` | string | `'transcript'` | **NEW** Default source for Format tab |

### 3.5 Tab-close cleanup

```javascript
chrome.tabs.onRemoved.addListener((tabId) => {
  // Existing cleanup:
  const state = states.get(tabId);
  if (state?.controller) state.controller.abort();
  states.delete(tabId);

  // NEW cleanup:
  handleTranslateStop(tabId);   // abort + clear controller + remove storage
  handleFormatStop(tabId);      // abort + clear controller + remove storage

  chrome.storage.local.remove([
    `transcript:${tabId}`,
    `status:${tabId}`,
    `tl2Result:${tabId}`,
    `tl2Language:${tabId}`,
    `tl2Status:${tabId}`,
    `tl2Translating:${tabId}`,
    `fmtResult:${tabId}`,
    `fmtStatus:${tabId}`,
    `fmtFormatting:${tabId}`,
  ]).catch(() => {});
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
| `translate:start` | popup→bg | `{tabId, text, language, host, port}` | `{ok, error?}` | **NEW** Start translation |
| `translate:stop` | popup→bg | `{tabId}` | `{ok}` | **NEW** Stop translation |
| `format:start` | popup→bg | `{tabId, text, prompt, host, port}` | `{ok, error?}` | **NEW** Start formatting |
| `format:stop` | popup→bg | `{tabId}` | `{ok}` | **NEW** Stop formatting |
| `save:translation` | popup→bg | `{text, path}` | `{ok, path?, error?}` | **NEW** Save text via TextKit `/save` |

### 4.2 Background → Popup (broadcast, no response expected)

| Type | Payload | Description |
|------|---------|-------------|
| `state:update` | `{tabId, state}` | State changed (existing, extended) |
| `translation:update` | `{tabId, text, error?}` | **NEW** Translation result or error |
| `tl2:translating` | `{tabId, value}` | **NEW** Translation in-flight state changed |
| `format:update` | `{tabId, text, error?}` | **NEW** Format result or error |
| `fmt:formatting` | `{tabId, value}` | **NEW** Format in-flight state changed |

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
  ├─→ [if yt2txtAutoTranslate] autoTranslate(tabId, transcriptText)
  │     Reads tl2Language:{tabId} from local storage
  │     If language is "original" with no custom prompt → skip
  │     Calls TextKit /translate
  │     On success → stores tl2Result:{tabId}, broadcasts translation:update
  │     Then triggers auto-copy/auto-save/auto-format for translation (see 5.2)
  │
  └─→ [if fmtAutoFormat AND fmtSourceVal='transcript']
        autoFormat(tabId, transcriptText, textkitHost, textkitPort)
        Reads formatPrompt from local storage
        Calls TextKit /format
        On success → stores fmtResult:{tabId}, broadcasts format:update
        Then triggers auto-copy/auto-save for format (see 5.3)
```

### 5.2 Trigger: Translation completes

```
handleTranslateStart() completes successfully (translated text is non-empty)
  │
  ├─→ [if tl2AutoCopy] copyToClipboard(translatedText)
  │     Uses offscreen document pattern
  │     Shows notification
  │
  ├─→ [if tl2AutoSave AND tl2AutoSavePath] handleSaveTranslation({text, path})
  │     Calls TextKit /save
  │     Shows notification on success/failure
  │
  └─→ [if fmtAutoFormat AND fmtSourceVal='translation']
        autoFormat(tabId, translatedText, textkitHost, textkitPort)
        Same as above — calls TextKit /format
```

### 5.3 Trigger: Format completes

```
handleFormatStart() completes successfully (formatted text is non-empty)
  │
  ├─→ [if fmtAutoCopy] copyToClipboard(formattedText)
  │     Uses offscreen document pattern
  │     Shows notification
  │
  └─→ [if fmtAutoSave AND fmtSavePath] handleSaveTranslation({text, path})
        Calls TextKit /save
        Shows notification on success/failure
```

### 5.4 Cascade scenario

```
Transcript completes
  → auto-translate enabled, language=Chinese
    → auto-format enabled, source=translation
      → Translation completes → auto-format fires
        → Format completes → auto-copy + auto-save fire

AND (in parallel):

Transcript completes
  → auto-format enabled, source=transcript
    → Format completes → auto-copy + auto-save fire
```

**Important**: The two paths (auto-format from transcript vs auto-format from translation) are independent. If both `fmtAutoFormat` with source=transcript AND `yt2txtAutoTranslate` with `fmtAutoFormat` source=translation are enabled, the format will fire twice — once with transcript text, once with translated text. The second run overwrites `fmtResult:{tabId}`. This is expected behavior.

### 5.5 Auto-format helper

```javascript
async function autoFormatIfEnabled(tabId, text, host, port) {
  const { fmtAutoFormat } = await chrome.storage.sync.get({ fmtAutoFormat: false });
  if (!fmtAutoFormat) return;

  const { formatPrompt } = await chrome.storage.local.get('formatPrompt');
  if (!formatPrompt || !formatPrompt.trim()) return;

  // Fall back to stored TextKit backend settings if caller didn't provide
  if (!host || port === undefined) {
    const backend = await chrome.storage.sync.get({
      textkitHost: 'localhost',
      textkitPort: 8765
    });
    host = backend.textkitHost;
    port = backend.textkitPort;
  }

  handleFormatStart({
    tabId, text,
    prompt: formatPrompt.trim(),
    host, port
  }).catch(() => {});
}
```

---

## 6. Storage Keys Summary

### chrome.storage.sync

```
yt2txtHost          string   "localhost"
yt2txtPort          number   8666
yt2txtLang          string   ""          (existing)
textkitHost         string   "localhost" (NEW)
textkitPort         number   8765        (NEW)
tl2AutoCopy         boolean  false       (NEW)
tl2AutoSave         boolean  false       (NEW)
tl2AutoSavePath     string   ""          (NEW)
yt2txtAutoTranslate boolean  false       (NEW)
fmtAutoCopy         boolean  false       (NEW)
fmtAutoSave         boolean  false       (NEW)
fmtAutoFormat       boolean  false       (NEW)
fmtSavePath         string   ""          (NEW)
fmtSourceVal        string   "transcript"(NEW)
```

### chrome.storage.local (global)

```
formatPrompt              string   ""          (NEW)
translatePrompt:${lang}   string   ""          (NEW, one per language)
tl2PathHistory            array    []          (NEW, save path autocomplete)
```

### chrome.storage.local (per-tab, suffixed with `:${tabId}`)

```
transcript:${tabId}       string   (existing)
tl2Result:${tabId}        string   (NEW)
tl2Language:${tabId}      string   (NEW)
tl2Status:${tabId}        string   (NEW)
tl2Translating:${tabId}   boolean  (NEW)
fmtResult:${tabId}        string   (NEW)
fmtStatus:${tabId}        string   (NEW)
fmtFormatting:${tabId}    boolean  (NEW)
```

---

## 7. Backend URL Resolution for Two Backends

YT2TXT uses **two distinct backends**:

| Backend | Default Port | Purpose | Config Keys |
|---------|-------------|---------|-------------|
| YT2TXT | 8666 | Transcript extraction (`/transcript`) | `yt2txtHost`, `yt2txtPort` |
| TextKit | 8765 | Format (`/format`), Translate (`/translate`), Save (`/save`), Prompts (`/prompts/translate`) | `textkitHost`, `textkitPort` |

### Background.js: two cached URL builders

```javascript
// Existing — for transcript extraction
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

// NEW — for TextKit operations (format, translate, save)
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

The `buildBackendEndpoint` and `normalizeBackendSettings` functions are reused — they don't care about the port, and the host validation (localhost-only) is the same for both backends.

### Popup.js: settings UI

The popup shows both backend settings. The existing Host/Port fields are for yt2txt. New TextKit Host/Port fields are added. Both save to `chrome.storage.sync`.

When sending `translate:start` or `format:start` messages, the popup normalizes the TextKit settings and passes `host`/`port` in the message. The background falls back to stored settings if not provided (for auto-actions that fire while popup is closed).

### TextKit backend discovery

When both backends run on the same machine (the common case), the user only needs to change the port. The host defaults to `localhost` for both. The popup can auto-detect this by checking if `textkitHost` is empty and falling back to `yt2txtHost`.

```javascript
// popup.js init:
const items = await chrome.storage.sync.get({
  yt2txtHost: 'localhost', yt2txtPort: 8666,
  textkitHost: '', textkitPort: 8765,
});
// Auto-fill TextKit host from yt2txt host if empty
if (!items.textkitHost) {
  items.textkitHost = items.yt2txtHost;
}
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
- Popup receives error via broadcast message (`translation:update` with `error` field or `format:update` with `error` field)
- Status bar shows the error message
- Button resets to normal state

### 8.4 Invalid input

- Empty source text → Format/Translate button is disabled (UI-level guard)
- Empty prompt → doFormat() returns early with status message "Enter a formatting prompt first."
- Empty save path → save function returns early with status message "Set a Save path first."
- Invalid host/port → `normalizeBackendSettings()` throws, caught by caller, shown in status bar

### 8.5 Concurrent operations

- Starting a new translate while one is in-flight: `handleTranslateStop(tabId)` aborts the old one first
- Starting a new format while one is in-flight: `handleFormatStop(tabId)` aborts the old one first
- Transcript extraction is independent — can run alongside translate/format

### 8.6 SW termination during operation

- `keepAliveIntervalId` prevents SW termination while any operation is in-flight
- All progress state is persisted to `chrome.storage.local` before starting
- On popup reopen, init() reads `tl2Translating:{tabId}` and `fmtFormatting:{tabId}` to restore UI state
- If an operation completed while popup was closed (translating flag set but result exists), the popup shows "Completed while popup was closed"

### 8.7 Popup close during operation

- Operations continue in the background service worker (this is why all API calls are in background)
- Auto-copy uses offscreen document (SW can't access clipboard)
- Auto-save uses background fetch (SW can access fetch)
- When popup reopens, it reads latest results from `chrome.storage.local`

---

## 9. File Changes List

### 9.1 `extension/manifest.json` — MODIFY

- Add `"offscreen"` to permissions
- Add `"clipboardWrite"` to permissions (already has `"downloads"` and `"storage"`)
- Add `"notifications"` to permissions (for auto-copy/auto-save notifications)
- Version bump

### 9.2 `extension/background.js` — MODIFY (major additions)

**New constants:**
- `DEFAULT_TEXTKIT_PORT = 8765`

**New URL resolution:**
- `getTextkitEndpoint(path)` function + cache

**New state management:**
- `translateControllers` Map
- `formatControllers` Map
- `keepAliveIntervalId`
- `startKeepAlive()` / `stopKeepAlive()`

**New message handlers (added to existing `chrome.runtime.onMessage`):**
- `translate:start` → `handleTranslateStart()`
- `translate:stop` → `handleTranslateStop()`
- `format:start` → `handleFormatStart()`
- `format:stop` → `handleFormatStop()`
- `save:translation` → `handleSaveTranslation()`

**New auto-action helpers:**
- `autoTranslate(tabId, text)` — called from `handleStart()` on transcript completion
- `autoFormatIfEnabled(tabId, text, host, port)` — called from translate/format completion
- `autoCopyIfEnabled(text)` — uses offscreen document
- `autoSaveIfEnabled(text)` — calls `/save`
- `fmtAutoCopyIfEnabled(text)` — format-specific auto-copy
- `fmtAutoSaveIfEnabled(text)` — format-specific auto-save

**New clipboard helper:**
- `copyToClipboard(text)` — creates offscreen document, sends copy message

**Modified:**
- `handleStart()` — add auto-translate and auto-format triggers after successful transcript
- `chrome.tabs.onRemoved` — add translate/format cleanup
- `handleStop()` — add translate/format abort

### 9.3 `extension/popup.html` — MODIFY (major additions)

- Add tab bar with three tabs
- Wrap existing transcript UI in `#transcript-panel`
- Add `#format-panel` with all Format tab elements
- Add `#translation-panel` with all Translation tab elements
- Add TextKit Host/Port inputs
- Add collapsible prompt sections with `<details>` elements
- Add tab-switching CSS

### 9.4 `extension/popup.js` — MODIFY (major additions)

**New element references:**
- Tab buttons and panel elements
- All Format tab elements (source selector, prompt textarea, result textarea, buttons, checkboxes, save path)
- All Translation tab elements (language selector, prompt textarea, result textarea, buttons, checkboxes, save path)
- TextKit host/port inputs

**New functions:**
- Tab switching logic
- `doTranslation()` / `stopTranslation()`
- `doFormat()` / `stopFormat()`
- `saveTranslation()` / `saveFormatResult()`
- `copyResult()` / `downloadAsFile()` (reusable for both tabs)
- `setTl2Progress()` / `setFmtProgress()`
- `updateTranslationButtons()` / `updateFormatButtons()`
- `saveTl2Settings()` / `saveFormatSettings()`
- `saveTl2Language()`
- `loadPromptForLanguage()` — fetch from TextKit backend, fallback to local storage
- `saveTranslatePrompt()` — save to local storage, sync to backend
- `loadPathSuggestions()` / `updatePathSuggestions()` / `fetchPathSuggestions()`
- `saveTextkitBackend()` — save TextKit host/port to sync storage

**New message listeners:**
- `translation:update` — update translation result
- `tl2:translating` — update translate button state
- `format:update` — update format result
- `fmt:formatting` — update format button state

**Modified:**
- `init()` — load TextKit settings, translation language, format prompt, restore per-tab results
- `renderState()` — update new tab button states when transcript changes
- `saveSettings()` — rename to `saveYt2txtSettings()` and add `saveTextkitSettings()`

### 9.5 `extension/offscreen.html` — NEW FILE

Minimal HTML document that loads offscreen.js. Exact copy from TextKit.

### 9.6 `extension/offscreen.js` — NEW FILE

Clipboard handler using hidden textarea + `execCommand('copy')`. Exact copy from TextKit.

### 9.7 CSS changes

The existing yt2txt popup.css (inline in popup.html) uses a dark-first theme with `@media (prefers-color-scheme: light)` overrides. The new tab UI must follow the same style:

- Tab bar: dark background (`#1e293b`), active tab with blue bottom border (`#38bdf8`), inactive tabs gray (`#94a3b8`)
- Collapsible sections: use `<details>` with styling matching existing `.settings` style
- Status bars: same pattern as existing `#status-bar` (one per tab: `#status-bar`, `#fmt-status-bar`, `#tl2-status-bar`)
- Option rows: flex row with checkbox labels, matching existing style
- Save path inputs: styled like existing `.settings input`

---

## 10. Popup Init Flow (restore state on reopen)

```
popup.js init()
  1. Query active tab → currentTabId
  2. Load sync settings:
     - yt2txtHost, yt2txtPort, yt2txtLang (existing)
     - textkitHost, textkitPort (NEW)
     - tl2AutoCopy, tl2AutoSave, tl2AutoSavePath, yt2txtAutoTranslate (NEW)
     - fmtAutoCopy, fmtAutoSave, fmtAutoFormat, fmtSavePath, fmtSourceVal (NEW)
  3. Pre-fill URL from current tab (existing)
  4. Refresh transcript state from background (existing)
  5. Load persisted transcript result (existing)
  6. Load translation tab state:
     - tl2Language:{tabId} → set language selector
     - tl2Result:{tabId} → fill textarea, enable buttons
     - tl2Status:{tabId} → set status bar
     - tl2Translating:{tabId} → restore "Stop" button if was translating
     - Handle "completed while closed" case:
       if translating && has result → show result, clear translating flag
       if translating && no result → show "Stop" button
  7. Load format tab state (same pattern):
     - formatPrompt → fill prompt textarea
     - fmtResult:{tabId} → fill textarea, enable buttons
     - fmtStatus:{tabId} → set status bar
     - fmtFormatting:{tabId} → restore "Stop" button if was formatting
  8. Load translation prompt for current language:
     - Try TextKit backend /prompts/translate?language=X
     - Fallback to translatePrompt:{lang} in local storage
  9. Load path suggestions from TextKit backend /paths
  10. Update all button states
```

---

## 11. Design Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Prompt placement | Inline per-tab, collapsible with `<details>` | Keeps 3 tabs, avoids context-switching, each prompt lives with its operation |
| Format source default | "Transcript" | Primary workflow: get transcript → clean it up. Translation is secondary. |
| Auto-format chain | Independent triggers (not chained) | Transcript→Format and Transcript→Translate→Format are separate. Both can fire; the last one wins for fmtResult. |
| Save message type | Reuse `save:translation` for both | TextKit does this — the `/save` endpoint is the same regardless of what text is being saved |
| Prompt scope | Format: global. Translation: per-language. | Format prompt is a reusable template. Translation prompt must vary by target language. |
| Backend discovery | Auto-fill textkitHost from yt2txtHost if empty | Common case: both backends on same machine, different ports |
| Notifications | Use `chrome.notifications` for auto-copy/auto-save | User needs feedback when auto-actions fire while popup is closed |
| Tab order | Transcript → Format → Translation | Matches primary workflow: extract → clean → translate |
