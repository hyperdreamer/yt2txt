# Local Video File Transcription — Design

- **Date:** 2026-10-11
- **Topic:** local-video-file-transcription
- **PM run:** pm-run-20261011-114932-0005f5e8
- **Base commit:** `0e3834c8506a259dc2ec4252ecd8a48496161ae3` (main)
- **Status:** design approved by the user; review #1 raised 4 blockers (all resolved); review #2 returned **CLEAN** (0 blockers, 12 notes applied); review #3 verified those dispositions, confirmed the corrected measurement independently, and raised 1 blocker (resolved) plus 6 note residuals (applied) — see Appendices A–C

## 1. Background

yt2txt transcribes web URLs today. The user wants the same for **local video files**, e.g.

```
file:///home/henry/Dropbox/011.UKM_Math/3.Semester/07.Art_Criticism/02.Videos/ART_CRITICISM_-_ASSIGNMENT_BRIEFING.mp4
```

by extracting the audio with FFmpeg and sending it for transcription.

The entry point is the browser itself: the user opens the video in Chrome, the popup prefills the
`file://` tab URL into the existing URL box, and the backend reads the file from disk. The extension
never reads the file; it only forwards a path string.

### Evidence that no existing path can handle a local file (measured on this machine, 2026-10-11)

`yt-dlp 2026.08.19`, `ffmpeg n9.0.2`; 1-second generated `test.mp4` fixture in a scratch directory.

| Probe | Result |
| --- | --- |
| `yt-dlp --print id file:///tmp/pmprobe/test.mp4` | ❌ `ERROR: file:// URLs are disabled by default in yt-dlp for security reasons` |
| `yt-dlp --print id /tmp/pmprobe/test.mp4` (bare path) | ❌ `ERROR: [generic] '/tmp/pmprobe/test.mp4' is not a valid URL` |
| `yt-dlp -f bestaudio --extract-audio … file:///tmp/pmprobe/test.mp4` | ❌ same `file:// URLs are disabled` failure |
| `yt-dlp --enable-file-urls -f bestaudio … file:///tmp/pmprobe/test.mp4` | ❌ `ERROR: [generic] test: Requested format is not available` — the generic extractor exposes no `bestaudio` format for a plain local file |
| `ffmpeg -y -i test.mp4 -vn -b:a 64k -ac 1 direct.mp3` | ✅ `size=9KiB time=00:00:01.00 bitrate=69.7kbits/s speed=43.2x` |
| `ffmpeg -hide_banner -i test.mp4` | ✅ stream listing available, so embedded subtitle tracks are discoverable |

Conclusion: local files require a **new, dedicated pipeline**. yt-dlp cannot be salvaged for them
even with `--enable-file-urls`, and that flag is intentionally not used anywhere in this design.

### Current backend flow (`backend/main.py`, 1180 lines)

`POST /transcript` → validate `url` → cache lookup via `_extract_video_id(url)` (yt-dlp `--print id`,
15 s timeout) → `_download_subs_manual` → `_download_subs_auto` → yt-dlp audio download
(`-f bestaudio --extract-audio --audio-format mp3 --postprocessor-args "ffmpeg:-b:a 64k -ac 1"`)
→ `_transcribe_audio` (size/duration splitting + output-token-cap bisection) → cache put.

Everything upstream of `_transcribe_audio` is yt-dlp-bound, which is why a local file fails today.
`_extract_video_id` additionally attempts a yt-dlp lookup for every local request before falling back
to hashing the URL (measured cost ~0.95 s: yt-dlp exits immediately on the local-path error; 15 s is
its bound, not its cost). Local inputs bypass it entirely.

## 2. Approved decisions

| ID | Decision | Chosen option |
| --- | --- | --- |
| **D1** | Entry point for local paths | Active `file://` tab URL auto-prefilled into the existing URL box; a pasted raw absolute path also works. No file picker, no upload. |
| **D2** | Subtitles before transcription | **Subtitle-first**: sidecar files, then embedded text subtitle streams, then audio → transcription. |
| **D3** | Path access policy | `local_files.allowed_roots` in `config.yaml`; **empty = unrestricted**; non-empty restricts to resolved paths under those roots. |
| **D4** | UI presentation of the input source | **Auto-detected source chip** under the URL input (`U2`), display-only, hidden for unrecognised input. |
| **D5** | Backend structure | **Unified `/transcript` contract** + new deep module `backend/local_file.py`; detection is additive; no new endpoint; no extension-side routing. |
| **D6** | Client timeout | `TRANSCRIPT_TIMEOUT_MS` raised 15 min → 120 min (safe because the keepalive lane now keeps the service worker alive). |

## 3. Goals

1. `POST /transcript` transcribes a local video file given a `file://` URL or an absolute (or `~/`)
   path, with no change to the request/response contract and no extension-side routing.
2. Local subtitles are used when present (sidecar, then embedded), avoiding transcription cost.
3. Local results are cached with content-sensitive keys covering both the video **and** any sidecar
   subtitle input, so neither a re-exported video nor an edited sidecar can serve a stale transcript.
4. The popup makes it obvious whether the current input was recognised as a local file or a web URL,
   before the user clicks.
5. No currently-succeeding input changes behaviour, including scheme-relative (`//host/…`) URLs that
   yt-dlp accepts today.
6. The pipeline is testable without a browser, without network access, and without the user's files.

## 4. Non-goals

- Browser file picker or uploading file bytes to the backend.
- File Bridge (`:8964`) path autocomplete for the URL box.
- Windows drive-letter path support. `C:\Users\x.mp4` is not a local-file input; it is classified WEB
  and fails with yt-dlp's existing `not a valid URL` error (unchanged behaviour, not a new error).
- OCR of bitmap subtitle tracks (`hdmv_pgs_subtitle`, `dvd_subtitle`, `dvb_subtitle`).
- Batch / multiple-file selection, playlists, or directory input.
- Changes to TextKit (`:8765`) or File Bridge (`:8964`).
- New `manifest.json` permissions (none are required).
- Per-audio-track selection: the first audio stream wins (documented limitation).

## 5. Architecture

### 5.1 Module seam

New module `backend/local_file.py` owns everything local-file-specific:

```python
prepare(raw: str, allowed_roots: tuple[Path, ...], debug: Logger) -> LocalTarget | None  # classify + validate + gate + key
probe_streams(path: str, debug: Logger) -> StreamProbe                                    # one bounded ffprobe
await try_subtitles(target: LocalTarget, debug: Logger) -> tuple[str, str] | None         # (text, model); sidecar, then embedded
await extract_audio(target: LocalTarget, tmpdir: str, debug: Logger) -> str               # -> mp3 path
parse_subtitle_text(content: str) -> str                                  # SRT/VTT -> plain text
is_text_subtitle_codec(codec: str) -> bool                                # usable vs bitmap/unknown
```

- `prepare()` returns `None` when the input is not a local-file input, so the caller's existing web
  pipeline runs unchanged.
- `allowed_roots` are `Path` objects already resolved at config load (section 11); `prepare()` does
  not re-resolve them.
- `Logger` is `Callable[[str, str], None]` (tag, message). Every local entry point takes it because
  `local_file` must not import `main`; `main.py` injects its own `_debug`, so skipped-sidecar and
  skipped-codec diagnostics promised in 5.4 and 6 are actually deliverable.
- The module **never imports `main`** (no cycle). `main.py` keeps orchestration, cache
  read/write, and the existing `_transcribe_audio` call.
- `_parse_subtitle_text(path)` stays in `main.py` as a thin file-reading wrapper over
  `local_file.parse_subtitle_text(content)`, so the URL flow and any external caller are unaffected.
  The string form is needed because embedded subtitles are extracted to stdout, not to a file.
- `LocalTarget` is a frozen dataclass: `raw`, `path` (resolved `Path`), `sidecar_fingerprint` (str),
  `cache_key` (str), `size` (int), `mtime_ns` (int), and `streams: StreamProbe`.
- **The probe result travels on the target — that is what makes "one probe" achievable.**
  `prepare()` runs `probe_streams()` once, applies the usability gate with that result, and stores it
  on the returned `LocalTarget`; `try_subtitles()` reads `target.streams.subtitle_candidates` and never
  probes again. `StreamProbe` is a frozen dataclass
  `{ok: bool, has_audio: bool | None, subtitle_candidates: tuple[StreamCandidate, ...]}`, where
  `ok is False` means streams are unknown (timeout, non-zero exit, or unparseable JSON) and
  `has_audio`/`subtitle_candidates` are then `None`/empty. Declaring the carrier here is deliberate:
  without it, an implementer must either probe twice or silently extend the seam.

`main.py::transcript` becomes, in order:

```python
target = local_file.prepare(url, config.local_files.allowed_roots, _debug)
if target is not None:
    # local branch: cache -> subtitles -> audio -> _transcribe_audio -> cache
else:
    # existing web branch, unchanged
```

### 5.2 Classification (ordered, additive)

```
raw → strip
 ├─ starts with "//"                          → WEB  (scheme-relative URL; yt-dlp handles these today)
 ├─ URL scheme is "file" (case-insensitive)   → LOCAL
 ├─ starts with "/"                           → LOCAL (already absolute)
 ├─ starts with "~/" or "~"                   → LOCAL (expanduser)
 └─ anything else                             → WEB  (existing yt-dlp pipeline, unchanged)
```

- `//host/path` is deliberately **not** local: `yt-dlp --print id "//www.youtube.com/watch?v=dQw4w9WgXcQ"`
  currently returns `dQw4w9WgXcQ`, and this feature must not break it. This ordering is what makes the
  additive claim true, and it is pinned by a regression test.
- The `file` scheme is detected via `urlparse(raw).scheme.lower() == "file"`, so `FILE:///x` and
  `file:/x` are accepted (RFC 3986 schemes are case-insensitive); a lowercase literal prefix test
  would not do this.
- A relative path such as `Downloads/x.mp4` stays WEB and fails exactly as it does today
  (`yt-dlp: not a valid URL`). `http`, `https`, `rtmp`, `magnet`, and arbitrary junk keep their
  current code path.

### 5.3 Path normalisation

Applied only after classification says LOCAL. The `file:`-scheme rows are parsed as URLs; raw
absolute and `~` inputs are **not** URL-parsed — after `expanduser` they are used verbatim, so a legal
filename containing a literal `?` or `#` (e.g. `/a/my?file.mp4`) works. Query/fragment rejection
below therefore applies to `file:`-scheme inputs only.

| Input | Result |
| --- | --- |
| `file:///home/henry/Dropbox/02.Videos/A%20B.mp4` | `/home/henry/Dropbox/02.Videos/A B.mp4` |
| `FILE:///home/henry/x.mp4`, `file:/home/henry/x.mp4` | `/home/henry/x.mp4` |
| `file://localhost/home/henry/x.mp4` | `/home/henry/x.mp4` (netloc must be empty or `localhost`) |
| `file://otherhost/home/x.mp4` | **400** `file:// URLs with a remote host are not supported: otherhost` |
| `file://home/henry/x.mp4` | **400**, same remote-host message (netloc is checked before path shape) |
| `file://x.mp4` | **400**, same remote-host message (netloc is `x.mp4`; no path is parsed at all) |
| `file://` (empty authority and path) | **400** `file:// URL must have an absolute path` |
| `file:///home/henry/My%2BVideo.mp4` | `/home/henry/My+Video.mp4` (`unquote`, not `unquote_plus`) |
| `file:///a/My%3FVideo.mp4` | `/a/My?Video.mp4` (percent-encoded `?` is a filename character) |
| `/a/my?file.mp4` (raw path) | `/a/my?file.mp4` verbatim — no URL parsing, no truncation |
| `file:///x/a.mp4?q=1` or `…/a.mp4#frag` | **400** `file:// URLs must not contain a query or fragment; percent-encode literal ? and # as %3F and %23` |
| `/home/henry/…/video.mp4` | unchanged |
| `~/Dropbox/video.mp4` | `$HOME/Dropbox/video.mp4` |
| `file:///C:/Users/x.mp4` | `/C:/Users/x.mp4` → 404 with the path quoted (clear, not silent) |

Query/fragment are rejected rather than ignored, because truncating a filename at a raw `?` or `#`
would silently read the wrong file. Order of checks: netloc → path shape → query/fragment.

### 5.4 Validation and access policy

ffmpeg/ffprobe presence is checked with `shutil.which` **first** and missing tools are a hard **500**
`ffmpeg is not installed.` (mirroring the existing yt-dlp message). The probe is required for the
usability gate, so its absence must not be silently downgraded into a confusing downstream failure.

Then, in this order, on the **resolved** path (`Path.expanduser().resolve()`):

1. **Allowlist (403)** — when `allowed_roots` is non-empty, the resolved path must be inside a
   resolved root (`Path.is_relative_to`). Resolving happens before the check, so a symlink inside an
   allowed root cannot escape it. The error quotes the configured roots so a typo in `config.yaml`
   is self-diagnosing. Empty `allowed_roots` skips this step entirely.
2. **Existence (404)** — `path.exists()`, else `Local file not found: <resolved path>`.
3. **Regular file (400)** — `path.is_file()`, else `<resolved path> is not a regular file`.
4. **Readable (403)** — `os.access(path, os.R_OK)`.
5. **Usability gate (400)** — at least one of:
   - an audio stream, **or**
   - a text-capable embedded subtitle stream (`is_text_subtitle_codec`), **or**
   - a usable sidecar subtitle file.
   Else `No audio or subtitle stream found in: <resolved path>`.

   Both stream arms and the embedded-subtitle enumeration come from **one** helper, `probe_streams(path)`,
   which runs a single bounded call and reports `has_audio` plus the ordered subtitle candidates:

   ```
   ffprobe -v error -show_entries stream=index,codec_type,codec_name:stream_tags=language -of json
   ```

   Bound: **30 s**. A **successful** probe yields `has_audio` and the ordered subtitle candidates. A
   timeout, non-zero exit, or unparseable JSON means **streams unknown**: it is not a request failure
   and never a 500 — the gate passes optimistically, section 6 finds no embedded candidates, and the
   cascade proceeds (sidecar → audio extraction). Extraction is the authoritative check: if the file
   really has no audio stream, ffmpeg's non-zero exit reports `Failed to extract audio: …` (400) with
   a real message. The gate therefore rejects with 400 only when a *successful* probe positively shows
   no audio stream and no text subtitle stream **and** no usable sidecar exists.

   **Sidecar candidate** is structural: (a) when `allowed_roots` is non-empty, its resolved path is
   inside them (with empty roots this condition is skipped, per D3); and (b) it is a regular readable
   file. **Usable sidecar** adds (c) it yields non-empty parsed text via `parse_subtitle_text`.
   The gate requires a *usable* sidecar; the cache fingerprint (5.5) covers all *candidates*.
   Condition (c) is what keeps the gate and the cascade consistent: with no audio, no text subtitle
   stream, and only an empty sidecar, the request deterministically fails with
   `No audio or subtitle stream found in: <resolved path>` (400) rather than reaching audio
   extraction and failing with a misleading ffmpeg message. When the file *does* have audio, an empty
   sidecar simply falls through in the cascade.

   The sidecar arm is essential: a file whose only text is in a sidecar `.srt` must return that text
   (D2), not be rejected for lacking streams. Sidecar discovery is cheap and deterministic, so the
   gate consulting it costs one directory listing plus a few small file reads.

Sidecar candidates are subject to the same allowlist rule: a candidate whose **resolved** path falls
outside `allowed_roots` is skipped (logged via the injected `debug` logger, never read) instead of
failing the request, so a stray symlinked sidecar cannot block transcription of an otherwise valid
video. Such a candidate is not "usable" for the gate either, so it neither authorises the request nor
can be returned as its result.

### 5.5 Caching

No schema change; the existing `transcript_cache(video_id PK, text, source, created_at)` table is
reused, and `_cache_get` is reused verbatim. The local key must change whenever *any* input to the
result changes — the video **and** the sidecar subtitles:

```
path_hash    = sha256(str(resolved_path))[:16]                       # groups rows for one file path
content_hash = sha256(f"{size}\0{mtime_ns}\0{sidecar_fingerprint}")[:16]
cache_key    = f"local:{path_hash}:{content_hash}"
```

- `sidecar_fingerprint` is computed from the deterministic, ordered list of **candidate** sidecars
  (section 6 step 1): `"|".join(f"{resolved}\0{stat.st_size}\0{stat.st_mtime_ns}")`, or
  `"-"` when there are none. Candidates are structural (allowlist + regular + readable), so this
  deliberately includes a candidate whose text is empty: it covers all discovered candidates, not
  just the selected one, so adding, removing, renaming, or editing any sidecar changes the key.
  Including an empty file only ever makes the key stricter, never staler.
- Embedded subtitles live inside the container, so `size` + `mtime_ns` already cover them.
- Editing a sidecar therefore forces a cache miss (design review blocker #3), as does re-exporting
  the video. A path-only key would be a correctness bug.
- **Stale-key cleanup:** the new helper `_cache_put_local(video_id, text, source, ttl_days, path_hash)`
  opens **one** connection and performs, before a single commit: `INSERT OR REPLACE`, the existing
  TTL prune, and
  `DELETE FROM transcript_cache WHERE video_id LIKE 'local:<path_hash>:%' AND video_id <> ?` —
  so re-exports and sidecar edits do not accumulate rows and the whole write is atomic. There is no
  intermediate commit, which is what makes "in the same transaction as the insert" literally
  satisfiable; a shared private `_cache_write(conn, …)` may be extracted from `_cache_put`, but that
  is an implementation choice, not a requirement. `_cache_put` keeps its current signature and
  behaviour for the web path. `path_hash` is lowercase hex, so the `LIKE` pattern cannot over-match.
- `force: true` skips the read, exactly as for web URLs; successful results are then written.
- TTL is the existing `cache.ttl_days` and the existing daily prune applies unchanged.
- `_extract_video_id()` is **bypassed** for local inputs; it is never called with a local path.

### 5.6 Response contract (unchanged)

`{"text": str, "source": "subtitles"|"transcription", "model": str, "error": null}`

| Origin | `source` | `model` |
| --- | --- | --- |
| Sidecar subtitle file | `subtitles` | `"sidecar"` |
| Embedded subtitle stream | `subtitles` | `"ffmpeg"` |
| Audio transcription | `transcription` | the real model name |
| Cache hit (any origin) | stored value | `"cached"` |

`"sidecar"` is used because no ffmpeg run produced that text; claiming `"ffmpeg"` would be
inaccurate. Existing web-URL values (`"yt-dlp"`, model name, `"cached"`) are unchanged.

## 6. Subtitle cascade

Steps are ordered, local-only, and cost zero API tokens. The first step producing non-empty text
wins; otherwise the flow falls through to audio extraction.

1. **Sidecar files**, in the video's directory, matched by stem:
   `<stem>.srt` / `.vtt` (extension case-insensitive), then `<stem>.<lang>.srt|vtt` with
   English-likes (`en`, `en-*`, `eng`) first and the remainder sorted deterministically.
   A **sidecar candidate** counts only if, when `allowed_roots` is non-empty, it resolves inside them,
   and it is a regular readable file (the structural conditions of 5.4). An unreadable, empty, or
   whitespace-only sidecar falls through rather than erroring, and a whitespace-only one is not
   "usable". Selection takes the **first candidate in the order below that yields non-empty parsed
   text**; parsing uses `parse_subtitle_text`. The full candidate list (empty files included) is what
   feeds `sidecar_fingerprint` (5.5).
2. **Embedded subtitle streams**:
   - Use the subtitle candidates from `probe_streams()` (section 5.4's single 30 s bounded call; no
     second probe). When that probe failed or returned unusable output there are no embedded
     candidates → fall through to audio (not a request failure).
   - Usable codecs only, per `is_text_subtitle_codec`: `subrip`, `srt`, `ass`, `ssa`, `webvtt`,
     `mov_text`, `text`, `ttml`. Bitmap codecs (`hdmv_pgs_subtitle`, `dvd_subtitle`, `dvb_subtitle`,
     `xsub`) **and unrecognised codecs** (`eia_608`, `dvb_teletext`, anything else) are skipped with
     a `_debug` log — they need OCR or are unknown, and shipping garbage text would be worse than
     transcribing.
   - Deterministic selection: English-like language tag, then `und`/untagged, then lowest stream index.
   - Extraction to stdout, no temp file, timeout **120 s**:
     `ffmpeg -nostdin -v error -i <video> -map 0:<global index> -f srt -`
     **`<global index>` is ffprobe's `stream.index`, not a subtitle ordinal** — ffmpeg's `0:s:N`
     counts subtitle streams only, so `-map 0:s:3` on a file whose subtitle is global stream 3 fails
     with `Stream map matches no streams` (verified on a generated MKV). `-map 0:<index>` is
     unambiguous, and a fixture where the subtitle's global index differs from its ordinal pins it.
   - Empty output, whitespace-only output, non-zero exit, or timeout → try the next candidate
     stream → then fall through to audio. Subtitle problems never fail the request.
3. **Audio extraction → transcription** (section 7).

## 7. Audio extraction

One ffmpeg call, with audio settings identical to the yt-dlp path so every downstream threshold
keeps its current meaning:

```
ffmpeg -nostdin -v error -y -i <video> -vn -sn -dn -map 0:a:0 -b:a 64k -ac 1 <tmpdir>/<stem>.mp3
```

- Same `64k` mono mp3 as `--postprocessor-args "ffmpeg:-b:a 64k -ac 1"` ⇒ `MAX_AUDIO_BYTES`,
  `MAX_AUDIO_DURATION`, span splitting, and the 2048-token cap-bisection apply unchanged.
- `-map 0:a:0` selects the first audio stream explicitly; multi-track files transcribe track 0.
- Output goes into the existing `tempfile.TemporaryDirectory()`; chunk files land in
  `<tmpdir>/chunks` exactly as they do today. Nothing new to clean up.
- Bounds and failure mapping: 900 s extraction timeout → **504**
  `Timed out extracting audio from <path>`; ffmpeg non-zero exit → **400** with a ≤300-char stderr
  tail (matching `_extract_segment`'s existing style). These are the only local-file failures that
  fail the request — subtitle problems fall through instead.
- Measured extraction speed on the probe fixture: ~43× realtime, so extraction is seconds for a
  lecture; the transcription API remains the only slow stage.

Transcription itself calls the unchanged `_transcribe_audio(audio_path, config, model)`.

## 8. Data flow

```
popup (file:// tab prefill or pasted path) ──popup:start──▶ background.js handleStart
   └── POST /transcript {url: "file:///…", force}
         └── prepare() → LOCAL
               ├── cache hit ──────────────────────────▶ return {text, source, model:"cached"}
               └── miss
                     ├── try_subtitles() → text ──────▶ cache put (sidecar | ffmpeg)
                     └── none
                           ├── extract_audio() → mp3
                           ├── _transcribe_audio() ────▶ cache put (transcription)
                           └── return {text, source:"transcription", model}
```

`background.js` needs **no** change to route local inputs: it already forwards `msg.url` verbatim
(`extension/background.js:371`).

## 9. Extension UI

### 9.1 Mockup (D4 / U2 — approved)

```
┌──────────────────────────────────────────────────────┐
│ [file:///home/henry/Dropbox/011.UKM_Math/….mp4     ] │
│  📁 Local file · ART_CRITICISM_-_ASSIGNMENT_BRIEFING.mp4
└──────────────────────────────────────────────────────┘
                          ↑ "🌐 Web URL · youtube.com" for http(s) input
```

### 9.2 Chip specification

- Markup in `#transcript-panel` directly below the `#url` input:
  `<div id="source-chip" class="source-chip hidden"><span id="source-chip-icon"></span><span id="source-chip-label"></span></div>`.
  The element starts hidden; `.hidden` is the existing utility class.
- `classifyInput(raw)` in `popup.js` is a **pure, display-only** helper returning `null` (chip hidden)
  or `{kind: 'local'|'web', label: string, title: string}`. It mirrors the backend rules in the same
  order, which matters for `//host/…`: evaluate `starts with "//"` → `null` (hidden) **first**, then
  `/^file:/i` → local, then `startsWith('/')` → local, then `~`/`~/` → local, else web. The backend
  stays authoritative: a mismatch can only mislabel a chip, never change an action.
- Labels: `Local file · <basename>` (extension kept) and `Web URL · <hostname>`.
- `title` carries the full decoded path / full URL, so an ellipsized long name is still inspectable.
- Hidden (never wrong) for empty input, relative paths, `//host/…`, and unrecognised schemes.
- Updates on the input `input` event and after the init prefill.
- Meaning is carried by icon **and** text, not colour alone; the existing palette is reused
  (`#1e293b` surface, `#94a3b8` text, `#38bdf8` accent).

### 9.3 Client timeout (D6)

`TRANSCRIPT_TIMEOUT_MS` in `background.js` changes from `15 * 60 * 1000` to `120 * 60 * 1000`, with a
comment stating that it is safe only because the keepalive lane keeps the worker alive. A 2-hour
lecture chunked at 24 MB / 1300 s can exceed 15 minutes, and the current timeout aborts a request the
backend keeps working on. The user-facing **Stop** button remains the manual early exit.
`BACKEND_TIMEOUT_MS` (format/translate) is untouched.

The abort message is currently hard-coded as `"Request timed out after 15 minutes."`
(`background.js:404`) and must stop carrying its own copy of the duration. Build it in a pure
`formatTimeoutMessage(ms)` helper ("…after N minutes", minutes derived from the constant; the value
is always a whole number of minutes) and pin it with a source-level
`tests/background.test.js` (section 12.5), so the stale-literal regression cannot return.

### 9.4 Result persistence for local inputs

Results are stored as `{text, url}` under `transcript:<tabId>` and restored only when
`entry.url === tab.url` (`popup.js:275`). A pasted raw path never equals a tab URL, so today that
class of result would not come back after a service-worker restart. One normaliser fixes it:

```
sourceKey(raw) = decoded absolute path   when raw classifies as local
               = raw                      otherwise
```

Restore rule, stated exactly — an entry matches when **either** holds:

```
entry.url === tab?.url                                          # legacy/existing comparison
|| sourceKey(entry.url) === sourceKey(tab?.url ?? '')            # local-path equivalence
```

where `sourceKey(raw)` is:

| `raw` | `sourceKey(raw)` |
| --- | --- |
| `file:` scheme (case-insensitive) | `decodeURIComponent(new URL(raw).pathname)`, falling back to `raw` if **either** `new URL` or `decodeURIComponent` throws (the WHATWG parser accepts malformed sequences such as `file:///a/50%off.mp4`, which `decodeURIComponent` then rejects) |
| starts with `/` | `raw` verbatim (never `decodeURI`-ed, so a literal `%` cannot throw) |
| starts with `~` | `raw` verbatim (the popup cannot expand `~`, so a `~` path is compared literally and is not restored from the equivalent `file:///home/…` form — a documented, low-impact gap) |
| anything else | `raw` verbatim |

`decodeURIComponent` is required rather than `decodeURI`: it decodes `%3F`/`%23` to `?`/`#` the same
way the backend's `unquote` does, so `file:///a/My%3FVideo.mp4` and `/a/My?Video.mp4` are the same key,
and it cannot be applied to raw paths at all (a literal `%` throws). Consequences:

- `file:///a/My%20Video.mp4` and `/a/My Video.mp4` are the same key, so the primary D1 flow
  (file tab, SW restart, reopen) restores as before.
- A raw path pasted while sitting on a tab whose URL is a web address is **not** auto-restored on
  reopen: it is stored under the tab id, but the second disjunct compares local-vs-web keys and the
  first compares the raw path with the page URL, so neither matches, and the `{text, url}` schema does
  not record the tab URL that was current at request time. Nothing is lost — the transcript is already
  in the backend cache, so pressing Get Transcript again returns it in one instant round trip. This is
  the existing, already-accepted behaviour for a mismatched tab, now stated explicitly.

Storage schema is unchanged (still `{text, url}`).

## 10. Error handling

| Condition | Status | Message |
| --- | --- | --- |
| Empty input, popup side | — | `Enter a video URL or a local video path (for example the file:// URL of a video open in this tab).` |
| `file://` with a remote host | 400 | `file:// URLs with a remote host are not supported: <host>` |
| `file://` with no absolute path | 400 | `file:// URL must have an absolute path` |
| `file://` with query/fragment | 400 | `file:// URLs must not contain a query or fragment; percent-encode literal ? and # as %3F and %23` |
| Path outside `allowed_roots` | 403 | `Path is outside local_files.allowed_roots (configured: <roots>): <path>` |
| Path missing | 404 | `Local file not found: <path>` |
| Path is not a regular file | 400 | `<path> is not a regular file` |
| Path unreadable | 403 | `<path> is not readable` |
| No audio, no text subs, no usable sidecar (successful probe) | 400 | `No audio or subtitle stream found in: <path>` |
| ffmpeg/ffprobe missing | 500 | `ffmpeg is not installed.` |
| Audio extraction non-zero exit | 400 | `Failed to extract audio: <stderr tail>` |
| Audio extraction timeout | 504 | `Timed out extracting audio from <path>` |
| Sidecar read/parse failure, embedded stream failure or timeout | — | not an error: `_debug` log, try the next candidate, then audio |

All of these flow through the existing `payload.error || payload.detail` path in `background.js`, so
no new client-side error plumbing is required.

**Prefill works unconditionally — measured, not assumed.** Chromium exposes `file://` tab URLs to any
extension holding the `tabs` permission, regardless of the "Allow access to file URLs" toggle: with
the current manifest and `chrome.extension.isAllowedFileSchemeAccess() === false`, headless
Chromium 153 returned `file:///tmp/fe/testfile.html` from `chrome.tabs.query`. That toggle governs
content-script and host access to `file://` pages, which this extension never uses. So the primary D1
flow needs no user setup at all, and the empty-input message above deliberately does **not** ask the
user to enable a toggle. Pasting a path remains the fallback for a file that is not open in a tab.

## 11. Configuration

```yaml
local_files:
  allowed_roots: []      # empty = unrestricted
```

- Parsed like the existing `ai.timeout` block: a non-mapping section raises `RuntimeError`, unknown
  keys raise `RuntimeError`, entries must be non-empty strings, a non-list value (e.g.
  `allowed_roots: /videos`) raises `RuntimeError`, and `~` is expanded. After expansion every entry
  must be **absolute**; a relative entry raises `RuntimeError`, because a relative root would silently
  resolve against the backend's process CWD and produce an allowlist nobody intended.
- Roots are resolved (`Path.expanduser().resolve()`) **once at config load** and stored in
  `AppConfig.local_files.allowed_roots` as `tuple[Path, ...]`; `prepare()` receives exactly that and
  performs no further resolution (the per-request path is resolved, the roots are not re-resolved).
  Order matters: the absolute-path check runs **after** `expanduser` but **before** `resolve()`, since
  `resolve()` would make a relative entry absolute and silently defeat the check.
- Root existence is not required (an offline mount must not prevent the backend from starting).
- `config.example.yaml` documents the new block; it is additive, so an existing `config.yaml`
  without the section keeps working with `allowed_roots = ()` (unrestricted).

## 12. Test strategy

All Python tests are pytest, importing `backend/main.py` the way `tests/test_config.py` already does.
Fixtures are generated with ffmpeg into `tmp_path`; tests `pytest.skip` when ffmpeg or ffprobe is
absent. No test requires network access or the user's files.

### 12.1 `tests/test_local_file.py`

| Area | Cases |
| --- | --- |
| Classification | `file:///a/b%20c.mp4` decodes; `FILE:///a/b.mp4` and `file:/a/b.mp4` accepted; `file://localhost/…` accepted; `file://otherhost/…`, `file://x.mp4` and `file://home/henry/x.mp4` → 400 remote-host (**pins netloc-before-path**); `file://` → 400 absolute-path; `file:///a.mp4?q=1` and `…/a.mp4#f` → 400; `file:///a/My%3FVideo.mp4` → `/a/My?Video.mp4` accepted; raw `/a/my?file.mp4` → accepted verbatim (no URL parsing of raw paths); `~/x` expands; `/abs/x` accepted; `https://…` → `None`; `//www.youtube.com/watch?v=…` → `None` (**web-regression guard**); `Downloads/x.mp4` → `None`; `rtmp://…` → `None`; `C:\Users\x.mp4` → `None` |
| Access policy | empty roots = unrestricted; inside root allowed; outside root → 403; **symlink inside root pointing outside → 403**; `..` traversal outside root → 403; roots quoted in the message; **symlinked sidecar escaping the roots is skipped, request still succeeds** |
| Validation | missing → 404; directory → 400; unreadable → 403 (`chmod 000`, skipped when running as root); **no audio + usable sidecar → subtitles result, not 400** (also run with empty `allowed_roots`); **a successful probe showing no audio, no text subs and no usable sidecar → 400**; **no audio + only an empty sidecar → 400** (gate/cascade agree, pins the deterministic message); **probe timeout, non-zero exit, or unparseable JSON → gate passes optimistically and extraction is attempted** (monkeypatched), with the ffmpeg failure surfacing as 400; ffmpeg/ffprobe absent → 500 (monkeypatched `shutil.which`) |
| Cache key | stable for an unchanged file; changes after video rewrite; changes after `os.utime`; **changes after rewriting only the sidecar**; changes when a sidecar is added or removed; distinct paths → distinct keys; stale same-path rows deleted on write; `force` skips the read and rewrites |
| Sidecar cascade | `.srt` preferred over `.vtt`; `en` variant preferred over another language; uppercase extension matched; empty sidecar falls through; unreadable sidecar falls through |
| Embedded cascade | MKV with a `subrip` track → text; **subtitle whose global stream index ≠ its subtitle ordinal → extracted** (pins `-map 0:<index>`); multiple text tracks → deterministic pick; empty stream output → next candidate; non-zero ffmpeg exit → fall through to audio; **probe timeout, non-zero exit, or unparseable JSON → no embedded candidates → falls through to audio** (monkeypatched); **`is_text_subtitle_codec` predicate unit test** incl. `hdmv_pgs_subtitle`, `dvd_subtitle`, `eia_608`, `dvb_teletext` → False and `subrip`/`mov_text`/`ass`/`webvtt` → True (avoids needing an unencodable bitmap fixture) |
| Audio extraction | produced mp3 is mono, 64 kbps, audio-only (asserted via `ffprobe`); extraction timeout → 504 (monkeypatched bound); non-zero exit → 400 |
| Response fields | sidecar → `model: "sidecar"`; embedded → `model: "ffmpeg"`; both → `source: "subtitles"`; transcription → real model, `source: "transcription"` |
| Web regression | `/transcript` with `https://…` still calls the yt-dlp path and never enters the local branch |

### 12.2 `tests/test_config.py` (additions)

Default `allowed_roots == ()` when the section is absent; list parsing with `~` expansion and
resolution to absolute `Path`s; non-mapping section → `RuntimeError`; unknown key → `RuntimeError`;
non-string entry → `RuntimeError`; **scalar value → `RuntimeError`**; **relative entry →
`RuntimeError`**; a root directory that does not exist is accepted (offline mounts must not block
startup).

### 12.3 `tests/popup.test.js` (additions, `node:test` + existing vm harness)

Chip label for `file:///a/b/My%20Video.mp4` → `Local file · My Video.mp4`; `FILE:///a/b.mp4` and
`file:/a/b.mp4` → local (case-insensitive scheme, matching the backend); `https://youtube.com/x`
→ `Web URL · youtube.com`; empty input → hidden; `Downloads/x.mp4`, `//host/x`, `rtmp://x` → hidden;
`title` carries the full decoded path; `sourceKey('file:///a/My%20Video.mp4') === sourceKey('/a/My Video.mp4')`.

The `init()` restore branch is exercised with a `chrome.storage.local` stub: a legacy string entry; an
object entry matching `tab.url`; an object entry holding a raw local path while the tab URL is the
`file://` form of the same file (restores via `sourceKey`); and a mismatching URL (leaves the textarea
empty).

The harness gains `#source-chip*` stubs, because `init()` will touch those elements and the existing
`doTranslation` test already calls `init()`. Additive stubs and helper additions are expected;
existing assertions are frozen and no existing test may be weakened to accommodate the feature.

### 12.4 Regression gate

`pytest tests/` and `node --test tests/*.test.js` must both pass, with existing assertions unchanged.

### 12.5 `tests/background.test.js` (new, source-level)

`background.js` is not loadable by the popup vm harness (it registers listeners on load), so its
timeout-message regression is pinned statically: read `extension/background.js` as text and assert
that the abort message is built from `TRANSCRIPT_TIMEOUT_MS` (the helper is called with the constant)
and that no hard-coded duration literal such as `15 minutes` remains. This is a deliberately
source-level check rather than a behaviour test, and it is the only claim in this design verified that
way.

### 12.6 End-to-end and acceptance

- Backend end-to-end against a generated fixture video with a sidecar `.srt` (expect
  `model: "sidecar"`, `source: "subtitles"`) and without one (expect transcription via a mock
  OpenAI-compatible endpoint).
- Popup verification using the existing headless-Chromium repro pattern (fake localhost backends,
  real action popup) to prove prefill → chip → send works with the real extension UI.
- Optional real acceptance run on `ART_CRITICISM_-_ASSIGNMENT_BRIEFING.mp4` **only with explicit
  user go-ahead**, because it uploads that audio to the transcription provider.

## 13. Documentation and release

- `AGENTS.md`: `backend/local_file.py` in the tree listing; local-file behaviour and the
  `local_files` config block.
- `ARCHITECTURE.md`: the second pipeline and the classification rule.
- `README.md`: how to use it (open the video in Chrome, or paste a path), with no file-access-toggle
  step — `file://` tab URLs are already visible to the extension (section 10), and the only component
  that reads the filesystem is the backend.
- `backend/config.example.yaml`: the new `local_files` block.
- Version bump to **1.0.8** in `extension/manifest.json`, the FastAPI `app = FastAPI(version=…)`, and
  `extension/popup.html`'s displayed version (the 1.0.7 bump at `0e3834c` touched all three).

## 14. Risks and limitations

| Risk | Mitigation |
| --- | --- |
| A file is played outside a browser tab (e.g. from a file manager), so there is no tab URL to prefill | Paste the path; the chip confirms recognition before the click (section 9.2) |
| A local file-read primitive on an unauthenticated localhost port | `allowed_roots` allowlist (D3) + unconditional existence/regular-file/usability validation; resolved-path checks defeat symlink escape for both the video and sidecars |
| Multi-track video (dub) transcribes the wrong track | Documented limitation; `-map 0:a:0` is explicit rather than accidental |
| Bitmap or unknown subtitle codecs silently ignored | Explicitly skipped (predicate + `_debug` log) with a documented reason; audio transcription still runs |
| 120-minute `fetch` survival is inferred, not measured | Keepalive is proven to 390 s (prior feature); the E2E check in §12.6 is the evidence path for longer runs, and the backend caches results so a retry is cheap |
| Very long files still exceed the client timeout | Stop button available; backend caches the result, so a retry is instant |
| Cache growth from re-exported files or edited sidecars | Stale-key deletion per path at write time (section 5.5) |
| Users on Windows | Out of scope; drive-letter paths keep yt-dlp's existing error (section 4) |

## Appendix A — Design review #1 dispositions

Independent frontier review returned `DEFECTS_FOUND` with four blockers. All are resolved; the
re-review verifies each against the section named here.

| # | Blocker | Resolution | Section |
| --- | --- | --- | --- |
| 1 | `-map 0:s:<idx>` used ffprobe's global `stream.index` where ffmpeg expects a subtitle ordinal, so embedded extraction failed (`Stream map matches no streams`) | Extract with `-map 0:<global index>`; add a fixture whose subtitle global index ≠ its subtitle ordinal | 6 step 2, 12.1 |
| 2 | `prepare()`'s stream gate rejected files with no audio and no embedded text subs *before* the sidecar check, making the sidecar path unreachable | Usability gate now also accepts a usable sidecar; sidecar discovery feeds the gate | 5.4 step 5, 12.1 |
| 3 | Cache key covered only the video, so editing a sidecar served a stale transcript for the TTL | Key is `local:<path_hash>:<content_hash>` with `content_hash` covering size, mtime, **and** the ordered candidate-sidecar fingerprint (candidate = structural, per the terminology finalised in Appendix C); stale same-path rows deleted on write | 5.5, 12.1 |
| 4 | `starts with "/"` classified `//host/path` as LOCAL although yt-dlp accepts those URLs today, falsifying the additive claim | `//` is classified WEB before the scheme/path checks; regression test added | 5.2, 12.1 |

## Appendix B — Design review #2 dispositions

Review #2 returned `CLEAN` (zero blockers; all four earlier blockers independently re-measured) with
12 non-blocking notes. All 12 are applied. The note that changed user-facing behaviour is #2: the
claim that Chrome withholds `file://` tab URLs was **measured false**, so the toggle instruction was
removed from section 10, section 13, and the risk table.

| # | Note | Disposition | Section |
| --- | --- | --- | --- |
| 1 | `_cache_put_local` wrapper could not be "same transaction" as the insert | Helper now opens one connection and does insert + TTL prune + stale delete before one commit | 5.5 |
| 2 | "`tab.url` is empty when file access is disabled" was false when measured | Claim replaced by the measurement; toggle instruction removed from the message, README, and risks | 10, 13, 14 |
| 3 | Gate probe had no timeout | Gate and embedded enumeration share one bounded `probe_streams()` call | 5.4 step 5, 6 step 2 |
| 4 | `prepare()` lacked a `debug` parameter it needed | `Logger` callable injected into `prepare`, `try_subtitles`, `extract_audio`; `main` passes `_debug` | 5.1, 5.4 |
| 5 | URL parsing could truncate a legal raw path containing `?`/`#` | URL parsing and query/fragment rejection apply to `file:`-scheme inputs only; raw paths are verbatim | 5.3 |
| 6 | Missing tests for netloc precedence and percent-encoded `?`/`#` | Added to the matrix | 12.1 |
| 7 | "Usable sidecar" vs "empty sidecar falls through" were inconsistent | Usable requires non-empty parsed text; the no-audio + empty-sidecar case is pinned to the 400 message | 5.4 step 5, 12.1 |
| 8 | Derived abort message had no test | Pure `formatTimeoutMessage(ms)` helper + source-level test | 9.3, 12.5 |
| 9 | Restore rule was ambiguous | Written as an explicit `entry.url === tab.url \|\| sourceKey(...) === sourceKey(...)` condition and tested through `init()` | 9.4, 12.3 |
| 10 | ffprobe timeout fall-through untested | Monkeypatched failed-probe tests: gate becomes optimistic, embedded candidates vanish, extraction is attempted | 12.1 |
| 11 | Popup `FILE://` / `file:/x` cases untested | Added, with the popup classification order pinned (`//` first) | 9.2, 12.3 |
| 12 | `allowed_roots` scalar/relative entries unspecified | Scalar and relative entries raise `RuntimeError`; tests added | 11, 12.2 |

## Appendix C — Design review #3 dispositions

Review #3 verified all 12 of review #2's dispositions, independently reproduced the Chromium
measurement (`correct`), and returned 1 blocker plus 6 note residuals. All are applied.

| # | Finding | Disposition | Section |
| --- | --- | --- | --- |
| B1 | §9.4's consequence bullet claimed a pasted raw path auto-restores on an unrelated tab, contradicting the restore rule the same section defines (local key vs web key never match; the `{text, url}` schema does not record the request-time tab URL) | Bullet rewritten to match the rule: such a result is not auto-restored, and the backend cache makes re-running instant | 9.4 |
| 1 | §6.1's "candidate" conditions omitted the non-empty-text condition, leaving the fingerprint ambiguous | Two terms defined explicitly: structural **candidate** (allowlist + regular + readable, used by the fingerprint) and **usable** (candidate with non-empty parsed text, required by the gate) | 5.4 step 5, 5.5, 6.1 |
| 2 | `sourceKey` using `decodeURI` could not produce the claimed equality and throws on a literal `%` | `file:` inputs use `decodeURIComponent(new URL(raw).pathname)` with a fallback; raw paths and `~` paths are verbatim; the `~` gap is documented | 9.4 |
| 3 | "Same probe" was loose: §5.4 needed audio while §6.2 specified a subtitle-only ffprobe | One helper `probe_streams()` with one documented command; §6.2 consumes its subtitle entries | 5.4 step 5, 6 step 2 |
| 4 | The usable-sidecar allowlist condition contradicted D3's empty = unrestricted default | Condition stated as "when `allowed_roots` is non-empty"; the sidecar test is also run with empty roots | 5.4 step 5, 12.1 |
| 5 | The relative-entry `RuntimeError` had no specified point relative to `resolve()` | Order pinned: after `expanduser`, before `resolve()`, because `resolve()` would defeat it | 11 |
| 6 | Appendix A row 1 cited §5.1, which contains no such text | Citation corrected to "6 step 2, 12.1" | Appendix A |
| — | (Consequential, found while applying note 3) Unifying the probe made the gate's "probe failure ⇒ 400" and the enumeration's "probe failure ⇒ fall through to audio" mutually exclusive | Single rule: a **failed** probe means *streams unknown* — the gate passes optimistically and extraction is attempted, so only a **successful** probe showing nothing usable yields the 400. Test rows realigned | 5.4 step 5, 6 step 2, 10, 12.1 |

## Appendix D — Design review #4 dispositions

Review #4 returned `CLEAN` (0 blockers) and confirmed every Appendix C item resolved, including the
failed-probe rule and the `decodeURIComponent` equivalence (independently checked in Node). Four
non-blocking notes were applied.

| # | Note | Disposition | Section |
| --- | --- | --- | --- |
| 1 | The one-probe rule had no carrier in the declared interfaces (an implementer would probe twice or extend the seam silently) | `LocalTarget` now carries `streams: StreamProbe`; `prepare()` probes once and consumes it for the gate; `try_subtitles()` reads it and never re-probes | 5.1 |
| 2 | Appendix A row 3 still said "usable-sidecar fingerprint" | Reworded to candidate-sidecar with a pointer to the finalised terminology | Appendix A |
| 3 | Appendix B rows 3 and 10 still described the pre-review-#3 "no streams" semantics and "both probes" | Reworded to one `probe_streams()` call and the streams-unknown rule | Appendix B |
| 4 | `sourceKey`'s fallback was scoped to `new URL` throwing only | Fallback now covers `decodeURIComponent` throwing too (`file:///a/50%off.mp4`) | 9.4 |
