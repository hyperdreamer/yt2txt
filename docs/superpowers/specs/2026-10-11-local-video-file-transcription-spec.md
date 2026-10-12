# Local Video File Transcription — Technical Specification

- **Date:** 2026-10-11
- **Topic:** local-video-file-transcription
- **PM run:** pm-run-20261011-114932-0005f5e8
- **Design input:** `docs/superpowers/specs/2026-10-11-local-video-file-transcription-design.md` (approved; design-reviewed to CLEAN; SHA-256 `b7db823756047c4a51bffb1cebbf84d98957a87555e375434ee6eb1e83f7094e`). Decisions D1–D6 are final and are not re-litigated here.
- **Base commit for all quoted current code:** `0e3834c8506a259dc2ec4252ecd8a48496161ae3` (main)
- **Status:** ready for implementation; independent spec review round 1 raised 4 falsifiability blockers (fixed), round 2 returned **CLEAN** with 0 blockers on the revised text at `e8d5723…`, plus two wording notes applied afterwards
- **Review history:** design reviewed four times (Appendices A–D of the design); spec reviewed twice (round 1: 4 falsifiability blockers — `path_hash` scoping, English-likes preference, failed-probe modes, `unquote` vs `unquote_plus`; round 2: CLEAN, all six previously-green mutations reproduced as caught, suites 144 pytest / 69 node vs baseline 55 / 52)
- **Deliverable of this document:** exactly one new file; no existing file is modified by the drafter, nothing is committed.

Normative words **MUST**, **MUST NOT**, **SHOULD** are used in the RFC 2119 sense.

---

## 0. How to read this spec

All production changes are listed as `P1`…`P8` in §2. Test changes are listed in §5. Documentation changes are `D1`…`D3` in §7. Every code block marked **normative** is complete and is intended to be written verbatim; every quoted "current" block is the base-commit text, anchored with `file:line`.

Notation used below:

| Symbol | Meaning |
| --- | --- |
| `path` | the **resolved** `Path` of the local video (`Path.expanduser().resolve()`) |
| `path_hash` | `sha256(str(path).encode("utf-8")).hexdigest()[:16]` |
| `content_hash` | `sha256(f"{size}\0{mtime_ns}\0{sidecar_fingerprint}".encode("utf-8")).hexdigest()[:16]` |
| `cache_key` | `f"local:{path_hash}:{content_hash}"` (the SQLite `video_id`) |
| `candidate` | a structural sidecar candidate: allowlisted (when roots are set) + regular + readable |
| `usable` | a candidate whose parsed text is non-empty |
| streams unknown | `StreamProbe.ok is False`: ffprobe timed out, exited non-zero, or printed unusable JSON |

The Python code in §2.2, the `main.py` edits in §2.3, the JavaScript edits in §2.4–§2.6, the config parser in §2.1, and all tests in §5 were materialized in a throwaway copy of this repository under `/tmp` and executed. The verification runs, observed outputs, and tool versions are recorded in §6. The only claims not executed are listed in §6.13; nothing else is asserted as verified.

---

## 1. Scope of production changes

| Ref | File | Region (base-commit anchors) | Change summary |
| --- | --- | --- | --- |
| P1 | `backend/main.py` | 58–81 (`TimeoutConfig` / `AppConfig`), ~133 (after `_parse_timeout_config`), 165–176 (`load_config` constructor) | add `LocalFilesConfig`, `_parse_local_files_config()`, and the `local_files` `AppConfig` field |
| P2 | `backend/local_file.py` | **new file** | classification, normalisation, allowlist, sidecar discovery, probe, subtitle cascade, audio extraction |
| P3 | `backend/main.py` | 322–353 (`_parse_subtitle_text`), 994–1017 (`_cache_put`), 1027–1145 (`/transcript`) | local branch in `/transcript`, `_cache_put_local()`, thin `_parse_subtitle_text` wrapper |
| P4 | `extension/popup.js` | 42 (element refs), 138 (listeners), 262–265 (prefill), 275 (restore), 494–496 (empty-input message) | `classifyInput`, `sourceKey`, chip render, restore condition, empty-input message |
| P5 | `extension/popup.html` | 157 (dark CSS), 311 (light CSS), 354 (version), 383–385 (markup) | source-chip markup and CSS |
| P6 | `extension/background.js` | 7 (constants), 402–405 (`AbortError` branch) | `TRANSCRIPT_TIMEOUT_MS` 15 → 120 min, pure `formatTimeoutMessage(ms)` helper |
| P7 | `extension/manifest.json`, `backend/main.py:183`, `extension/popup.html:354` | version strings | bump 1.0.7 → 1.0.8 |
| P8 | `backend/config.example.yaml` | after the `cache:` block | document the `local_files` block |

**Files NOT touched (explicit):**

- `extension/offscreen.js` and `extension/offscreen.html` — untouched. The clipboard path is unchanged; local results use the same auto-copy/auto-save chain as web results.
- `extension/manifest.json` **permissions** and **host_permissions** — untouched. No new permission is needed (the `tabs` permission already exposes `file://` tab URLs, measured in design §10). The only manifest change is the version string (P7).
- TextKit (`:8765`) and File Bridge (`:8964`) — untouched. No endpoint, request shape, or setting involving them changes.
- `backend/main.py`'s web pipeline — byte-for-byte unchanged. The local branch returns before the existing cache-lookup block for local inputs only; every web input reaches the old code path unchanged (verified in §5.2 `TestResponseFields::test_web_regression_never_enters_local_branch` and §12.1's `//` regression).
- No new HTTP endpoint, no new message type, no new `chrome.storage` key, no change to the `/transcript` request/response shape.

---

## 2. Production changes

| Ref | Deliverable | § |
| --- | --- | --- |
| P1 | `LocalFilesConfig` + parser + `AppConfig` field | 2.1 |
| P2 | `backend/local_file.py` (full file) | 2.2 |
| P3 | `/transcript` local branch, `_cache_put_local`, `_parse_subtitle_text` wrapper | 2.3 |
| P4 | `extension/popup.js` | 2.4 |
| P5 | `extension/popup.html` | 2.5 |
| P6 | `extension/background.js` | 2.6 |
| P7 | version bumps | 2.7 |
| P8 | `backend/config.example.yaml` | 2.8 |

### P1 — `backend/main.py`: `local_files` config

**Current** (`backend/main.py:68–80`):

```python
@dataclass(frozen=True)
class AppConfig:
    """Application settings loaded from YAML and environment variables."""

    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    debug: bool = False
    api_base: str = "https://api.openai.com/v1"
    api_key: str = ""
    model: str = DEFAULT_MODEL
    timeout: TimeoutConfig = TimeoutConfig()
    cache_enabled: bool = True
    cache_ttl_days: int = 30
```

**Insert immediately before `AppConfig` (normative):**

```python
@dataclass(frozen=True)
class LocalFilesConfig:
    """Local-file input settings loaded from the local_files section."""

    allowed_roots: tuple[Path, ...] = ()
```

**Replacement for the `AppConfig` tail (normative; only the last line is added):**

```python
@dataclass(frozen=True)
class AppConfig:
    """Application settings loaded from YAML and environment variables."""

    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    debug: bool = False
    api_base: str = "https://api.openai.com/v1"
    api_key: str = ""
    model: str = DEFAULT_MODEL
    timeout: TimeoutConfig = TimeoutConfig()
    cache_enabled: bool = True
    cache_ttl_days: int = 30
    local_files: LocalFilesConfig = LocalFilesConfig()
```

**Insert after `_parse_timeout_config` (normative):**

```python
def _parse_local_files_config(raw_local_files: Any) -> LocalFilesConfig:
    """Parse and validate the local_files section from YAML.

    Missing section → unrestricted (empty tuple).  A non-mapping section,
    unknown keys, a non-list ``allowed_roots``, non-string/empty entries, and
    entries that are not absolute after ``expanduser`` all raise RuntimeError.
    """
    if raw_local_files is None:
        return LocalFilesConfig()
    if not isinstance(raw_local_files, dict):
        raise RuntimeError("local_files must be a mapping")

    unknown = set(raw_local_files) - {"allowed_roots"}
    if unknown:
        names = ", ".join(sorted(map(str, unknown)))
        raise RuntimeError(f"Unknown local_files setting(s): {names}")

    raw_roots = raw_local_files.get("allowed_roots", [])
    if not isinstance(raw_roots, list):
        raise RuntimeError(
            "local_files.allowed_roots must be a list, "
            f"got {type(raw_roots).__name__}"
        )

    roots: list[Path] = []
    for entry in raw_roots:
        if not isinstance(entry, str) or not entry.strip():
            raise RuntimeError(
                "local_files.allowed_roots entries must be non-empty strings"
            )
        expanded = Path(entry).expanduser()
        if not expanded.is_absolute():
            raise RuntimeError(
                "local_files.allowed_roots entry must be absolute after "
                f"expansion: {entry}"
            )
        roots.append(expanded.resolve())
    return LocalFilesConfig(allowed_roots=tuple(roots))
```

Validation-order invariant (**MUST**): the absolute-path check runs **after** `expanduser()` but **before** `resolve()`; `resolve()` would make a relative entry absolute and silently defeat the check.

**Current** (`backend/main.py:165–175`, the `AppConfig(...)` call inside `load_config`):

```python
    config = AppConfig(
        host=str(raw.get("host", DEFAULT_HOST)),
        port=int(raw.get("port", DEFAULT_PORT)),
        debug=bool(raw.get("debug", False)),
        api_base=api_base,
        api_key=api_key,
        model=model,
        timeout=_parse_timeout_config(ai_section.get("timeout")),
        cache_enabled=bool(cache_section.get("enabled", True)),
        cache_ttl_days=int(cache_section.get("ttl_days", 30)),
    )
```

**Replacement (only one line added):**

```python
    config = AppConfig(
        host=str(raw.get("host", DEFAULT_HOST)),
        port=int(raw.get("port", DEFAULT_PORT)),
        debug=bool(raw.get("debug", False)),
        api_base=api_base,
        api_key=api_key,
        model=model,
        timeout=_parse_timeout_config(ai_section.get("timeout")),
        cache_enabled=bool(cache_section.get("enabled", True)),
        cache_ttl_days=int(cache_section.get("ttl_days", 30)),
        local_files=_parse_local_files_config(raw.get("local_files")),
    )
```

`raw.get("local_files")` **MUST** be passed directly (not through `... or {}`): a scalar/list value must reach the parser so it can raise `RuntimeError`.

Interactions that **MUST** keep working (they are untouched by this change):

- `load_config()` still sets the module global `_debug_enabled = config.debug` (`backend/main.py:178–180`) and returns the config.
- `get_config()` (`backend/main.py:194–211`) still re-reads `config.yaml` at most every 60 s under `_config_lock`, and still refreshes `_debug_enabled` after each reload. The new field is carried by the same cached `AppConfig` object.
- `_startup_cleanup()` and `__main__` still call `load_config()` synchronously; a malformed `local_files` section therefore fails startup exactly like a malformed `ai.timeout` does today.
- `_debug` (`backend/main.py:242`) is unchanged; it is passed into `local_file` as the injected `Logger`.

### P2 — `backend/local_file.py` (new file, complete)

The module **MUST NOT** import `main` (no cycle). It imports `fastapi.HTTPException` directly and raises the pinned statuses/messages itself. `Logger` is `Callable[[str, str], None]` — `main.py` injects `_debug`.

Normative source (this exact file was executed; see §6):

```python
"""Local video file pipeline: classification, validation, subtitles, audio.

This module owns everything local-file-specific.  It never imports
``main`` (no cycle); ``main.py`` injects its ``_debug`` logger and keeps
orchestration, cache read/write, and the ``_transcribe_audio`` call.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shlex
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Callable
from urllib.parse import unquote, urlparse

from fastapi import HTTPException

Logger = Callable[[str, str], None]

PROBE_TIMEOUT = 30.0
EMBEDDED_SUBTITLE_TIMEOUT = 120.0
AUDIO_EXTRACTION_TIMEOUT = 900.0

TEXT_SUBTITLE_CODECS = frozenset(
    {"subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text", "ttml"}
)

_SIDECAR_EXTENSIONS = (".srt", ".vtt")


# ── Dataclasses ─────────────────────────────────────────────────


@dataclass(frozen=True)
class StreamCandidate:
    """One subtitle stream discovered by :func:`probe_streams`."""

    index: int  # ffprobe global stream index (not a subtitle ordinal)
    codec_name: str
    language: str | None


@dataclass(frozen=True)
class StreamProbe:
    """Result of the single ffprobe call.

    ``ok is False`` means the streams are unknown (timeout, non-zero exit,
    or unparseable output); ``has_audio`` is then ``None`` and
    ``subtitle_candidates`` is empty.  Streams-unknown is not a request
    failure: the gate passes optimistically and extraction decides.
    """

    ok: bool
    has_audio: bool | None
    subtitle_candidates: tuple[StreamCandidate, ...]


@dataclass(frozen=True)
class LocalTarget:
    """A validated local input, ready for the subtitle/audio cascade."""

    raw: str
    path: Path  # resolved
    sidecar_fingerprint: str
    cache_key: str
    size: int
    mtime_ns: int
    streams: StreamProbe


# ── Classification and normalisation ────────────────────────────


def classify(raw: str) -> str:
    """Return ``"local"`` or ``"web"`` for a user-supplied input.

    Ordered, additive rules.  ``//host/path`` is deliberately web: yt-dlp
    accepts scheme-relative URLs today (regression-guarded).
    """
    stripped = raw.strip()
    if stripped.startswith("//"):
        return "web"
    if urlparse(stripped).scheme.lower() == "file":
        return "local"
    if stripped.startswith("/"):
        return "local"
    if stripped.startswith("~"):
        return "local"
    return "web"


def normalize_local_path(raw: str) -> Path:
    """Turn a classified-local input into a (not yet resolved) ``Path``.

    Only ``file:``-scheme inputs are URL-parsed; raw absolute and ``~``
    inputs are used verbatim so a legal filename containing ``?`` or ``#``
    is not truncated.  Check order: netloc → path shape → query/fragment.
    """
    stripped = raw.strip()
    parsed = urlparse(stripped)
    if parsed.scheme.lower() != "file":
        return Path(stripped)
    if parsed.netloc and parsed.netloc.lower() != "localhost":
        raise HTTPException(
            status_code=400,
            detail=f"file:// URLs with a remote host are not supported: {parsed.netloc}",
        )
    if not parsed.path.startswith("/"):
        raise HTTPException(
            status_code=400,
            detail="file:// URL must have an absolute path",
        )
    if parsed.query or parsed.fragment:
        raise HTTPException(
            status_code=400,
            detail=(
                "file:// URLs must not contain a query or fragment; "
                "percent-encode literal ? and # as %3F and %23"
            ),
        )
    return Path(unquote(parsed.path))


# ── Subtitle text ───────────────────────────────────────────────


def parse_subtitle_text(content: str) -> str:
    """Extract plain text from SRT/VTT content (strip timestamps/indices)."""
    # Remove WEBVTT header if present
    content = re.sub(r"^WEBVTT.*?\n\n", "", content, flags=re.S)

    # Remove timestamp lines (SRT: 00:00:01,000 --> 00:00:04,000
    # VTT: 00:00:01.000 --> 00:00:04.000)
    content = re.sub(
        r"\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}.*?\n",
        "",
        content,
    )

    # Remove sequence numbers (SRT block counters).
    # NOTE: This will also remove legitimate subtitle lines that consist
    # solely of a number (e.g. a caption that says "42").  This is an
    # acceptable trade-off — SRT sequence numbers are far more common than
    # lone-number captions, and a full context-aware parser would be
    # significantly more complex.
    content = re.sub(r"^\d+\s*$", "", content, flags=re.M)

    # Remove <c> / </c> and other inline tags
    content = re.sub(r"<[^>]+>", "", content)

    # Collapse blank lines
    lines = [line.strip() for line in content.splitlines() if line.strip()]
    return "\n".join(lines)


def is_text_subtitle_codec(codec: str) -> bool:
    """True for text subtitle codecs we can extract without OCR."""
    return codec.strip().lower() in TEXT_SUBTITLE_CODECS


def _language_rank(language: str | None) -> int:
    """English-likes first, then und/untagged, then everything else."""
    if language is None:
        return 1
    lowered = language.strip().lower()
    if not lowered or lowered == "und":
        return 1
    if lowered == "en" or lowered == "eng" or lowered.startswith("en-"):
        return 0
    return 2


# ── Sidecar discovery ───────────────────────────────────────────


def _sidecar_ext_rank(ext: str) -> int:
    return 0 if ext.lower() == ".srt" else 1


def _is_english_like(tag: str) -> bool:
    lowered = tag.strip().lower()
    return lowered == "en" or lowered == "eng" or lowered.startswith("en-")


def _discover_sidecars(
    path: Path, allowed_roots: tuple[Path, ...], debug: Logger
) -> list[Path]:
    """Return the ordered structural sidecar candidates for *path*.

    A structural candidate is allowlisted (when ``allowed_roots`` is
    non-empty), a regular file, and readable.  Order: bare ``<stem>.srt``
    then ``<stem>.vtt``, then English-like language variants, then the rest;
    within a bucket: language tag, extension rank, name.
    """
    directory = path.parent
    stem = path.stem
    try:
        entries = list(directory.iterdir())
    except OSError as exc:
        debug("local", f"cannot list sidecar directory {directory}: {exc}")
        return []

    found: list[tuple[tuple[int, str, int, str, str], Path]] = []
    for entry in entries:
        name = entry.name
        if not name.startswith(stem + "."):
            continue
        suffix = Path(name).suffix
        if suffix.lower() not in _SIDECAR_EXTENSIONS:
            continue
        middle = name[len(stem) + 1 : len(name) - len(suffix)]
        if middle == "":
            group = 0
            lang_key = ""
        elif _is_english_like(middle):
            group = 1
            lang_key = middle.lower()
        else:
            group = 2
            lang_key = middle.lower()
        resolved = entry.resolve()
        if allowed_roots and not any(
            resolved.is_relative_to(root) for root in allowed_roots
        ):
            debug("local", f"skipping sidecar outside allowed_roots: {resolved}")
            continue
        if not resolved.is_file():
            continue
        if not os.access(resolved, os.R_OK):
            continue
        key = (group, lang_key, _sidecar_ext_rank(suffix), name.lower(), name)
        found.append((key, resolved))

    found.sort(key=lambda item: item[0])
    return [candidate for _key, candidate in found]


def _sidecar_fingerprint(candidates: list[Path]) -> str:
    """Fingerprint of the ordered structural candidates (all of them)."""
    if not candidates:
        return "-"
    return "|".join(
        f"{candidate}\0{candidate.stat().st_size}\0{candidate.stat().st_mtime_ns}"
        for candidate in candidates
    )


def _first_usable_sidecar(
    candidates: list[Path], debug: Logger
) -> tuple[Path, str] | None:
    """First candidate yielding non-empty parsed text, or ``None``."""
    for candidate in candidates:
        try:
            content = candidate.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            debug("local", f"sidecar read failed: {candidate}: {exc}")
            continue
        text = parse_subtitle_text(content)
        if not text:
            debug("local", f"sidecar yielded no text: {candidate}")
            continue
        return candidate, text
    return None


# ── Subprocess helper ───────────────────────────────────────────


async def _run_bounded(
    cmd: list[str], *, timeout: float, debug: Logger
) -> tuple[int, bytes, bytes]:
    """Run a child with a hard timeout; kill it on timeout.

    Mirrors the existing ``_run_ytdlp`` pattern: ``proc.kill()`` followed by
    a bounded ``proc.wait()`` so the child cannot linger.
    """
    debug("local", f"Running: {shlex.join(cmd)}")
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        try:
            await asyncio.wait_for(proc.wait(), timeout=10)
        except asyncio.TimeoutError:
            pass
        raise
    return proc.returncode, stdout, stderr


# ── Stream probe ────────────────────────────────────────────────


async def probe_streams(path: str, debug: Logger) -> StreamProbe:
    """One bounded ffprobe: audio presence + ordered subtitle candidates."""
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "stream=index,codec_type,codec_name:stream_tags=language",
        "-of",
        "json",
        path,
    ]
    try:
        returncode, stdout, stderr = await _run_bounded(
            cmd, timeout=PROBE_TIMEOUT, debug=debug
        )
    except FileNotFoundError:
        debug("local", "ffprobe is not installed")
        return StreamProbe(ok=False, has_audio=None, subtitle_candidates=())
    except asyncio.TimeoutError:
        debug("local", f"ffprobe timed out after {PROBE_TIMEOUT:.0f}s for {path}")
        return StreamProbe(ok=False, has_audio=None, subtitle_candidates=())

    if returncode != 0:
        err = stderr.decode("utf-8", errors="replace").strip()
        debug("local", f"ffprobe failed ({returncode}): {err[:300]}")
        return StreamProbe(ok=False, has_audio=None, subtitle_candidates=())

    try:
        payload = json.loads(stdout.decode("utf-8", errors="replace"))
        streams = payload["streams"]
        if not isinstance(streams, list):
            raise ValueError("'streams' is not a list")
    except (json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
        debug("local", f"ffprobe output unparseable: {exc}")
        return StreamProbe(ok=False, has_audio=None, subtitle_candidates=())

    has_audio = False
    subtitles: list[StreamCandidate] = []
    for stream in streams:
        if not isinstance(stream, dict):
            continue
        codec_type = stream.get("codec_type")
        if codec_type == "audio":
            has_audio = True
        elif codec_type == "subtitle":
            index = stream.get("index")
            if not isinstance(index, int) or isinstance(index, bool):
                continue
            tags = stream.get("tags")
            language: str | None = None
            if isinstance(tags, dict):
                raw_lang = tags.get("language")
                if isinstance(raw_lang, str) and raw_lang.strip():
                    language = raw_lang.strip()
            codec_name = stream.get("codec_name")
            subtitles.append(
                StreamCandidate(
                    index=index,
                    codec_name=codec_name if isinstance(codec_name, str) else "",
                    language=language,
                )
            )

    subtitles.sort(key=lambda candidate: (
        _language_rank(candidate.language),
        candidate.index,
    ))
    return StreamProbe(
        ok=True,
        has_audio=has_audio,
        subtitle_candidates=tuple(subtitles),
    )


# ── Prepare (classify + validate + gate + key) ──────────────────


async def prepare(
    raw: str, allowed_roots: tuple[Path, ...], debug: Logger
) -> LocalTarget | None:
    """Validate a local input and build its :class:`LocalTarget`.

    Returns ``None`` for non-local input so the caller's web pipeline runs
    unchanged.  Raises ``HTTPException`` for every local validation failure.
    """
    stripped = raw.strip()
    if classify(stripped) != "local":
        return None

    path = normalize_local_path(stripped).expanduser().resolve()

    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        raise HTTPException(status_code=500, detail="ffmpeg is not installed.")

    if allowed_roots:
        if not any(path.is_relative_to(root) for root in allowed_roots):
            roots = ", ".join(str(root) for root in allowed_roots)
            raise HTTPException(
                status_code=403,
                detail=(
                    "Path is outside local_files.allowed_roots "
                    f"(configured: {roots}): {path}"
                ),
            )

    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Local file not found: {path}")
    if not path.is_file():
        raise HTTPException(status_code=400, detail=f"{path} is not a regular file")
    if not os.access(path, os.R_OK):
        raise HTTPException(status_code=403, detail=f"{path} is not readable")

    streams = await probe_streams(str(path), debug)
    sidecars = _discover_sidecars(path, allowed_roots, debug)
    fingerprint = _sidecar_fingerprint(sidecars)

    if streams.ok and not streams.has_audio:
        has_text_subtitle = any(
            is_text_subtitle_codec(candidate.codec_name)
            for candidate in streams.subtitle_candidates
        )
        if not has_text_subtitle and _first_usable_sidecar(sidecars, debug) is None:
            raise HTTPException(
                status_code=400,
                detail=f"No audio or subtitle stream found in: {path}",
            )

    stat = path.stat()
    path_hash = hashlib.sha256(str(path).encode("utf-8")).hexdigest()[:16]
    content_hash = hashlib.sha256(
        f"{stat.st_size}\0{stat.st_mtime_ns}\0{fingerprint}".encode("utf-8")
    ).hexdigest()[:16]
    return LocalTarget(
        raw=stripped,
        path=path,
        sidecar_fingerprint=fingerprint,
        cache_key=f"local:{path_hash}:{content_hash}",
        size=stat.st_size,
        mtime_ns=stat.st_mtime_ns,
        streams=streams,
    )


# ── Subtitle cascade ────────────────────────────────────────────


async def try_subtitles(
    target: LocalTarget, allowed_roots: tuple[Path, ...], debug: Logger
) -> tuple[str, str] | None:
    """Return ``(text, model)`` from sidecar/embedded subtitles, or None.

    ``model`` is ``"sidecar"`` or ``"ffmpeg"``.  Subtitle problems never
    fail the request: the caller falls through to audio extraction.
    """
    usable = _first_usable_sidecar(
        _discover_sidecars(target.path, allowed_roots, debug), debug
    )
    if usable is not None:
        debug("local", f"using sidecar subtitles: {usable[0]}")
        return usable[1], "sidecar"

    for candidate in target.streams.subtitle_candidates:
        if not is_text_subtitle_codec(candidate.codec_name):
            debug(
                "local",
                "skipping non-text subtitle stream "
                f"index={candidate.index} codec={candidate.codec_name!r}",
            )
            continue
        cmd = [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-i",
            str(target.path),
            "-map",
            f"0:{candidate.index}",
            "-f",
            "srt",
            "-",
        ]
        try:
            returncode, stdout, stderr = await _run_bounded(
                cmd, timeout=EMBEDDED_SUBTITLE_TIMEOUT, debug=debug
            )
        except FileNotFoundError:
            raise HTTPException(status_code=500, detail="ffmpeg is not installed.")
        except asyncio.TimeoutError:
            debug(
                "local",
                "timed out extracting subtitle "
                f"stream index={candidate.index}",
            )
            continue
        if returncode != 0:
            err = stderr.decode("utf-8", errors="replace").strip()
            debug(
                "local",
                "subtitle extraction failed for "
                f"index={candidate.index}: {err[:300]}",
            )
            continue
        text = parse_subtitle_text(stdout.decode("utf-8", errors="replace"))
        if not text:
            debug("local", f"subtitle stream index={candidate.index} yielded no text")
            continue
        debug("local", f"using embedded subtitle stream index={candidate.index}")
        return text, "ffmpeg"

    return None


# ── Audio extraction ────────────────────────────────────────────


async def extract_audio(target: LocalTarget, tmpdir: str, debug: Logger) -> str:
    """Extract the first audio stream to a 64 kbps mono mp3 in *tmpdir*."""
    out_path = os.path.join(tmpdir, f"{target.path.stem}.mp3")
    cmd = [
        "ffmpeg",
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-i",
        str(target.path),
        "-vn",
        "-sn",
        "-dn",
        "-map",
        "0:a:0",
        "-b:a",
        "64k",
        "-ac",
        "1",
        out_path,
    ]
    try:
        returncode, _stdout, stderr = await _run_bounded(
            cmd, timeout=AUDIO_EXTRACTION_TIMEOUT, debug=debug
        )
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="ffmpeg is not installed.")
    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=504,
            detail=f"Timed out extracting audio from {target.path}",
        )
    if returncode != 0:
        err = stderr.decode("utf-8", errors="replace")[:300]
        raise HTTPException(status_code=400, detail=f"Failed to extract audio: {err}")
    return out_path
```

### P3 — `backend/main.py`: local branch, cache helper, subtitle-text wrapper

#### P3.1 Import

**Current** (`backend/main.py:24–25`):

```python
import httpx
import yaml
```

**Insert after the third-party block (normative):**

```python
from pydantic import BaseModel

import local_file
```

(`from pydantic import BaseModel` is `backend/main.py:29`; append the blank line and `import local_file` after it. The flat import matches the repository layout: `tests/` inserts `backend/` on `sys.path` and `python3 main.py` runs with `backend/` as `sys.argv[0]`'s directory. See Interpretation I-9.)

#### P3.2 `_parse_subtitle_text` becomes a thin wrapper

**Current** (`backend/main.py:322–353`):

```python
def _parse_subtitle_text(path: str) -> str:
    """Extract plain text from an SRT/VTT file (strip timestamps and indices)."""
    import re

    with open(path, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()

    # Remove WEBVTT header if present
    content = re.sub(r"^WEBVTT.*?\n\n", "", content, flags=re.S)

    # Remove timestamp lines (SRT: 00:00:01,000 --> 00:00:04,000 / VTT: 00:00:01.000 --> 00:00:04.000)
    content = re.sub(
        r"\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}.*?\n",
        "",
        content,
    )

    # Remove sequence numbers (SRT block counters).
    # NOTE: This will also remove legitimate subtitle lines that consist
    # solely of a number (e.g. a caption that says "42").  This is an
    # acceptable trade-off — SRT sequence numbers are far more common than
    # lone-number captions, and a full context-aware parser would be
    # significantly more complex.
    content = re.sub(r"^\d+\s*$", "", content, flags=re.M)

    # Remove <c> / </c> and other inline tags
    content = re.sub(r"<[^>]+>", "", content)

    # Collapse blank lines
    lines = [line.strip() for line in content.splitlines() if line.strip()]
    return "\n".join(lines)
```

**Replacement (normative, complete function):**

```python
def _parse_subtitle_text(path: str) -> str:
    """Extract plain text from an SRT/VTT file (strip timestamps and indices)."""
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()
    return local_file.parse_subtitle_text(content)
```

The regex logic now lives in `local_file.parse_subtitle_text(content)` (§2.2) with identical expressions, so the yt-dlp subtitle flow and any external caller of `main._parse_subtitle_text` are behaviourally unchanged. The string form is required because embedded subtitles are extracted to stdout, not to a file.

#### P3.3 `_cache_put_local`

**Current** (`backend/main.py:994–1017`), quoted so the new helper's SQL matches it:

```python
def _cache_put(
    video_id: str,
    text: str,
    source: str,
    ttl_days: int,
) -> None:
    """Insert or replace a cached transcript and prune expired rows."""
    conn = _get_cache_db()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO transcript_cache "
            "(video_id, text, source, created_at) "
            "VALUES (?, ?, ?, datetime('now'))",
            (video_id, text, source),
        )
        conn.execute(
            "DELETE FROM transcript_cache "
            "WHERE datetime(created_at, '+' || ? || ' days') < datetime('now')",
            (ttl_days,),
        )
        conn.commit()
    finally:
        conn.close()
```

**Insert immediately after `_cache_put` (normative; `_cache_put` itself is untouched):**

```python
def _cache_put_local(
    video_id: str,
    text: str,
    source: str,
    ttl_days: int,
    path_hash: str,
) -> None:
    """Insert a local-file transcript and drop stale rows for the same path.

    One connection, one commit: ``INSERT OR REPLACE``, the existing TTL
    prune, and the same-path stale-key ``DELETE`` all run before the single
    commit, so the write is atomic and re-exports/sidecar edits cannot
    accumulate rows.
    """
    conn = _get_cache_db()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO transcript_cache "
            "(video_id, text, source, created_at) "
            "VALUES (?, ?, ?, datetime('now'))",
            (video_id, text, source),
        )
        conn.execute(
            "DELETE FROM transcript_cache "
            "WHERE datetime(created_at, '+' || ? || ' days') < datetime('now')",
            (ttl_days,),
        )
        conn.execute(
            "DELETE FROM transcript_cache "
            "WHERE video_id LIKE ? AND video_id <> ?",
            (f"local:{path_hash}:%", video_id),
        )
        conn.commit()
    finally:
        conn.close()
```

Invariants:

- Exactly **one** connection (`_get_cache_db()`) and exactly **one** `conn.commit()` for the three statements; there is no intermediate commit.
- `path_hash` is lowercase hex (sha256 hexdigest), so the `LIKE` pattern cannot over-match: the literal `:` after `path_hash` separates it from any other key.
- `_cache_get()` (`backend/main.py:933–967`) and `_cache_prune_video()` (`backend/main.py:969–977`) are reused verbatim; the table schema is unchanged.

#### P3.4 Local branch inside `/transcript`

**Current** (`backend/main.py:1027–1042`):

```python
@app.post("/transcript")
async def transcript(req: TranscriptRequest) -> dict[str, Any]:
    config = await get_config()

    # ── Validate input ──────────────────────────────────────
    if not req.url or not isinstance(req.url, str) or not req.url.strip():
        raise HTTPException(status_code=400, detail="url is required")
    url = req.url.strip()

    model = req.model or config.model

    _debug("transcript", f"Processing: {url}")

    # ── Cache lookup ─────────────────────────────────────────
    video_id: str | None = None
    if config.cache_enabled:
```

**Replacement (normative; the only insertion is the local branch block; the web pipeline from `# ── Cache lookup ──` onward is byte-for-byte unchanged):**

```python
@app.post("/transcript")
async def transcript(req: TranscriptRequest) -> dict[str, Any]:
    config = await get_config()

    # ── Validate input ──────────────────────────────────────
    if not req.url or not isinstance(req.url, str) or not req.url.strip():
        raise HTTPException(status_code=400, detail="url is required")
    url = req.url.strip()

    model = req.model or config.model

    _debug("transcript", f"Processing: {url}")

    # ── Local file branch (additive) ─────────────────────────
    # prepare() returns None for web URLs, so the existing pipeline below
    # runs unchanged for everything that is not a local file.
    target = await local_file.prepare(url, config.local_files.allowed_roots, _debug)
    if target is not None:
        return await _transcript_local(target, config, model, req.force)

    # ── Cache lookup ─────────────────────────────────────────
    video_id: str | None = None
    if config.cache_enabled:
```

`_extract_video_id()` is therefore **never called** for a local input (the branch returns first). For web inputs `prepare()` returns `None` and the function body is identical to the base commit.

#### P3.5 `_transcript_local`

**Insert immediately after the closing `}` of the existing `transcript()` function and before `# ── Startup cleanup ───` (normative, complete function):**

```python
async def _transcript_local(
    target: local_file.LocalTarget,
    config: AppConfig,
    model: str,
    force: bool,
) -> dict[str, Any]:
    """Local-file transcript: cache → subtitles → audio → cache."""
    video_id = target.cache_key
    if config.cache_enabled and not force:
        cached = _cache_get(video_id, config.cache_ttl_days)
        if cached:
            _debug("cache", f"hit video_id={video_id} source={cached['source']}")
            return {
                "text": cached["text"],
                "source": cached["source"],
                "model": "cached",
                "error": None,
            }
        _debug("cache", f"miss video_id={video_id}")
    elif force:
        _debug("cache", f"force refresh video_id={video_id}")

    # ``path_hash`` is the middle segment of ``local:<path_hash>:<content_hash>``.
    path_hash = target.cache_key.split(":", 2)[1]

    subtitles = await local_file.try_subtitles(
        target, config.local_files.allowed_roots, _debug
    )
    if subtitles is not None:
        text, subtitle_model = subtitles
        _debug(
            "transcript",
            f"Extracted {len(text)} chars from local subtitles ({subtitle_model})",
        )
        if config.cache_enabled:
            _cache_put_local(
                video_id, text, "subtitles", config.cache_ttl_days, path_hash
            )
            _debug("cache", f"stored video_id={video_id} source=subtitles")
        return {
            "text": text,
            "source": "subtitles",
            "model": subtitle_model,
            "error": None,
        }

    _debug("transcript", "No local subtitles — falling back to transcription")
    with tempfile.TemporaryDirectory() as tmpdir:
        audio_path = await local_file.extract_audio(target, tmpdir, _debug)
        _debug("transcript", f"Transcribing audio: {audio_path} with model {model}")
        text = await _transcribe_audio(audio_path, config, model)

    if config.cache_enabled:
        _cache_put_local(
            video_id, text, "transcription", config.cache_ttl_days, path_hash
        )
        _debug("cache", f"stored video_id={video_id} source=transcription")

    return {
        "text": text,
        "source": "transcription",
        "model": model,
        "error": None,
    }
```

Notes:

- Audio extraction and transcription share the existing `tempfile.TemporaryDirectory()`; chunk files created by `_transcriptionSession` land in `<tmpdir>/chunks` exactly as today and are removed with the directory.
- `_transcribe_audio(audio_path, config, model)` is the **unchanged** base-commit function (`backend/main.py:813`).
- `force=True` skips only the read; a successful result is still written.
- `config.cache_enabled=False` disables both the read and the write.

### P4 — `extension/popup.js`

#### P4.1 Element references

**Current** (`extension/popup.js:42`):

```javascript
const forceCheckbox = document.getElementById('force');
```

**Replacement (three lines appended; `forceCheckbox` is the last transcript-panel element):**

```javascript
const forceCheckbox = document.getElementById('force');
const sourceChip = document.getElementById('source-chip');
const sourceChipIcon = document.getElementById('source-chip-icon');
const sourceChipLabel = document.getElementById('source-chip-label');
```

#### P4.2 Chip helpers

**Insert before the `// ── State ──` banner (`extension/popup.js:90`), normative code:**

```javascript
// ── Input source chip (local vs web) ───────────────────────────
// Display-only mirror of the backend's classification rules.  A mismatch
// can only mislabel the chip; the backend stays authoritative.
function inputBasename(p) {
  const parts = String(p).split('/');
  return parts[parts.length - 1] || p;
}

function fileUrlDisplayPath(raw) {
  try {
    return decodeURIComponent(new URL(raw).pathname);
  } catch {
    return raw;
  }
}

function classifyInput(raw) {
  const s = (raw || '').trim();
  if (!s) return null;
  if (s.startsWith('//')) return null;
  if (/^file:/i.test(s)) {
    const full = fileUrlDisplayPath(s);
    return { kind: 'local', label: `Local file · ${inputBasename(full)}`, title: full };
  }
  if (s.startsWith('/')) {
    return { kind: 'local', label: `Local file · ${inputBasename(s)}`, title: s };
  }
  if (s.startsWith('~')) {
    return { kind: 'local', label: `Local file · ${inputBasename(s)}`, title: s };
  }
  if (/^https?:\/\//i.test(s)) {
    try {
      return { kind: 'web', label: `Web URL · ${new URL(s).hostname}`, title: s };
    } catch {
      return null;
    }
  }
  return null;
}

function sourceKey(raw) {
  const s = String(raw ?? '');
  if (/^file:/i.test(s)) {
    try {
      return decodeURIComponent(new URL(s).pathname);
    } catch {
      return s;
    }
  }
  return s;
}

function updateSourceChip() {
  const info = classifyInput(urlInput.value);
  sourceChip.classList.toggle('hidden', !info);
  sourceChipIcon.textContent = info ? (info.kind === 'local' ? '📁' : '🌐') : '';
  sourceChipLabel.textContent = info ? info.label : '';
  sourceChip.title = info ? info.title : '';
}
```

Exact behaviour contract for `classifyInput(raw)`:

| `raw` (trimmed) | Result |
| --- | --- |
| empty string | `null` |
| starts with `//` | `null` (checked **first**, matching the backend) |
| `/^file:/i` | `{kind:'local', label:'Local file · <basename of decoded pathname>', title:'<decoded pathname>'}`; if `new URL` or `decodeURIComponent` throws, the raw string is used for both basename and title |
| starts with `/` | `{kind:'local', label:'Local file · <basename>', title:<raw>}` |
| starts with `~` | `{kind:'local', label:'Local file · <basename>', title:<raw>}` |
| `/^https?:\/\//i` and `new URL` parses | `{kind:'web', label:'Web URL · <hostname>', title:<raw>}` |
| `/^https?:\/\//i` and `new URL` throws | `null` |
| anything else (relative path, `rtmp:`, `ftp:`, junk, Windows path) | `null` |

The final `return null` (rather than a `web` label) is deliberate and is what pins design §12.3's "`Downloads/x.mp4`, `//host/x`, `rtmp://x` → hidden" (see Interpretation I-4).

`sourceKey(raw)` contract:

| `raw` | Return |
| --- | --- |
| `/^file:/i`, `new URL` and `decodeURIComponent` both succeed | `decodeURIComponent(new URL(raw).pathname)` |
| `/^file:/i`, either throws (e.g. `file:///a/50%off.mp4`) | `raw` unchanged |
| anything else (including `/`-paths, `~`-paths, URLs, empty, `undefined`) | `String(raw ?? '')` |

`sourceKey` is **not** applied to `~` paths (the popup cannot expand `~`); this is the design's documented low-impact gap.

#### P4.3 Input listener

**Current** (`extension/popup.js:138`):

```javascript
hostInput.addEventListener('change', saveYt2txtSettings);
```

**Replacement (one line inserted above it, in the Transcript-panel listener block):**

```javascript
urlInput.addEventListener('input', updateSourceChip);
hostInput.addEventListener('change', saveYt2txtSettings);
```

#### P4.4 Chip update after the init prefill

**Current** (`extension/popup.js:262–265`):

```javascript
  // Pre-fill URL from current tab
  if (tab?.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('about:')) {
    urlInput.value = tab.url;
  }
```

**Replacement (one call added; the `input` event does not fire for a programmatic value):**

```javascript
  // Pre-fill URL from current tab
  if (tab?.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('about:')) {
    urlInput.value = tab.url;
  }
  updateSourceChip();
```

#### P4.5 Restore condition

**Current** (`extension/popup.js:275`):

```javascript
      if (typeof entry === 'object' && entry.url === tab?.url) {
        resultEl.value = entry.text || '';
      } else if (typeof entry === 'string') {
```

**Replacement (normative; the legacy string branch and the "otherwise leave empty" comment are unchanged):**

```javascript
      if (
        typeof entry === 'object' &&
        (entry.url === tab?.url ||
          sourceKey(entry.url) === sourceKey(tab?.url ?? ''))
      ) {
        resultEl.value = entry.text || '';
      } else if (typeof entry === 'string') {
```

Invariant: an entry is restored when **either** the legacy exact comparison holds **or** both inputs normalise to the same `sourceKey`. Storage schema stays `{text, url}`.

#### P4.6 Empty-input message

**Current** (`extension/popup.js:494–496`):

```javascript
  const url = urlInput.value.trim();
  if (!url) {
    statusBar.textContent = 'Enter a video URL first.';
```

**Replacement (normative; the exact string is pinned by the design's error table):**

```javascript
  const url = urlInput.value.trim();
  if (!url) {
    statusBar.textContent =
      'Enter a video URL or a local video path (for example the file:// URL of a video open in this tab).';
```

### P5 — `extension/popup.html`: chip markup and CSS

#### P5.1 Chip CSS (dark theme)

**Current** (`extension/popup.html:157`):

```css
    #url:focus { border-color: #38bdf8; outline: none; }
```

**Replacement (block appended after it):**

```css
    #url:focus { border-color: #38bdf8; outline: none; }

    .source-chip {
      display: flex;
      align-items: center;
      gap: 5px;
      margin: -6px 0 10px;
      padding: 3px 8px;
      border-radius: 999px;
      background: #1e293b;
      color: #94a3b8;
      font-size: 11px;
      max-width: 100%;
      overflow: hidden;
      white-space: nowrap;
    }
    .source-chip .source-chip-icon { color: #38bdf8; }
    .source-chip .source-chip-label { overflow: hidden; text-overflow: ellipsis; }
```

#### P5.2 Chip CSS (light theme)

**Current** (`extension/popup.html:311`):

```css
      #url:focus { border-color: #0284c7; }
```

**Replacement (block appended after it, inside the `@media (prefers-color-scheme: light)` block):**

```css
      #url:focus { border-color: #0284c7; }

      .source-chip { background: #e2e8f0; color: #64748b; }
      .source-chip .source-chip-icon { color: #0284c7; }
```

#### P5.3 Chip markup

**Current** (`extension/popup.html:383–385`):

```html
    <div class="url-row">
      <input id="url" type="text" placeholder="Paste video URL or use current page...">
    </div>
```

**Replacement (one line added; the chip starts hidden via the existing `.hidden` utility class):**

```html
    <div class="url-row">
      <input id="url" type="text" placeholder="Paste video URL or use current page...">
    </div>
    <div id="source-chip" class="source-chip hidden"><span id="source-chip-icon"></span><span id="source-chip-label"></span></div>
```

Element IDs are normative: `source-chip`, `source-chip-icon`, `source-chip-label`. Meaning is carried by icon **and** text (📁 vs 🌐), never colour alone.

#### P5.4 Displayed version

**Current** (`extension/popup.html:354`):

```html
    <span class="version">v1.0.7</span>
```

**Replacement:**

```html
    <span class="version">v1.0.8</span>
```

(The same string change is listed again in P7 for release completeness.)

### P6 — `extension/background.js`

#### P6.1 Timeout constant and pure message helper

**Current** (`extension/background.js:7`):

```javascript
const TRANSCRIPT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
```

**Replacement (normative):**

```javascript
const TRANSCRIPT_TIMEOUT_MS = 120 * 60 * 1000; // 120 minutes — safe only because the keepalive lane keeps the worker alive

function formatTimeoutMessage(ms) {
  return `Request timed out after ${Math.round(ms / 60000)} minutes.`;
}
```

`BACKEND_TIMEOUT_MS` (`extension/background.js:6`, `12 * 60 * 1000`) **MUST NOT** change: it governs format/translate/save, not transcript.

#### P6.2 Abort message call site

**Current** (`extension/background.js:402–405`):

```javascript
    if (e.name === 'AbortError') {
      const errorMsg = timedOut
        ? "Request timed out after 15 minutes."
        : 'Stopped by user.';
```

**Replacement (normative; no other change in `handleStart`):**

```javascript
    if (e.name === 'AbortError') {
      const errorMsg = timedOut
        ? formatTimeoutMessage(TRANSCRIPT_TIMEOUT_MS)
        : 'Stopped by user.';
```

The literal duration string **MUST NOT** appear anywhere else in `extension/background.js`; `tests/background.test.js` (§5.5) pins this statically.

### P7 — Version bumps (1.0.7 → 1.0.8)

| File | Current | Replacement |
| --- | --- | --- |
| `extension/manifest.json:4` | `"version": "1.0.7",` | `"version": "1.0.8",` |
| `backend/main.py:183` | `app = FastAPI(title="YT2TXT", version="1.0.7")` | `app = FastAPI(title="YT2TXT", version="1.0.8")` |
| `extension/popup.html:354` | `<span class="version">v1.0.7</span>` | `<span class="version">v1.0.8</span>` |

This mirrors the `0e3834c` ("chore: bump version to 1.0.7") release commit, which touched all three locations.

### P8 — `backend/config.example.yaml`: `local_files` block

**Current** (end of the `cache:` block, before the `debug:` comment):

```yaml
# Transcription cache (SQLite). Enabled by default.
# Cache hits skip all yt-dlp and API work — instant response.
cache:
  enabled: true
  ttl_days: 30
```

**Replacement (block inserted between `cache:` and the trailing debug comment):**

```yaml
# Transcription cache (SQLite). Enabled by default.
# Cache hits skip all yt-dlp and API work — instant response.
cache:
  enabled: true
  ttl_days: 30

# Local file transcription. When allowed_roots is non-empty, the backend
# refuses to read any local video or sidecar subtitle outside these paths.
# Entries must be absolute (or start with ~) and are expanded and resolved
# at config load. Empty means unrestricted — suitable for a single-user
# machine, not for a shared one.
local_files:
  allowed_roots: []
```

The block is additive: an existing `config.yaml` without `local_files` keeps working with `allowed_roots == ()`.

---

## 3. Contracts

### 3.1 Dataclasses (`backend/local_file.py`)

All three are frozen (`@dataclass(frozen=True)`); they are value objects, never mutated after construction.

| Dataclass | Fields | Invariants |
| --- | --- | --- |
| `StreamCandidate` | `index: int` (ffprobe global stream index, **not** a subtitle ordinal), `codec_name: str`, `language: str | None` | `index >= 0`; `codec_name` may be `""` for a stream ffprobe did not name; `language` is the trimmed `tags.language` or `None` |
| `StreamProbe` | `ok: bool`, `has_audio: bool | None`, `subtitle_candidates: tuple[StreamCandidate, ...]` | `ok is False` ⇒ `has_audio is None` **and** `subtitle_candidates == ()` (streams unknown); `ok is True` ⇒ `has_audio` is a real bool and `subtitle_candidates` is ordered by `(_language_rank(language), index)` |
| `LocalTarget` | `raw: str`, `path: Path` (resolved), `sidecar_fingerprint: str`, `cache_key: str`, `size: int`, `mtime_ns: int`, `streams: StreamProbe` | `path == normalize_local_path(raw).expanduser().resolve()`; `size`/`mtime_ns` are one `path.stat()` sample taken after validation; `cache_key` matches §3.3; `streams` is the probe result consumed by `try_subtitles` (never re-probed) |

`StreamProbe`, `StreamCandidate`, and `LocalTarget` are the declared carriers for the one-probe rule: `prepare()` probes once and stores the result; `try_subtitles()` reads `target.streams` and never invokes ffprobe.

### 3.2 Function signatures (`backend/local_file.py`)

| Function | Signature | Return / raises |
| --- | --- | --- |
| `classify` | `classify(raw: str) -> str` | `"local"` or `"web"`; pure; never raises |
| `normalize_local_path` | `normalize_local_path(raw: str) -> Path` | not-yet-resolved `Path`; raises `HTTPException` 400 per the error matrix — **only** for `file:`-scheme inputs |
| `parse_subtitle_text` | `parse_subtitle_text(content: str) -> str` | plain text with `\n` joins; pure; never raises |
| `is_text_subtitle_codec` | `is_text_subtitle_codec(codec: str) -> bool` | `codec.strip().lower() in {"subrip","srt","ass","ssa","webvtt","mov_text","text","ttml"}` |
| `probe_streams` | `async probe_streams(path: str, debug: Logger) -> StreamProbe` | a probe with `ok=False` on every failure mode; **never raises** |
| `prepare` | `async prepare(raw: str, allowed_roots: tuple[Path, ...], debug: Logger) -> LocalTarget | None` | `None` for web inputs; `LocalTarget` for validated local inputs; raises `HTTPException` (400/403/404/500) per the error matrix |
| `try_subtitles` | `async try_subtitles(target: LocalTarget, allowed_roots: tuple[Path, ...], debug: Logger) -> tuple[str, str] | None` | `(text, "sidecar")`, `(text, "ffmpeg")`, or `None` (fall through to audio); subtitle problems never raise except a missing `ffmpeg` binary (500) |
| `extract_audio` | `async extract_audio(target: LocalTarget, tmpdir: str, debug: Logger) -> str` | mp3 path in `tmpdir`; raises `HTTPException` 400/500/504 per the error matrix |

Internal helpers (names are not part of the public contract but are used by the tests): `_discover_sidecars`, `_sidecar_fingerprint`, `_first_usable_sidecar`, `_language_rank`, `_sidecar_ext_rank`, `_is_english_like`, `_run_bounded`.

`Logger` is `Callable[[str, str], None]` and is always called as `debug(tag, message)`; `main.py` injects `_debug`.

### 3.3 Cache-key construction

```
path_hash    = sha256(str(path).encode("utf-8")).hexdigest()[:16]
content_hash = sha256(f"{size}\0{mtime_ns}\0{sidecar_fingerprint}".encode("utf-8")).hexdigest()[:16]
cache_key    = f"local:{path_hash}:{content_hash}"
sidecar_fingerprint = "|".join(
    f"{candidate}\0{candidate.stat().st_size}\0{candidate.stat().st_mtime_ns}"
    for candidate in ordered_candidates
) or "-"
```

| Component | Covers | Why |
| --- | --- | --- |
| `path_hash` | the resolved path string only | groups all rows for one file path so `_cache_put_local` can delete stale content versions |
| `size` | the video bytes (size) | detects a re-export/rewrite |
| `mtime_ns` | the video bytes (mtime) | detects an in-place rewrite that keeps the size |
| `sidecar_fingerprint` | **every ordered structural candidate** (including empty-text candidates), each as `resolved-path NUL size NUL mtime_ns` joined by `|`; `"-"` when there are none | adding, removing, renaming, or editing any candidate changes the key; embedded subtitles live inside the container and are already covered by `size` + `mtime_ns` |

Both hashes are 16 lowercase hex characters. `cache_key` is used verbatim as the SQLite `video_id` (column type `TEXT PRIMARY KEY`); no schema change.

**Round-2 pin.** `TestCacheKey` now recomputes `path_hash` directly from `str(target.path)` and pins each component independently: two distinct paths with byte-identical videos **and identical `mtime_ns`** must still yield different `path_hash`es (a `path_hash`-component mutation can no longer pass), a size-only change with a restored mtime must change the key (a `size`-dropping mutation can no longer pass), and `_cache_put_local`'s stale delete is asserted to keep another path's row and a web row (an over-broad `LIKE 'local:%'` can no longer pass). The one-connection/one-commit claim is pinned by counting `_get_cache_db()` invocations and `commit()` calls on the connection it returns.

**I-2 TOCTOU window (interface unchanged).** `sidecar_fingerprint` is sampled once inside `prepare()` from the candidates discovered at that moment; `try_subtitles()` re-runs the same deterministic discovery and reads the file it selects. A sidecar edited or added between `prepare()` and selection therefore produces text stored under the `prepare()`-time key. That row is **not reachable by a later run** under the same assumption the key already rests on — that a content change carries a size/mtime change — because a later run recomputes `path_hash`/`size`/`mtime_ns`/`sidecar_fingerprint` from the filesystem as it then is, so the later key differs and forces a cache miss; the orphaned row is removed by `_cache_put_local`'s same-path stale delete on the next successful write, or by TTL. The one way to reach it is to restore the sidecar to its exact pre-edit size and `mtime_ns` (e.g. `cp -p`, `rsync -a`) after the write, which is the same caveat every size/mtime-keyed cache carries. The window is diagnosable from `_debug`: `_first_usable_sidecar` logs read failures and sidecars that yield no text, and `try_subtitles` logs the selected path (`using sidecar subtitles: <path>`). No production interface changes are needed or made.

### 3.4 Response contract per origin

Request/response shape is unchanged: `{"text": str, "source": "subtitles"|"transcription", "model": str, "error": null}`.

| Origin | `source` | `model` | Where set |
| --- | --- | --- | --- |
| Sidecar subtitle file | `"subtitles"` | `"sidecar"` | `_transcript_local` subtitle branch (`try_subtitles` returns `"sidecar"`) |
| Embedded subtitle stream | `"subtitles"` | `"ffmpeg"` | `_transcript_local` subtitle branch (`try_subtitles` returns `"ffmpeg"`) |
| Audio transcription | `"transcription"` | the effective model name (`req.model or config.model`) | `_transcript_local` transcription branch |
| Cache hit (any origin) | the stored `source` value | `"cached"` | `_transcript_local` cache branch |

Web-URL origins are unchanged: `"yt-dlp"`, the model name, and `"cached"`.

### 3.5 Error matrix (exact status + message; test-pinned)

`<path>` below is always `str(resolved Path)`; `<host>` is the parsed `urlparse(...).netloc`; `<roots>` is `", ".join(str(root) for root in allowed_roots)`; `<stderr tail>` is `stderr.decode("utf-8", errors="replace")[:300]` for `extract_audio`.

| # | Condition | Status | Message (exact) |
| --- | --- | --- | --- |
| E1 | Empty input, popup side | — | `Enter a video URL or a local video path (for example the file:// URL of a video open in this tab).` |
| E2 | `file://` with a remote host (netloc non-empty and not `localhost`) | 400 | `file:// URLs with a remote host are not supported: <host>` |
| E3 | `file://` with no absolute path (checked after E2) | 400 | `file:// URL must have an absolute path` |
| E4 | `file://` with query or fragment (checked after E3) | 400 | `file:// URLs must not contain a query or fragment; percent-encode literal ? and # as %3F and %23` |
| E5 | Path outside `allowed_roots` | 403 | `Path is outside local_files.allowed_roots (configured: <roots>): <path>` |
| E6 | Path missing | 404 | `Local file not found: <path>` |
| E7 | Path is not a regular file | 400 | `<path> is not a regular file` |
| E8 | Path unreadable (`os.access(path, os.R_OK)` false) | 403 | `<path> is not readable` |
| E9 | Successful probe shows no audio, no text subtitle stream, and no usable sidecar | 400 | `No audio or subtitle stream found in: <path>` |
| E10 | `ffmpeg` or `ffprobe` missing (`shutil.which`) | 500 | `ffmpeg is not installed.` |
| E11 | Audio extraction non-zero exit | 400 | `Failed to extract audio: <stderr tail>` |
| E12 | Audio extraction exceeds 900 s | 504 | `Timed out extracting audio from <path>` |
| E13 | Sidecar read/parse failure, empty or whitespace-only sidecar, embedded stream failure/timeout/codec skip | — | not an error: `_debug` log, try the next candidate, then fall through to audio |
| E14 | Empty/invalid `url` at the endpoint | 400 | `url is required` (existing, unchanged) |

E2–E4 are pure input-validation errors for `file:`-scheme inputs; raw absolute and `~` inputs are never URL-parsed (so a literal `?` or `#` is a filename character, not a query/fragment).

### 3.6 Config contract

`backend/config.example.yaml` documents:

```yaml
local_files:
  allowed_roots: []      # empty = unrestricted
```

- Absent section or `local_files: null` ⇒ `LocalFilesConfig()` with `allowed_roots == ()` (unrestricted).
- `local_files` present but not a mapping ⇒ `RuntimeError("local_files must be a mapping")`.
- Unknown keys ⇒ `RuntimeError("Unknown local_files setting(s): <names>")`.
- `allowed_roots` not a list (e.g. `"/videos"`, `{}`, `true`) ⇒ `RuntimeError("local_files.allowed_roots must be a list, got <type>")`.
- Entry not a `str`, or a blank/whitespace string ⇒ `RuntimeError("local_files.allowed_roots entries must be non-empty strings")`.
- Entry not absolute after `expanduser()` ⇒ `RuntimeError("local_files.allowed_roots entry must be absolute after expansion: <entry>")`.
- Entries are `Path(entry).expanduser().resolve()`d once at config load; `AppConfig.local_files.allowed_roots` is `tuple[Path, ...]`. `prepare()` and `try_subtitles()` receive exactly that tuple and do **not** re-resolve it.
- Root existence is not required (an offline mount must not block startup).

### 3.7 Subprocess and event-loop invariants

- `probe_streams`, `try_subtitles`, and `extract_audio` run ffprobe/ffmpeg via `asyncio.create_subprocess_exec` with `stdout=PIPE, stderr=PIPE`; no blocking subprocess API is used on the request path.
- Each helper has a hard `asyncio.wait_for(proc.communicate(), timeout=...)` bound: probe **30 s**, embedded subtitle extraction **120 s**, audio extraction **900 s**.
- On timeout the child is killed exactly like `_run_ytdlp`; the base-commit pattern (`backend/main.py:302–310`) is quoted verbatim:

  ```python
      try:
          stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
      except asyncio.TimeoutError:
          proc.kill()
          try:
              await asyncio.wait_for(proc.wait(), timeout=10)
          except asyncio.TimeoutError:
              pass
          raise
  ```

  `proc.kill()` then `await asyncio.wait_for(proc.wait(), timeout=10)`; a second timeout is swallowed. The `asyncio.TimeoutError` is then re-raised or mapped by the caller.
- The stderr-tail failure mapping mirrors `_extract_segment` (`backend/main.py:714–720`):

  ```python
      if proc.returncode != 0:
          err = stderr.decode("utf-8", errors="replace")[:300]
          raise HTTPException(
              status_code=500,
              detail=f"Failed to create audio segment: {err}",
          )
  ```

  `local_file.extract_audio` uses the same `[:300]` tail but maps to **400** `Failed to extract audio: <tail>` per the design's error table.
- `try_subtitles` continues to the next candidate on timeout; `extract_audio` maps timeout to 504; `probe_streams` maps any failure to `StreamProbe(ok=False, ...)`.

---

## 4. State transitions

### 4.1 Backend pipeline (`POST /transcript`, local input)

```
req.url → strip → local_file.prepare() → None? → web branch (unchanged)
                                   │
                                   └─ LocalTarget
   1. classify (strip, "//" → web, file: scheme → local, "/" → local, "~" → local, else web)
   2. normalize_local_path (file:-scheme only: netloc → path shape → query/fragment)
   3. expanduser().resolve()
   4. ffmpeg/ffprobe presence → E10 (500)
   5. allowed_roots (only when non-empty, on the resolved path) → E5 (403)
   6. exists → E6 (404); is_file → E7 (400); os.access(R_OK) → E8 (403)
   7. probe_streams() one 30 s bounded ffprobe → StreamProbe
   8. discover ordered structural sidecar candidates → sidecar_fingerprint
   9. usability gate: reject E9 (400) iff probe.ok AND not has_audio
                                 AND no text-codec candidate AND no usable sidecar
  10. stat once → path_hash / content_hash → cache_key
        │
        ▼
  11. cache read (skipped when force=True or cache_enabled=False) → hit: return {stored text/source, "cached"}
        │ miss
        ▼
  12. try_subtitles(): sidecar candidates first, then embedded candidates → ("...", "sidecar"|"ffmpeg")
        │ hit → _cache_put_local(source="subtitles") → return {text, "subtitles", "sidecar"|"ffmpeg"}
        │ miss (or all fail)
        ▼
  13. tempfile.TemporaryDirectory() → extract_audio() → 64 kbps mono mp3
  14. _transcribe_audio(mp3, config, model)   [unchanged]
  15. _cache_put_local(source="transcription") → return {text, "transcription", model}
```

### 4.2 Streams-unknown rule (the one probe)

`probe_streams()` distinguishes **successful** from **unknown**:

- `ok is True`: `has_audio` is positive. The gate rejects with E9 only if there is no audio, no text-codec subtitle candidate, and no usable sidecar.
- `ok is False` (timeout, non-zero exit, JSON parse/shape failure, or `ffprobe` binary gone): streams are **unknown**. It is **not** a request failure and **never** a 500. The gate passes optimistically; `try_subtitles()` sees `subtitle_candidates == ()` and skips straight to audio extraction. Extraction is the authoritative check: a file with no audio then fails ffmpeg non-zero → E11 (400) with a real message.

No code path may probe twice: `try_subtitles()` reads `target.streams.subtitle_candidates` and never calls `probe_streams()`.

### 4.3 Sidecar candidate vs usable sidecar

| Term | Conditions | Used by |
| --- | --- | --- |
| **candidate** (structural) | (a) when `allowed_roots` is non-empty, its resolved path is inside one of them; **and** (b) it is a regular file; **and** (c) it is readable. Empty-text files **are** candidates. | `sidecar_fingerprint` (all of them, ordered) |
| **usable** | a candidate that additionally yields non-empty text via `parse_subtitle_text` | the usability gate and the cascade's selection (the first usable candidate wins) |

Order of candidates (`_discover_sidecars`):

1. bare `<stem>.srt`, then bare `<stem>.vtt` (extension compared case-insensitively);
2. language variants `<stem>.<lang>.srt|vtt` with English-likes (`en`, `en-*`, `eng`, compared case-insensitively) first;
3. the remaining language variants.

Within each bucket the sort key is `(group, lang_key_lower, ext_rank, name_lower, name)` with `ext_rank = 0` for `.srt` and `1` for `.vtt`. Stem matching is exact (case-sensitive); only the extension is case-insensitive. A candidate whose resolved path escapes `allowed_roots` is skipped with a `_debug` log, never read, and therefore neither authorises the request nor can be returned as its result.

**Round-2 pin.** The ordering is asserted both directly and through selection: `TestSidecarCascade` pits `video.de.srt` against `video.en.srt` (the alphabetically earlier `de` must lose to the English-like `en`) and asserts `_discover_sidecars`'s exact order; `TestEmbeddedCascade` builds an MKV whose lower-index subtitle track is `deu` and whose higher-index track is `eng` and asserts the `eng` text is returned.

**I-2 TOCTOU window (interface unchanged).** `sidecar_fingerprint` is computed at `prepare()` time while `try_subtitles()` re-discovers and reads; the stored result is keyed by the `prepare()`-time fingerprint, so a later run recomputes a different key and does not reach that row (see §3.3 for the one size/mtime-restoration caveat).

### 4.4 Popup chip states

| `urlInput.value` (trimmed) | Chip | Icon | Label | `title` |
| --- | --- | --- | --- | --- |
| empty | hidden | — | — | — |
| `//host/path` | hidden | — | — | — |
| `file:///a/b/My%20Video.mp4` | visible | 📁 | `Local file · My Video.mp4` | `/a/b/My Video.mp4` |
| `/a/b/My Video.mp4` | visible | 📁 | `Local file · My Video.mp4` | `/a/b/My Video.mp4` |
| `~/x/video.mp4` | visible | 📁 | `Local file · video.mp4` | `~/x/video.mp4` |
| `https://youtube.com/x` | visible | 🌐 | `Web URL · youtube.com` | `https://youtube.com/x` |
| `Downloads/x.mp4`, `rtmp://x`, `ftp://x`, `C:\Users\x.mp4`, junk | hidden | — | — | — |

The chip updates on the `input` event and once after the `init()` prefill. It is display-only: `startCapture` sends `urlInput.value.trim()` unchanged to the background, so a chip misclassification can never change an action.

Restore matrix for `transcript:<tabId>` entries (`init()`):

| `entry.url` | `tab.url` | Restored? | Why |
| --- | --- | --- | --- |
| `https://youtube.com/x` | `https://youtube.com/x` | yes | exact equality |
| `file:///a/My%20Video.mp4` | `file:///a/My%20Video.mp4` | yes | exact equality |
| `/a/My Video.mp4` (pasted raw path) | `file:///a/My%20Video.mp4` | yes | `sourceKey` equivalence |
| `/a/My?Video.mp4` | `file:///a/My%3FVideo.mp4` | yes | `decodeURIComponent` equivalence (same decode as the backend's `unquote`) |
| `https://youtube.com/other` | `https://youtube.com/x` | no | neither disjunct |
| `/a/My Video.mp4` | `https://youtube.com/x` | no | local key ≠ web key; schema does not record the request-time tab URL |
| `~/x/video.mp4` | `file:///home/u/x/video.mp4` | no | `~` keys are verbatim; documented low-impact gap |

---

## 5. Test fixtures and cases

All Python tests are pytest, importing `backend/` via `sys.path.insert(...)` exactly like `tests/test_config.py`. Async functions are exercised with `asyncio.run(...)` inside **sync** test functions — the pattern already used by `tests/test_transcription_chunking.py` — so the new tests do not require `pytest-asyncio`. Fixtures are generated with ffmpeg into `tmp_path`; the module skips itself when ffmpeg or ffprobe is absent. No test needs network access or the user's files. Existing assertions are frozen and none may be weakened.

### 5.1 Media fixtures (exact commands that were executed)

A 1-second video with audio:

```bash
ffmpeg -y -v error -f lavfi -i testsrc=duration=1:size=128x72:rate=10 \
  -f lavfi -i sine=frequency=440:duration=1 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest video.mp4
```

A video with **no** audio stream (used for the gate and the extraction-failure cases):

```bash
ffmpeg -y -v error -f lavfi -i testsrc=duration=1:size=128x72:rate=10 \
  -c:v libx264 -pix_fmt yuv420p silent.mp4
```

A sidecar file is written directly (no ffmpeg):

```
1
00:00:00,000 --> 00:00:01,000
Hello sidecar world
```

An MKV whose subtitle **global stream index differs from its subtitle ordinal** (video 0, audio 1, subtitle 2; subtitle ordinal 0). This is the fixture that pins `-map 0:<global index>`:

```bash
ffmpeg -y -v error -f lavfi -i testsrc=duration=1:size=128x72:rate=10 \
  -f lavfi -i sine=frequency=440:duration=1 -i subs.srt \
  -map 0:v -map 1:a -map 2:s \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -c:s srt \
  -metadata:s:s:0 language=eng out.mkv
```

An MKV with the subtitle **before** the audio (subtitle global index 1, ordinal 0) is the same command with `-map 0:v -map 2:s -map 1:a`.

An MKV with **two** text subtitle tracks, `deu` first (global index 2) and `eng` second (global index 3), with distinct texts — the fixture that pins the English-likes preference on the embedded path:

```bash
ffmpeg -y -v error -f lavfi -i testsrc=duration=1:size=128x72:rate=10 \
  -f lavfi -i sine=frequency=440:duration=1 -i de.srt -i en.srt \
  -map 0:v -map 1:a -map 2:s -map 3:s \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -c:s srt \
  -metadata:s:s:0 language=deu -metadata:s:s:1 language=eng two.mkv
```

The "unreadable" case is `os.chmod(path, 0o000)` (skipped when `os.geteuid() == 0`). The "symlink escape" case is a symlink placed inside an allowed root whose target resolves outside it. The "no audio + usable sidecar" case is the silent video plus the sidecar above. The "no audio + only an empty sidecar" case is the silent video plus an `.srt` containing only whitespace.

### 5.2 `tests/test_local_file.py` (new file, complete)

The whole file below was materialized and executed: **76 passed** (§6.12). It is the normative test suite for P2/P3.

Key expectations the tests pin (each has a named test):

- `TestClassification`: percent-decoding, `FILE://`/`file:/`/`file://localhost`, remote-host-before-path-shape (E2 for three inputs), E3 for `file://`, E4 for `?q=1` and `#frag`, `%3F` accepted, a literal `+` kept (`unquote`, not `unquote_plus`) and `%2B` decoded to `+`, raw `?` path accepted verbatim, `~/x` expansion, web classifications (`https`, `//`, relative, `rtmp`, Windows, empty), `prepare()` returning `None` for web input, and the design's `file:///C:/Users/x.mp4` → 404 row.
- `TestAccessPolicy`: unrestricted empty roots, inside-root allowed, outside-root 403 with roots quoted, symlink escape 403, `..` traversal 403, missing 404, directory 400, unreadable 403, `shutil.which` patched per tool name so a missing `ffmpeg` and a missing `ffprobe` are each 500, escaping sidecar skipped (request still succeeds).
- `TestUsabilityGate` + `TestStreamProbeUnknownModes`: silent file 400, silent + usable sidecar passes and returns `"sidecar"` (run with empty **and** non-empty `allowed_roots`), silent + empty sidecar 400 (gate/cascade agree), failed probe passes the gate optimistically and the ffmpeg failure surfaces as 400; the real `probe_streams` is driven through `_run_bounded` so non-zero exit, unparseable stdout, **and** timeout each yield `ok is False` with an optimistic gate and an actually-attempted extraction.
- `TestCacheKey`: stable key; directly recomputed `path_hash`/`content_hash`; key change on video rewrite, size change with restored mtime, `os.utime`, sidecar edit, sidecar add/remove; empty sidecar is a candidate; distinct paths ⇒ distinct keys **even with identical bytes and identical `mtime_ns`**; `_cache_put_local` deletes stale same-path rows while keeping another path's row and a web row; one `_get_cache_db()` call and one `commit()` on the returned connection.
- `TestSidecarCascade`: `.srt` over `.vtt`; `.en` variant preferred over the alphabetically earlier `.de` (asserts `_discover_sidecars` order too); uppercase extension matched; empty sidecar falls through; unreadable sidecar falls through.
- `TestEmbeddedCascade`: text subtitle extracted; **global index ≠ ordinal fixture extracts** for both orders (`audio_before_subtitle=True` asserts candidate index `2`; `False` asserts index `1`); two text tracks `deu` (lower index) and `eng` select the English text; `is_text_subtitle_codec` predicate (8 true, 7 false); empty stream output tries the next candidate; non-zero exit falls through; failed probe yields no embedded candidates.
- `TestAudioExtraction`: produced mp3 is one stream, `mp3`, mono (`channels == 1`), `bit_rate == "64000"`; extraction timeout 504; non-zero exit 400.
- `TestResponseFields`: sidecar/embedded/transcription/cached response dicts; `force` rewrites; web regression never enters the local branch (monkeypatched `_extract_video_id`).

```python
"""Tests for the local video file pipeline (backend/local_file.py)."""

from __future__ import annotations

import asyncio
import hashlib
import os
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

# Ensure the backend directory is importable
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

import local_file  # noqa: E402
import main as backend_main  # noqa: E402
from fastapi import HTTPException  # noqa: E402

FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")
pytestmark = pytest.mark.skipif(
    not (FFMPEG and FFPROBE), reason="ffmpeg and ffprobe are required"
)

DBG = lambda *args: None  # noqa: E731


def run(coro):
    """Run a coroutine without requiring pytest-asyncio."""
    return asyncio.run(coro)


# ── Fixture builders ────────────────────────────────────────────


def make_video(path: Path, *, audio: bool = True, duration: int = 1) -> None:
    """Generate a tiny H.264 video, optionally with an AAC audio track."""
    args = [
        FFMPEG, "-y", "-v", "error",
        "-f", "lavfi", "-i", f"testsrc=duration={duration}:size=128x72:rate=10",
    ]
    if audio:
        args += ["-f", "lavfi", "-i", f"sine=frequency=440:duration={duration}"]
    args += ["-c:v", "libx264", "-pix_fmt", "yuv420p"]
    if audio:
        args += ["-c:a", "aac", "-shortest"]
    args.append(str(path))
    subprocess.run(args, check=True)


def write_srt(path: Path, text: str = "Hello sidecar world") -> None:
    path.write_text(f"1\n00:00:00,000 --> 00:00:01,000\n{text}\n", encoding="utf-8")


def make_mkv_with_subtitle(
    path: Path, srt: Path, *, audio_before_subtitle: bool = True, language: str = "eng"
) -> None:
    """MKV with a text subtitle whose global index != its subtitle ordinal.

    With ``audio_before_subtitle`` the subtitle lands at global stream index 2
    while its subtitle ordinal is 0 — the fixture that pins ``-map 0:<index>``.
    """
    args = [
        FFMPEG, "-y", "-v", "error",
        "-f", "lavfi", "-i", "testsrc=duration=1:size=128x72:rate=10",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
        "-i", str(srt),
    ]
    if audio_before_subtitle:
        args += ["-map", "0:v", "-map", "1:a", "-map", "2:s"]
    else:
        args += ["-map", "0:v", "-map", "2:s", "-map", "1:a"]
    args += [
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-c:s", "srt",
        "-metadata:s:s:0", f"language={language}",
        str(path),
    ]
    subprocess.run(args, check=True)


def make_mkv_with_two_subtitles(
    path: Path, first: Path, second: Path, *, languages: tuple[str, str] = ("deu", "eng")
) -> None:
    """MKV with two text subtitle tracks; the first has the lower global index."""
    args = [
        FFMPEG, "-y", "-v", "error",
        "-f", "lavfi", "-i", "testsrc=duration=1:size=128x72:rate=10",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
        "-i", str(first),
        "-i", str(second),
        "-map", "0:v", "-map", "1:a", "-map", "2:s", "-map", "3:s",
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-c:s", "srt",
        "-metadata:s:s:0", f"language={languages[0]}",
        "-metadata:s:s:1", f"language={languages[1]}",
        str(path),
    ]
    subprocess.run(args, check=True)


@pytest.fixture
def video(tmp_path):
    path = tmp_path / "video.mp4"
    make_video(path)
    return path


# ── Classification and normalisation ───────────────────────────


class TestClassification:
    def test_file_urls_decoded(self):
        assert str(local_file.normalize_local_path("file:///a/b%20c.mp4")) == "/a/b c.mp4"

    @pytest.mark.parametrize(
        "raw",
        ["FILE:///a/b.mp4", "file:/a/b.mp4", "file://localhost/a/b.mp4", "file:///a/b.mp4"],
    )
    def test_file_scheme_forms_are_local(self, raw):
        assert local_file.classify(raw) == "local"
        assert str(local_file.normalize_local_path(raw)) == "/a/b.mp4"

    @pytest.mark.parametrize(
        "raw,host",
        [
            ("file://otherhost/home/x.mp4", "otherhost"),
            ("file://home/henry/x.mp4", "home"),
            ("file://x.mp4", "x.mp4"),
        ],
    )
    def test_remote_host_rejected_before_path_shape(self, raw, host):
        with pytest.raises(HTTPException) as exc:
            local_file.normalize_local_path(raw)
        assert exc.value.status_code == 400
        assert exc.value.detail == (
            f"file:// URLs with a remote host are not supported: {host}"
        )

    def test_empty_file_url_needs_absolute_path(self):
        with pytest.raises(HTTPException) as exc:
            local_file.normalize_local_path("file://")
        assert exc.value.status_code == 400
        assert exc.value.detail == "file:// URL must have an absolute path"

    @pytest.mark.parametrize("raw", ["file:///a.mp4?q=1", "file:///a.mp4#frag"])
    def test_query_and_fragment_rejected(self, raw):
        with pytest.raises(HTTPException) as exc:
            local_file.normalize_local_path(raw)
        assert exc.value.status_code == 400
        assert exc.value.detail == (
            "file:// URLs must not contain a query or fragment; "
            "percent-encode literal ? and # as %3F and %23"
        )

    def test_percent_encoded_question_mark_is_a_filename_char(self):
        normalized = str(local_file.normalize_local_path("file:///a/My%3FVideo.mp4"))
        assert normalized == "/a/My?Video.mp4"

    def test_literal_plus_is_not_a_space(self):
        # `unquote`, not `unquote_plus`: a raw + is a filename character.
        assert str(local_file.normalize_local_path("file:///a/My+Video.mp4")) == "/a/My+Video.mp4"

    def test_percent_encoded_plus_decodes_to_plus(self):
        assert str(local_file.normalize_local_path("file:///a/My%2BVideo.mp4")) == "/a/My+Video.mp4"

    def test_raw_path_is_never_url_parsed(self, tmp_path):
        raw = "/a/my?file.mp4"
        assert local_file.classify(raw) == "local"
        assert str(local_file.normalize_local_path(raw)) == raw
        real = tmp_path / "my?file.mp4"
        make_video(real)
        target = run(local_file.prepare(str(real), (), DBG))
        assert target is not None
        assert target.path == real.resolve()

    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("~/x", "local"),
            ("/abs/x", "local"),
            ("https://youtube.com/watch?v=1", "web"),
            ("//www.youtube.com/watch?v=dQw4w9WgXcQ", "web"),
            ("Downloads/x.mp4", "web"),
            ("rtmp://host/x", "web"),
            (r"C:\Users\x.mp4", "web"),
            ("", "web"),
        ],
    )
    def test_non_file_inputs(self, raw, expected):
        assert local_file.classify(raw) == expected

    def test_web_input_returns_none_from_prepare(self):
        assert run(local_file.prepare("https://example.com/x", (), DBG)) is None
        assert run(local_file.prepare("//www.youtube.com/watch?v=x", (), DBG)) is None
        assert run(local_file.prepare("Downloads/x.mp4", (), DBG)) is None

    def test_windows_drive_file_url_is_a_404(self):
        # Design normalisation table: file:///C:/Users/x.mp4 -> /C:/Users/x.mp4 -> 404.
        with pytest.raises(HTTPException) as exc:
            run(local_file.prepare("file:///C:/Users/x.mp4", (), DBG))
        assert exc.value.status_code == 404
        assert exc.value.detail == "Local file not found: /C:/Users/x.mp4"

    def test_tilde_expansion(self, tmp_path, monkeypatch):
        # A ~ path is expanded before resolution.
        monkeypatch.setenv("HOME", str(tmp_path))
        real = tmp_path / "video.mp4"
        make_video(real)
        target = run(local_file.prepare("~/video.mp4", (), DBG))
        assert target is not None
        assert target.path == real.resolve()


# ── Access policy and validation ────────────────────────────────


class TestAccessPolicy:
    def test_empty_roots_are_unrestricted(self, video):
        assert run(local_file.prepare(str(video), (), DBG)) is not None

    def test_inside_root_allowed(self, video, tmp_path):
        assert run(local_file.prepare(str(video), (tmp_path.resolve(),), DBG)) is not None

    def test_outside_root_rejected_and_roots_quoted(self, video, tmp_path):
        outside_root = tmp_path.parent / "elsewhere"
        outside_root.mkdir(exist_ok=True)
        with pytest.raises(HTTPException) as exc:
            run(local_file.prepare(str(video), (outside_root.resolve(),), DBG))
        assert exc.value.status_code == 403
        assert exc.value.detail.startswith(
            "Path is outside local_files.allowed_roots (configured: "
        )
        assert str(outside_root.resolve()) in exc.value.detail
        assert str(video.resolve()) in exc.value.detail

    def test_symlink_escape_rejected(self, video, tmp_path):
        root = tmp_path / "root"
        root.mkdir()
        escape = root / "escape.mp4"
        escape.symlink_to(video)
        with pytest.raises(HTTPException) as exc:
            run(local_file.prepare(str(escape), (root.resolve(),), DBG))
        assert exc.value.status_code == 403

    def test_dotdot_traversal_rejected(self, video, tmp_path):
        root = tmp_path / "root"
        root.mkdir()
        traversal = root / ".." / video.name
        with pytest.raises(HTTPException) as exc:
            run(local_file.prepare(str(traversal), (root.resolve(),), DBG))
        assert exc.value.status_code == 403

    def test_missing_file_404(self, tmp_path):
        missing = tmp_path / "missing.mp4"
        with pytest.raises(HTTPException) as exc:
            run(local_file.prepare(str(missing), (), DBG))
        assert exc.value.status_code == 404
        assert exc.value.detail == f"Local file not found: {missing.resolve()}"

    def test_directory_400(self, tmp_path):
        with pytest.raises(HTTPException) as exc:
            run(local_file.prepare(str(tmp_path), (), DBG))
        assert exc.value.status_code == 400
        assert exc.value.detail == f"{tmp_path.resolve()} is not a regular file"

    @pytest.mark.skipif(os.geteuid() == 0, reason="root can read chmod 000 files")
    def test_unreadable_403(self, video):
        os.chmod(video, 0o000)
        try:
            with pytest.raises(HTTPException) as exc:
                run(local_file.prepare(str(video), (), DBG))
            assert exc.value.status_code == 403
            assert exc.value.detail == f"{video.resolve()} is not readable"
        finally:
            os.chmod(video, 0o644)

    @pytest.mark.parametrize("missing", ["ffmpeg", "ffprobe"])
    def test_missing_tool_500(self, video, monkeypatch, missing):
        real_which = local_file.shutil.which
        monkeypatch.setattr(
            local_file.shutil,
            "which",
            lambda name: None if name == missing else real_which(name),
        )
        with pytest.raises(HTTPException) as exc:
            run(local_file.prepare(str(video), (), DBG))
        assert exc.value.status_code == 500
        assert exc.value.detail == "ffmpeg is not installed."

    def test_symlinked_sidecar_escaping_roots_is_skipped(self, video, tmp_path):
        root = tmp_path / "root"
        root.mkdir()
        shutil.copy(video, root / "v.mp4")
        escaping = tmp_path / "outside" / "v.srt"
        escaping.parent.mkdir()
        write_srt(escaping, "ESCAPED")
        (root / "v.srt").symlink_to(escaping)
        target = run(local_file.prepare(str(root / "v.mp4"), (root.resolve(),), DBG))
        assert target is not None
        assert "outside" not in target.sidecar_fingerprint
        assert run(local_file.try_subtitles(target, (root.resolve(),), DBG)) is None


# ── Usability gate ──────────────────────────────────────────────


class TestUsabilityGate:
    def test_no_audio_no_subs_400(self, tmp_path):
        path = tmp_path / "silent.mp4"
        make_video(path, audio=False)
        with pytest.raises(HTTPException) as exc:
            run(local_file.prepare(str(path), (), DBG))
        assert exc.value.status_code == 400
        assert exc.value.detail == f"No audio or subtitle stream found in: {path.resolve()}"

    def test_no_audio_with_usable_sidecar_passes(self, tmp_path):
        path = tmp_path / "silent.mp4"
        make_video(path, audio=False)
        write_srt(path.with_suffix(".srt"), "Sidecar only")
        for roots in ((), (tmp_path.resolve(),)):
            target = run(local_file.prepare(str(path), roots, DBG))
            assert target is not None
            assert run(local_file.try_subtitles(target, roots, DBG)) == (
                "Sidecar only",
                "sidecar",
            )

    def test_no_audio_with_only_empty_sidecar_400(self, tmp_path):
        path = tmp_path / "silent.mp4"
        make_video(path, audio=False)
        path.with_suffix(".srt").write_text("   \n\n", encoding="utf-8")
        with pytest.raises(HTTPException) as exc:
            run(local_file.prepare(str(path), (), DBG))
        assert exc.value.status_code == 400
        assert exc.value.detail == f"No audio or subtitle stream found in: {path.resolve()}"

    def test_failed_probe_passes_gate_optimistically(self, tmp_path, monkeypatch):
        path = tmp_path / "silent.mp4"
        make_video(path, audio=False)

        async def fake_probe(path_str, debug):
            return local_file.StreamProbe(ok=False, has_audio=None, subtitle_candidates=())

        monkeypatch.setattr(local_file, "probe_streams", fake_probe)
        target = run(local_file.prepare(str(path), (), DBG))
        assert target is not None
        assert target.streams.ok is False
        assert run(local_file.try_subtitles(target, (), DBG)) is None
        # Extraction is the authoritative check and reports the real ffmpeg error.
        with pytest.raises(HTTPException) as exc:
            run(local_file.extract_audio(target, str(tmp_path), DBG))
        assert exc.value.status_code == 400
        assert exc.value.detail.startswith("Failed to extract audio:")


# ── Stream probe failure modes ──────────────────────────────────


class TestStreamProbeUnknownModes:
    """The real probe_streams maps every failure mode to streams-unknown."""

    @pytest.mark.parametrize("mode", ["nonzero", "unparseable", "timeout"])
    def test_failure_modes_are_streams_unknown_and_gate_is_optimistic(
        self, tmp_path, monkeypatch, mode
    ):
        path = tmp_path / "silent.mp4"
        make_video(path, audio=False)
        real_run_bounded = local_file._run_bounded

        async def fake_run(cmd, *, timeout, debug):
            if mode == "nonzero":
                return 1, b"", b"boom"
            if mode == "unparseable":
                return 0, b"not json", b""
            raise asyncio.TimeoutError

        monkeypatch.setattr(local_file, "_run_bounded", fake_run)
        probe = run(local_file.probe_streams(str(path), DBG))
        assert probe == local_file.StreamProbe(
            ok=False, has_audio=None, subtitle_candidates=()
        )
        target = run(local_file.prepare(str(path), (), DBG))
        assert target is not None
        assert target.streams.ok is False
        # Restore the real runner so extraction runs ffmpeg and the gate's
        # optimistic acceptance is proven by the real failure it surfaces.
        monkeypatch.setattr(local_file, "_run_bounded", real_run_bounded)
        with pytest.raises(HTTPException) as exc:
            run(local_file.extract_audio(target, str(tmp_path), DBG))
        assert exc.value.status_code == 400
        assert exc.value.detail.startswith("Failed to extract audio:")


# ── Cache key ───────────────────────────────────────────────────


class TestCacheKey:
    def test_stable_for_unchanged_file(self, video):
        first = run(local_file.prepare(str(video), (), DBG))
        second = run(local_file.prepare(str(video), (), DBG))
        assert first.cache_key == second.cache_key
        assert first.cache_key.count(":") == 2
        assert first.cache_key.startswith("local:")
        path_hash, content_hash = first.cache_key.split(":")[1:]
        assert len(path_hash) == 16 and len(content_hash) == 16
        assert path_hash == path_hash.lower() and content_hash == content_hash.lower()
        assert path_hash == hashlib.sha256(str(first.path).encode("utf-8")).hexdigest()[:16]
        assert content_hash == hashlib.sha256(
            f"{first.size}\0{first.mtime_ns}\0{first.sidecar_fingerprint}".encode("utf-8")
        ).hexdigest()[:16]

    def test_video_rewrite_changes_key(self, video):
        first = run(local_file.prepare(str(video), (), DBG))
        make_video(video, duration=2)
        second = run(local_file.prepare(str(video), (), DBG))
        assert first.cache_key != second.cache_key

    def test_utime_changes_key(self, video):
        first = run(local_file.prepare(str(video), (), DBG))
        stat = video.stat()
        os.utime(video, ns=(stat.st_atime_ns, stat.st_mtime_ns + 10**9))
        second = run(local_file.prepare(str(video), (), DBG))
        assert first.cache_key != second.cache_key

    def test_sidecar_edit_changes_key(self, video):
        with_sidecar = run(local_file.prepare(str(video), (), DBG))
        write_srt(video.with_suffix(".srt"), "First text")
        first = run(local_file.prepare(str(video), (), DBG))
        write_srt(video.with_suffix(".srt"), "Second text")
        second = run(local_file.prepare(str(video), (), DBG))
        assert first.cache_key != with_sidecar.cache_key
        assert first.cache_key != second.cache_key

    def test_sidecar_add_and_remove_change_key(self, video):
        without = run(local_file.prepare(str(video), (), DBG))
        write_srt(video.with_suffix(".srt"))
        with_sidecar = run(local_file.prepare(str(video), (), DBG))
        video.with_suffix(".srt").unlink()
        removed = run(local_file.prepare(str(video), (), DBG))
        assert without.sidecar_fingerprint == "-"
        assert with_sidecar.cache_key != without.cache_key
        assert removed.cache_key == without.cache_key

    def test_empty_sidecar_is_still_a_candidate(self, video):
        video.with_suffix(".srt").write_text("   \n", encoding="utf-8")
        target = run(local_file.prepare(str(video), (), DBG))
        assert target.sidecar_fingerprint != "-"

    def test_distinct_paths_distinct_keys(self, tmp_path):
        first = tmp_path / "a.mp4"
        second = tmp_path / "b.mp4"
        make_video(first)
        shutil.copy(first, second)
        assert (
            run(local_file.prepare(str(first), (), DBG)).cache_key
            != run(local_file.prepare(str(second), (), DBG)).cache_key
        )

    def test_identical_bytes_and_mtime_still_distinct_paths(self, tmp_path):
        first = tmp_path / "a.mp4"
        second = tmp_path / "b.mp4"
        make_video(first)
        shutil.copy2(first, second)
        stamp_ns = (1_700_000_000_000_000_000, 1_700_000_000_000_000_000)
        os.utime(first, ns=stamp_ns)
        os.utime(second, ns=stamp_ns)
        first_target = run(local_file.prepare(str(first), (), DBG))
        second_target = run(local_file.prepare(str(second), (), DBG))
        assert first_target.size == second_target.size
        assert first_target.mtime_ns == second_target.mtime_ns
        first_path_hash, first_content_hash = first_target.cache_key.split(":")[1:]
        second_path_hash, second_content_hash = second_target.cache_key.split(":")[1:]
        assert first_content_hash == second_content_hash
        assert first_path_hash != second_path_hash
        assert first_target.cache_key != second_target.cache_key

    def test_size_change_with_same_mtime_changes_key(self, video):
        first = run(local_file.prepare(str(video), (), DBG))
        original = video.stat()
        with open(video, "ab") as handle:
            handle.write(b"\0" * 64)
        os.utime(video, ns=(original.st_atime_ns, original.st_mtime_ns))
        second = run(local_file.prepare(str(video), (), DBG))
        assert second.size == first.size + 64
        assert second.mtime_ns == first.mtime_ns
        assert second.cache_key != first.cache_key

    def test_cache_put_local_deletes_stale_same_path_rows(self, video, tmp_path, monkeypatch):
        db = tmp_path / "cache.db"
        monkeypatch.setattr(backend_main, "CACHE_DB_PATH", db)
        target = run(local_file.prepare(str(video), (), DBG))
        path_hash = target.cache_key.split(":")[1]
        other_path_row = "local:ffffffffffffffff:beef"
        web_row = "dQw4w9WgXcQ"
        conn = backend_main._get_cache_db()
        conn.execute(
            "INSERT INTO transcript_cache (video_id, text, source) VALUES (?, ?, ?)",
            (f"local:{path_hash}:stale", "STALE", "subtitles"),
        )
        conn.execute(
            "INSERT INTO transcript_cache (video_id, text, source) VALUES (?, ?, ?)",
            (other_path_row, "OTHER", "transcription"),
        )
        conn.execute(
            "INSERT INTO transcript_cache (video_id, text, source) VALUES (?, ?, ?)",
            (web_row, "WEB", "yt-dlp"),
        )
        conn.commit()
        conn.close()
        backend_main._cache_put_local(
            target.cache_key, "FRESH", "transcription", 30, path_hash
        )
        conn = backend_main._get_cache_db()
        rows = conn.execute(
            "SELECT video_id FROM transcript_cache ORDER BY video_id"
        ).fetchall()
        conn.close()
        assert [row[0] for row in rows] == sorted(
            [target.cache_key, other_path_row, web_row]
        )

    def test_cache_put_local_one_connection_one_commit(
        self, video, tmp_path, monkeypatch
    ):
        db = tmp_path / "cache.db"
        monkeypatch.setattr(backend_main, "CACHE_DB_PATH", db)
        target = run(local_file.prepare(str(video), (), DBG))
        path_hash = target.cache_key.split(":")[1]
        real_get_cache_db = backend_main._get_cache_db
        calls = {"connections": 0, "commits": 0}

        class CountingConnection:
            def __init__(self, conn):
                self._conn = conn

            def execute(self, *args, **kwargs):
                return self._conn.execute(*args, **kwargs)

            def commit(self):
                calls["commits"] += 1
                return self._conn.commit()

            def close(self):
                return self._conn.close()

        def counting_get_cache_db():
            calls["connections"] += 1
            return CountingConnection(real_get_cache_db())

        monkeypatch.setattr(backend_main, "_get_cache_db", counting_get_cache_db)
        backend_main._cache_put_local(
            target.cache_key, "FRESH", "transcription", 30, path_hash
        )
        assert calls == {"connections": 1, "commits": 1}


# ── Sidecar cascade ─────────────────────────────────────────────


class TestSidecarCascade:
    def test_srt_preferred_over_vtt(self, video):
        write_srt(video.parent / "video.srt", "SRT text")
        (video.parent / "video.vtt").write_text(
            "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nVTT text\n", encoding="utf-8"
        )
        target = run(local_file.prepare(str(video), (), DBG))
        assert run(local_file.try_subtitles(target, (), DBG)) == ("SRT text", "sidecar")

    def test_english_variant_beats_alphabetically_earlier_tag(self, video):
        write_srt(video.parent / "video.de.srt", "Deutsch")
        write_srt(video.parent / "video.en.srt", "English")
        target = run(local_file.prepare(str(video), (), DBG))
        # `de` sorts before `en`, so the group preference is what puts en first.
        assert local_file._discover_sidecars(target.path, (), DBG) == [
            (video.parent / "video.en.srt").resolve(),
            (video.parent / "video.de.srt").resolve(),
        ]
        assert run(local_file.try_subtitles(target, (), DBG)) == ("English", "sidecar")

    def test_uppercase_extension_matched(self, video):
        write_srt(video.parent / "video.SRT", "Upper text")
        target = run(local_file.prepare(str(video), (), DBG))
        assert run(local_file.try_subtitles(target, (), DBG)) == ("Upper text", "sidecar")

    def test_empty_sidecar_falls_through(self, video):
        video.with_suffix(".srt").write_text("   \n", encoding="utf-8")
        target = run(local_file.prepare(str(video), (), DBG))
        assert run(local_file.try_subtitles(target, (), DBG)) is None

    @pytest.mark.skipif(os.geteuid() == 0, reason="root can read chmod 000 files")
    def test_unreadable_sidecar_falls_through(self, video):
        sidecar = video.with_suffix(".srt")
        write_srt(sidecar)
        os.chmod(sidecar, 0o000)
        try:
            target = run(local_file.prepare(str(video), (), DBG))
            assert run(local_file.try_subtitles(target, (), DBG)) is None
        finally:
            os.chmod(sidecar, 0o644)


# ── Embedded cascade ────────────────────────────────────────────


class TestEmbeddedCascade:
    def test_text_subtitle_extracted(self, tmp_path):
        srt = tmp_path / "subs.srt"
        write_srt(srt, "Embedded hello")
        path = tmp_path / "out.mkv"
        make_mkv_with_subtitle(path, srt)
        target = run(local_file.prepare(str(path), (), DBG))
        assert run(local_file.try_subtitles(target, (), DBG)) == (
            "Embedded hello",
            "ffmpeg",
        )

    def test_global_stream_index_differs_from_ordinal(self, tmp_path):
        srt = tmp_path / "subs.srt"
        write_srt(srt, "Global index text")
        path = tmp_path / "out.mkv"
        make_mkv_with_subtitle(path, srt, audio_before_subtitle=True)
        target = run(local_file.prepare(str(path), (), DBG))
        candidates = target.streams.subtitle_candidates
        # subtitle global index is 2 while its subtitle ordinal is 0
        assert [candidate.index for candidate in candidates] == [2]
        assert run(local_file.try_subtitles(target, (), DBG)) == (
            "Global index text",
            "ffmpeg",
        )

    def test_subtitle_before_audio_uses_global_index(self, tmp_path):
        srt = tmp_path / "subs.srt"
        write_srt(srt, "Subtitle before audio")
        path = tmp_path / "out2.mkv"
        make_mkv_with_subtitle(path, srt, audio_before_subtitle=False)
        target = run(local_file.prepare(str(path), (), DBG))
        # subtitle global index is 1 while its subtitle ordinal is 0
        assert [candidate.index for candidate in target.streams.subtitle_candidates] == [1]
        assert run(local_file.try_subtitles(target, (), DBG)) == (
            "Subtitle before audio",
            "ffmpeg",
        )

    def test_english_track_preferred_over_lower_index_other_language(self, tmp_path):
        srt_de = tmp_path / "de.srt"
        srt_en = tmp_path / "en.srt"
        write_srt(srt_de, "Deutscher Text")
        write_srt(srt_en, "English text")
        path = tmp_path / "two.mkv"
        make_mkv_with_two_subtitles(path, srt_de, srt_en, languages=("deu", "eng"))
        target = run(local_file.prepare(str(path), (), DBG))
        assert [
            candidate.language for candidate in target.streams.subtitle_candidates
        ] == ["eng", "deu"]
        assert run(local_file.try_subtitles(target, (), DBG)) == (
            "English text",
            "ffmpeg",
        )

    def test_is_text_subtitle_codec_predicate(self):
        for codec in ("subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text", "ttml"):
            assert local_file.is_text_subtitle_codec(codec) is True
        for codec in (
            "hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle",
            "xsub", "eia_608", "dvb_teletext", "",
        ):
            assert local_file.is_text_subtitle_codec(codec) is False

    @staticmethod
    def _fake_target(path: Path, candidates):
        return local_file.LocalTarget(
            raw=str(path),
            path=path,
            sidecar_fingerprint="-",
            cache_key="local:0000000000000000:0000000000000000",
            size=1,
            mtime_ns=1,
            streams=local_file.StreamProbe(
                ok=True, has_audio=True, subtitle_candidates=tuple(candidates)
            ),
        )

    def test_empty_stream_output_tries_next_candidate(self, tmp_path, monkeypatch):
        path = tmp_path / "video.mp4"
        make_video(path)
        target = self._fake_target(
            path,
            [
                local_file.StreamCandidate(1, "subrip", "eng"),
                local_file.StreamCandidate(3, "subrip", "und"),
            ],
        )
        calls = []

        async def fake_run(cmd, *, timeout, debug):
            calls.append(cmd)
            if len(calls) == 1:
                return 0, b"", b""
            return 0, b"1\n00:00:00,000 --> 00:00:01,000\nSecond\n", b""

        monkeypatch.setattr(local_file, "_run_bounded", fake_run)
        assert run(local_file.try_subtitles(target, (), DBG)) == ("Second", "ffmpeg")
        assert len(calls) == 2
        assert "-map" in calls[1] and "0:3" in calls[1]

    def test_nonzero_exit_falls_through(self, tmp_path, monkeypatch):
        path = tmp_path / "video.mp4"
        make_video(path)
        target = self._fake_target(
            path, [local_file.StreamCandidate(1, "subrip", "eng")]
        )

        async def fake_run(cmd, *, timeout, debug):
            return 1, b"", b"boom"

        monkeypatch.setattr(local_file, "_run_bounded", fake_run)
        assert run(local_file.try_subtitles(target, (), DBG)) is None

    def test_failed_probe_yields_no_embedded_candidates(self, tmp_path, monkeypatch):
        path = tmp_path / "video.mp4"
        make_video(path)

        async def fake_probe(path_str, debug):
            return local_file.StreamProbe(ok=False, has_audio=None, subtitle_candidates=())

        monkeypatch.setattr(local_file, "probe_streams", fake_probe)
        target = run(local_file.prepare(str(path), (), DBG))
        assert target.streams.subtitle_candidates == ()
        assert run(local_file.try_subtitles(target, (), DBG)) is None


# ── Audio extraction ────────────────────────────────────────────


class TestAudioExtraction:
    def test_produced_mp3_is_mono_64k_audio_only(self, video, tmp_path):
        out_dir = tmp_path / "out"
        out_dir.mkdir()
        target = run(local_file.prepare(str(video), (), DBG))
        audio_path = run(local_file.extract_audio(target, str(out_dir), DBG))
        probe = subprocess.run(
            [
                FFPROBE, "-v", "error",
                "-show_entries", "stream=codec_name,channels,bit_rate",
                "-of", "json", audio_path,
            ],
            check=True, capture_output=True, text=True,
        )
        import json

        streams = json.loads(probe.stdout)["streams"]
        assert len(streams) == 1
        assert streams[0]["codec_name"] == "mp3"
        assert streams[0]["channels"] == 1
        assert streams[0]["bit_rate"] == "64000"

    def test_extraction_timeout_504(self, video, tmp_path, monkeypatch):
        async def fake_run(cmd, *, timeout, debug):
            raise asyncio.TimeoutError

        monkeypatch.setattr(local_file, "_run_bounded", fake_run)
        target = run(local_file.prepare(str(video), (), DBG))
        with pytest.raises(HTTPException) as exc:
            run(local_file.extract_audio(target, str(tmp_path), DBG))
        assert exc.value.status_code == 504
        assert exc.value.detail == f"Timed out extracting audio from {video.resolve()}"

    def test_extraction_nonzero_exit_400(self, tmp_path):
        path = tmp_path / "silent.mp4"
        make_video(path, audio=False)
        target = local_file.LocalTarget(
            raw=str(path),
            path=path,
            sidecar_fingerprint="-",
            cache_key="local:0000000000000000:0000000000000000",
            size=1,
            mtime_ns=1,
            streams=local_file.StreamProbe(ok=False, has_audio=None, subtitle_candidates=()),
        )
        with pytest.raises(HTTPException) as exc:
            run(local_file.extract_audio(target, str(tmp_path), DBG))
        assert exc.value.status_code == 400
        assert exc.value.detail.startswith("Failed to extract audio:")


# ── Response fields and cache wiring ────────────────────────────


class TestResponseFields:
    @pytest.fixture
    def config(self):
        return backend_main.AppConfig(
            api_key="test-key",
            cache_enabled=True,
            cache_ttl_days=30,
            local_files=backend_main.LocalFilesConfig(),
        )

    def test_sidecar_response(self, video, config, monkeypatch, tmp_path):
        monkeypatch.setattr(backend_main, "CACHE_DB_PATH", tmp_path / "cache.db")
        write_srt(video.with_suffix(".srt"), "Sidecar body")
        target = run(local_file.prepare(str(video), (), DBG))
        response = run(
            backend_main._transcript_local(target, config, "test-model", False)
        )
        assert response == {
            "text": "Sidecar body",
            "source": "subtitles",
            "model": "sidecar",
            "error": None,
        }

    def test_embedded_response(self, tmp_path, config, monkeypatch):
        monkeypatch.setattr(backend_main, "CACHE_DB_PATH", tmp_path / "cache.db")
        srt = tmp_path / "subs.srt"
        write_srt(srt, "Embedded body")
        path = tmp_path / "out.mkv"
        make_mkv_with_subtitle(path, srt)
        target = run(local_file.prepare(str(path), (), DBG))
        response = run(
            backend_main._transcript_local(target, config, "test-model", False)
        )
        assert response == {
            "text": "Embedded body",
            "source": "subtitles",
            "model": "ffmpeg",
            "error": None,
        }

    def test_transcription_response(self, video, config, monkeypatch, tmp_path):
        monkeypatch.setattr(backend_main, "CACHE_DB_PATH", tmp_path / "cache.db")

        async def fake_transcribe(audio_path, cfg, model):
            return "Audio body"

        monkeypatch.setattr(backend_main, "_transcribe_audio", fake_transcribe)
        target = run(local_file.prepare(str(video), (), DBG))
        response = run(
            backend_main._transcript_local(target, config, "test-model", False)
        )
        assert response == {
            "text": "Audio body",
            "source": "transcription",
            "model": "test-model",
            "error": None,
        }

    def test_cache_hit_response_and_force(self, video, config, monkeypatch, tmp_path):
        monkeypatch.setattr(backend_main, "CACHE_DB_PATH", tmp_path / "cache.db")
        write_srt(video.with_suffix(".srt"), "Sidecar body")
        target = run(local_file.prepare(str(video), (), DBG))
        run(backend_main._transcript_local(target, config, "test-model", False))
        cached = run(backend_main._transcript_local(target, config, "test-model", False))
        assert cached == {
            "text": "Sidecar body",
            "source": "subtitles",
            "model": "cached",
            "error": None,
        }
        # force skips the read and rewrites the row
        path_hash = target.cache_key.split(":")[1]
        conn = backend_main._get_cache_db()
        conn.execute(
            "UPDATE transcript_cache SET text = 'STALE' WHERE video_id = ?",
            (target.cache_key,),
        )
        conn.commit()
        conn.close()
        forced = run(backend_main._transcript_local(target, config, "test-model", True))
        assert forced["text"] == "Sidecar body" and forced["model"] == "sidecar"
        conn = backend_main._get_cache_db()
        row = conn.execute(
            "SELECT text FROM transcript_cache WHERE video_id = ?",
            (target.cache_key,),
        ).fetchone()
        conn.close()
        assert row == ("Sidecar body",)

    def test_web_regression_never_enters_local_branch(self, monkeypatch, tmp_path):
        monkeypatch.setattr(backend_main, "CACHE_DB_PATH", tmp_path / "cache.db")
        calls = {"extract_video_id": 0}

        async def fake_extract_video_id(url):
            calls["extract_video_id"] += 1
            return "webtestid"

        async def fake_subs_manual(url, tmpdir):
            path = Path(tmpdir) / "web.srt"
            path.write_text("1\n00:00:00,000 --> 00:00:01,000\nWEB\n")
            return str(path)

        async def fake_subs_auto(url, tmpdir):
            return None

        monkeypatch.setattr(backend_main, "_extract_video_id", fake_extract_video_id)
        monkeypatch.setattr(backend_main, "_download_subs_manual", fake_subs_manual)
        monkeypatch.setattr(backend_main, "_download_subs_auto", fake_subs_auto)
        response = run(
            backend_main.transcript(
                backend_main.TranscriptRequest(url="https://example.com/watch?v=1")
            )
        )
        assert response["model"] == "yt-dlp"
        assert response["text"] == "WEB"
        assert calls["extract_video_id"] == 1
```

### 5.3 `tests/test_config.py` (additions)

Add `LocalFilesConfig` and `_parse_local_files_config` to the existing `from main import (...)` list, then append this class (normative; executed — 13 new tests pass):

```python
# ── local_files config ──────────────────────────────────────────

class TestLocalFilesConfig:
    """The local_files.allowed_roots block is validated like ai.timeout."""

    def test_absent_section_defaults_to_unrestricted(self):
        assert AppConfig().local_files == LocalFilesConfig()
        assert AppConfig().local_files.allowed_roots == ()
        assert _parse_local_files_config(None).allowed_roots == ()

    def test_empty_list(self):
        assert _parse_local_files_config({"allowed_roots": []}).allowed_roots == ()

    def test_list_is_expanded_and_resolved(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HOME", str(tmp_path))
        (tmp_path / "videos").mkdir()
        cfg = _parse_local_files_config({"allowed_roots": ["~/videos"]})
        assert cfg.allowed_roots == ((tmp_path / "videos").resolve(),)

    def test_resolved_absolute_paths(self, tmp_path):
        cfg = _parse_local_files_config({"allowed_roots": [str(tmp_path)]})
        assert cfg.allowed_roots == (tmp_path.resolve(),)

    def test_non_mapping_raises(self):
        with pytest.raises(RuntimeError, match="local_files must be a mapping"):
            _parse_local_files_config(["x"])

    def test_unknown_key_raises(self):
        with pytest.raises(RuntimeError, match="Unknown local_files setting.*roots"):
            _parse_local_files_config({"roots": []})

    def test_scalar_value_raises(self):
        with pytest.raises(RuntimeError, match="local_files.allowed_roots must be a list"):
            _parse_local_files_config({"allowed_roots": "/videos"})

    def test_non_string_entry_raises(self):
        with pytest.raises(RuntimeError, match="non-empty strings"):
            _parse_local_files_config({"allowed_roots": [123]})

    def test_empty_string_entry_raises(self):
        with pytest.raises(RuntimeError, match="non-empty strings"):
            _parse_local_files_config({"allowed_roots": ["  "]})

    def test_relative_entry_raises(self):
        with pytest.raises(RuntimeError, match="must be absolute after expansion"):
            _parse_local_files_config({"allowed_roots": ["relative/dir"]})

    def test_nonexistent_root_accepted(self, tmp_path):
        missing = tmp_path / "offline-mount"
        cfg = _parse_local_files_config({"allowed_roots": [str(missing)]})
        assert cfg.allowed_roots == (missing.resolve(),)

    def test_frozen(self):
        cfg = LocalFilesConfig()
        with pytest.raises(Exception):
            cfg.allowed_roots = ()  # type: ignore[misc]

    def test_load_config_wires_local_files(self, monkeypatch, tmp_path):
        monkeypatch.setattr(
            backend_main,
            "_load_yaml_config",
            lambda: {"local_files": {"allowed_roots": [str(tmp_path)]}},
        )
        cfg = backend_main.load_config()
        assert cfg.local_files.allowed_roots == (tmp_path.resolve(),)
```

### 5.4 `tests/popup.test.js` (additions, `node:test` + existing vm harness)

**Harness deltas (required before the new tests run).** `init()` now touches the chip elements and the restore branch reads `chrome.storage.local`, so the stubs must exist.

(a) local data stub:

```javascript
  const fetchCalls = [];
  const runtimeMessages = [];
  const localData = { ...(options.localData || {}) };
```

(b) a real class-list stub and the chip elements — replace the existing `el()` helper with:

```javascript
  function classListStub() {
    const classes = new Set();
    return {
      add: (c) => { classes.add(c); },
      remove: (c) => { classes.delete(c); },
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : force;
        if (on) classes.add(c); else classes.delete(c);
        return on;
      },
      contains: (c) => classes.has(c),
    };
  }

  function el(id, overrides = {}) {
    const defaults = {
      value: '',
      disabled: false,
      checked: false,
      textContent: '',
      title: '',
      classList: classListStub(),
      addEventListener() {},
      replaceChildren() {},
    };
    return { id, ...defaults, ...overrides };
  }
```

and add after `force: el('force'),` in the `elements` map:

```javascript
    'source-chip': el('source-chip'),
    'source-chip-icon': el('source-chip-icon'),
    'source-chip-label': el('source-chip-label'),
```

(c) `chrome.storage.local.get` honours `localData`; replace the existing `get(keys)` body with:

```javascript
        get(keys) {
          let result = {};
          if (typeof keys === 'string') {
            result[keys] = localData[keys];
          } else if (Array.isArray(keys)) {
            for (const key of keys) result[key] = localData[key];
          } else if (keys && typeof keys === 'object') {
            result = { ...keys };
            for (const key of Object.keys(keys)) {
              if (Object.hasOwn(localData, key)) result[key] = localData[key];
            }
          } else {
            result = { ...localData };
          }
          return Promise.resolve(result);
        },
```

(d) the active-tab URL is overridable; replace the `tabs.query` stub with:

```javascript
    tabs: {
      query: async () => [{ id: 1, url: options.tabUrl || 'https://youtube.com/watch?v=test' }],
    },
```

**New tests (append; 12 tests, all pass — §6.9):**

```javascript
// ═══════════════════════════════════════════════════════════════════
// Source chip + sourceKey + init restore (local file transcription)
// ═══════════════════════════════════════════════════════════════════

test('source chip labels a percent-encoded local file', () => {
  const harness = createPopupHarness();
  const info = harness.context.classifyInput('file:///a/b/My%20Video.mp4');
  assert.equal(info.kind, 'local');
  assert.equal(info.label, 'Local file · My Video.mp4');
  assert.equal(info.title, '/a/b/My Video.mp4');
});

test('source chip treats FILE:// and file:/ schemes as local', () => {
  const harness = createPopupHarness();
  assert.equal(harness.context.classifyInput('FILE:///a/b.mp4').kind, 'local');
  assert.equal(harness.context.classifyInput('file:/a/b.mp4').kind, 'local');
});

test('source chip labels an https URL with its hostname', () => {
  const harness = createPopupHarness();
  const info = harness.context.classifyInput('https://youtube.com/x');
  assert.equal(info.kind, 'web');
  assert.equal(info.label, 'Web URL · youtube.com');
});

test('source chip is hidden for empty, relative, scheme-relative, and unknown schemes', () => {
  const harness = createPopupHarness();
  for (const input of ['', 'Downloads/x.mp4', '//host/x', 'rtmp://x']) {
    assert.equal(harness.context.classifyInput(input), null, `expected hidden for ${input}`);
  }
});

test('sourceKey equates a file URL with the equivalent raw path', () => {
  const harness = createPopupHarness();
  assert.equal(
    harness.context.sourceKey('file:///a/My%20Video.mp4'),
    harness.context.sourceKey('/a/My Video.mp4'),
  );
  assert.equal(
    harness.context.sourceKey('file:///a/My%3FVideo.mp4'),
    harness.context.sourceKey('/a/My?Video.mp4'),
  );
  assert.equal(
    harness.context.sourceKey('file:///a/My%23Video.mp4'),
    harness.context.sourceKey('/a/My#Video.mp4'),
  );
  assert.equal(harness.context.sourceKey('file:///a/50%off.mp4'), 'file:///a/50%off.mp4');
});

test('init() renders the chip for a prefilled file:// tab', async () => {
  const harness = createPopupHarness({ tabUrl: 'file:///a/b/My%20Video.mp4' });
  await harness.context.init();
  assert.equal(harness.elements['source-chip'].classList.contains('hidden'), false);
  assert.equal(harness.elements['source-chip-icon'].textContent, '📁');
  assert.equal(harness.elements['source-chip-label'].textContent, 'Local file · My Video.mp4');
  assert.equal(harness.elements['source-chip'].title, '/a/b/My Video.mp4');
});

test('init() hides the chip for a relative path', async () => {
  const harness = createPopupHarness();
  harness.elements['url'].value = 'Downloads/x.mp4';
  harness.context.updateSourceChip();
  assert.equal(harness.elements['source-chip'].classList.contains('hidden'), true);
});

test('init() restores a legacy string entry', async () => {
  const harness = createPopupHarness({
    localData: { 'transcript:1': 'LEGACY' },
  });
  await harness.context.init();
  assert.equal(harness.elements['result'].value, 'LEGACY');
});

test('init() restores an object entry matching tab.url', async () => {
  const harness = createPopupHarness({
    tabUrl: 'https://youtube.com/watch?v=test',
    localData: { 'transcript:1': { text: 'MATCHED', url: 'https://youtube.com/watch?v=test' } },
  });
  await harness.context.init();
  assert.equal(harness.elements['result'].value, 'MATCHED');
});

test('init() restores a raw local path entry on the equivalent file:// tab', async () => {
  const harness = createPopupHarness({
    tabUrl: 'file:///a/My%20Video.mp4',
    localData: { 'transcript:1': { text: 'LOCAL TEXT', url: '/a/My Video.mp4' } },
  });
  await harness.context.init();
  assert.equal(harness.elements['result'].value, 'LOCAL TEXT');
});

test('init() leaves the textarea empty for a mismatching URL', async () => {
  const harness = createPopupHarness({
    tabUrl: 'https://youtube.com/watch?v=test',
    localData: { 'transcript:1': { text: 'OTHER', url: 'https://youtube.com/other' } },
  });
  await harness.context.init();
  assert.equal(harness.elements['result'].value, '');
});

test('startCapture shows the URL-or-local-path message for empty input', async () => {
  const harness = createPopupHarness();
  harness.elements['url'].value = '';
  await harness.context.startCapture();
  assert.equal(
    harness.elements['status-bar'].textContent,
    'Enter a video URL or a local video path (for example the file:// URL of a video open in this tab).',
  );
});
```

### 5.5 `tests/background.test.js` (new, source-level)

`extension/background.js` is not loadable by the popup VM harness (it registers listeners on load), so P6 is pinned statically. This is the only claim verified by a source-level check rather than behaviour.

```javascript
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const BACKGROUND_PATH = path.join(ROOT, 'extension', 'background.js');
const SOURCE = fs.readFileSync(BACKGROUND_PATH, 'utf8');

test('background: TRANSCRIPT_TIMEOUT_MS is 120 minutes with a keepalive rationale', () => {
  assert.match(SOURCE, /const TRANSCRIPT_TIMEOUT_MS = 120 \* 60 \* 1000;[^\n]*keepalive/i);
});

test('background: BACKEND_TIMEOUT_MS stays at 12 minutes', () => {
  assert.match(SOURCE, /const BACKEND_TIMEOUT_MS = 12 \* 60 \* 1000;/);
});

test('background: formatTimeoutMessage derives minutes from its argument', () => {
  assert.match(SOURCE, /function formatTimeoutMessage\(ms\) \{/);
  assert.match(SOURCE, /Math\.round\(ms \/ 60000\)/);
});

test('background: the abort message is built from TRANSCRIPT_TIMEOUT_MS', () => {
  assert.match(SOURCE, /formatTimeoutMessage\(TRANSCRIPT_TIMEOUT_MS\)/);
});

test('background: no hard-coded timeout duration remains', () => {
  assert.doesNotMatch(SOURCE, /after \d+ minutes/);
  assert.doesNotMatch(SOURCE, /"Request timed out/);
});
```

### 5.6 Commands and expected results

```bash
# Python (run from the repository root, with the project's canonical backend
# interpreter — the conda 'daily' env on this machine; a bare system python3
# lacks fastapi/httpx). The new async tests use asyncio.run like
# tests/test_transcription_chunking.py, so they do not add a pytest-asyncio
# requirement, but tests/test_config.py already has one async test that needs
# the plugin.
python -m pytest tests/ -q

# JavaScript
node --test tests/*.test.js
```

Expected after a complete implementation (measured with the conda `daily` interpreter: Python 3.14.6, pytest 9.1.0, pytest-asyncio 1.4.0):

- `pytest tests/`: **144 passed**. Baseline is 55 passed; the additions are 76 (`test_local_file.py`) + 13 (`test_config.py`) = 89 new tests.
- `node --test tests/*.test.js`: **69 passed** (baseline 52 + 12 popup additions + 5 background additions).

Environment caveat: running pytest with an interpreter that lacks `pytest-asyncio` makes the pre-existing `tests/test_config.py::TestTimeoutWiring::test_transcribe_file_wires_configured_timeouts` fail with `async def functions are not natively supported`; that is an interpreter gap, not a regression from this feature.

---

## 6. Verification evidence

All verification ran read-only against the real repository and wrote only under
`/tmp/localvideo-verify/` (a throwaway copy of the repo with the proposed changes applied). The
observed outputs below are the actual stdout of those runs.

### 6.1 Environment and versions

| Tool | Version used |
| --- | --- |
| `ffmpeg` / `ffprobe` | `n9.0.2` (Copyright (c) 2000-2026 the FFmpeg developers) |
| `yt-dlp` | `2026.08.19` |
| Python (canonical) | conda `daily` env: Python `3.14.6`, pytest `9.1.0`, pytest-asyncio `1.4.0`, fastapi `0.137.0`, httpx `0.28.1` (full-suite runs) |
| Python (scratch) | system/file-bridge venv Python `3.14.7`, pytest `9.1.1` (helper and single-module runs; no pytest-asyncio) |
| Node | `v24.15.0` |

### 6.2 Classification and normalisation against the real `urlparse`

Executed a table-driven check. All 16 classification cases passed; observed values:

```
classify('file:///a/b%20c.mp4') = 'local'      classify('//www.youtube.com/watch?v=dQw4w9WgXcQ') = 'web'
classify('FILE:///a/b.mp4')     = 'local'      classify('https://youtube.com/x') = 'web'
classify('file:/a/b.mp4')       = 'local'      classify('rtmp://host/x')         = 'web'
classify('file://localhost/a.mp4') = 'local'   classify('Downloads/x.mp4')       = 'web'
classify('file://otherhost/a.mp4') = 'local'   classify('C:\Users\x.mp4')        = 'web'
classify('file://home/henry/x.mp4') = 'local'  classify('')                      = 'web'
classify('file://x.mp4') = 'local'             classify('/a/b.mp4') = 'local'
classify('~/Dropbox/video.mp4') = 'local'      classify('~') = 'local'
```

Real `urlparse` results that drive the rules (the `file://x.mp4` row is why netloc is checked before
path shape):

```
urlparse('file://otherhost/a.mp4') -> scheme='file' netloc='otherhost' path='/a.mp4'
urlparse('file://home/henry/x.mp4')-> scheme='file' netloc='home'      path='/henry/x.mp4'
urlparse('file://x.mp4')           -> scheme='file' netloc='x.mp4'     path=''
urlparse('file://')                -> scheme='file' netloc=''          path=''
urlparse('file:///a/My%3FVideo.mp4')-> scheme='file' netloc=''         path='/a/My%3FVideo.mp4' query='' fragment=''
urlparse('file:///a.mp4?q=1')      -> scheme='file' netloc=''          path='/a.mp4' query='q=1'
urlparse('//www.youtube.com/watch?v=x') -> scheme='' netloc='www.youtube.com' path='/watch' query='v=x'
urlparse('C:\Users\x.mp4')         -> scheme='c'    netloc=''          path='\Users\x.mp4'
urlparse('/a/my?file.mp4')         -> scheme=''     netloc=''          path='/a/my' query='file.mp4'
```

Normalisation cases all passed, e.g. `file:///a/b%20c.mp4 → /a/b c.mp4`, `file:///a/My%3FVideo.mp4 →
/a/My?Video.mp4`, `file:///a/my?file.mp4 → /a/my?file.mp4` (raw path verbatim). Error calls returned
the exact pinned details:

```
file://otherhost/home/x.mp4: 400 'file:// URLs with a remote host are not supported: otherhost'
file://home/henry/x.mp4:     400 'file:// URLs with a remote host are not supported: home'
file://x.mp4:                400 'file:// URLs with a remote host are not supported: x.mp4'
file://:                     400 'file:// URL must have an absolute path'
file:///a.mp4?q=1:           400 'file:// URLs must not contain a query or fragment; percent-encode literal ? and # as %3F and %23'
file:///a.mp4#f:             400 'file:// URLs must not contain a query or fragment; percent-encode literal ? and # as %3F and %23'
```

### 6.3 `is_text_subtitle_codec`

All 17 predicate cases passed: `subrip`, `srt`, `ass`, `ssa`, `webvtt`, `mov_text`, `text`, `ttml`,
`SUBRIP` → `True`; `hdmv_pgs_subtitle`, `dvd_subtitle`, `dvb_subtitle`, `xsub`, `eia_608`,
`dvb_teletext`, `""`, `unknown` → `False`.

### 6.4 Real ffprobe JSON shape (the command quoted in §2.2)

```
$ ffprobe -v error -show_entries stream=index,codec_type,codec_name:stream_tags=language -of json out.mkv
{
    "programs": [],
    "stream_groups": [],
    "streams": [
        { "index": 0, "codec_name": "h264",   "codec_type": "video",    "tags": {} },
        { "index": 1, "codec_name": "subrip", "codec_type": "subtitle", "tags": { "language": "eng" } },
        { "index": 2, "codec_name": "aac",    "codec_type": "audio",    "tags": {} }
    ]
}
```

The parser reads only `streams`; `programs` and `stream_groups` are ignored. Parsed results on the
generated fixtures:

```
plain.mp4:   ok=True  has_audio=True  subs=[]
noaudio.mp4: ok=True  has_audio=False subs=[]
out.mkv:     ok=True  has_audio=True  subs=[(1, 'subrip', 'eng')]
out2.mkv:    ok=True  has_audio=True  subs=[(2, 'subrip', 'eng')]
```

### 6.5 The `-map 0:<global index>` mechanism (design blocker #1, re-measured)

On the audio-before-subtitle MKV (subtitle global index 2, subtitle ordinal 0):

```
$ ffmpeg -nostdin -v error -i out.mkv -map 0:s:2 -f srt -     # global index used as an ordinal
Stream map '' matches no streams.
To ignore this, add a trailing '?' to the map.
Failed to set value '0:s:2' for option 'map': Invalid argument
exit=234

$ ffmpeg -nostdin -v error -i out.mkv -map 0:2 -f srt -       # global index
1
00:00:00,000 --> 00:00:01,000
Hello sidecar world
...exit=0
```

`try_subtitles` returned `('Hello sidecar world\nSecond line', 'ffmpeg')` for both MKV fixtures.
The standalone test `TestEmbeddedCascade::test_global_stream_index_differs_from_ordinal` asserts the
candidate index is `2` and that extraction succeeds.

### 6.6 Cache key: composition and sensitivity (executed)

```
no sidecars:    fingerprint = '-'                              cache_key = local:a3259d7c01722500:63d8909a2a196a24
sidecar added:  fingerprint = '/tmp/ck-gnsmugnb/video.srt\x0038\x001791725319214469766'
                                                               cache_key = local:a3259d7c01722500:b9c041ff7ea39724
sidecar edited:                                                cache_key = local:a3259d7c01722500:a1415c78c7aa8eed
utime changed key: True        rewrite changed key: True
sidecar removed: fingerprint = '-'                             cache_key changed: True
```

An independent recomputation of `sha256(str(path))[:16]` and
`sha256(f"{size}\0{mtime_ns}\0{fingerprint}")[:16]` matched `target.cache_key` exactly, and both
segments were 16 lowercase hex characters.

### 6.7 `_cache_put_local` SQL semantics (executed against sqlite3)

Writes `local:aaaa1111bbbb2222:v1`, then `local:aaaa1111bbbb2222:v2` (same path, new content), then a
second path, then a web row:

```
rows after writes: [('dQw4w9WgXcQ', 'web row'), ('local:aaaa1111bbbb2222:v2', 'new text'), ('local:cccc3333dddd4444:v1', 'other file')]
stale same-path row deleted: True        current rows kept: True True        web row untouched: True
rows after expired prune: [('dQw4w9WgXcQ',), ('local:aaaa1111bbbb2222:v2',), ('local:cccc3333dddd4444:v2',)]
expired pruned: True
helper source: 1 x `conn.commit()`, 1 x `_get_cache_db()`
round-2 pin: `TestCacheKey::test_cache_put_local_one_connection_one_commit` counts 1 x `_get_cache_db()` call and 1 x `commit()` on the returned connection
```

End-to-end through the patched endpoint: after a sidecar edit and re-request, exactly one
`local:` row existed for the path (`local:065ebc34e3555c35:7921188fe90f24b8`).

### 6.8 End-to-end `/transcript` on the patched copy

Real `fastapi.testclient.TestClient` requests against the patched copy with real ffmpeg fixtures and
a monkeypatched provider:

```
file://<tmp>/v.mp4 (sidecar)          -> 200 {'text': 'Hello sidecar', 'source': 'subtitles', 'model': 'sidecar'}
second call                           -> 200 {'model': 'cached', 'text': 'Hello sidecar'}
force=True                            -> 200 {'model': 'sidecar'}
sidecar edited, re-request            -> 200 {'text': 'Hello EDITED', 'model': 'sidecar'}
file://<fix>/out2.mkv (sub @ idx 2)   -> 200 {'text': 'Hello sidecar world\nSecond line', 'source': 'subtitles', 'model': 'ffmpeg'}
raw path, no sidecar, fake provider   -> 200 {'text': 'FAKE AUDIO TRANSCRIPT', 'source': 'transcription', 'model': 'gpt-4o-transcribe'}
file:///nope/missing.mp4              -> 404 {'detail': 'Local file not found: /nope/missing.mp4'}
file://otherhost/x.mp4                -> 400 {'detail': 'file:// URLs with a remote host are not supported: otherhost'}
https://... (web, monkeypatched)      -> 200 model 'yt-dlp', _extract_video_id called exactly once
//www.youtube.com/... (web)           -> 200 model 'yt-dlp', _extract_video_id called again (never the local branch)
```

### 6.9 Popup helpers (Node v24.15.0)

A standalone Node script ran the exact helper bodies with 31 assertions: **31 passed, 0 failed**.
Covered: `file:///a/b/My%20Video.mp4` → `Local file · My Video.mp4`; `FILE://`/`file:/` → local;
`https://youtube.com/x` → `Web URL · youtube.com`; empty/relative/`//host/x`/`rtmp://x`/`ftp://x`/
Windows path → `null`; literal-`%` fallback; `sourceKey` equality for `%20`, `%3F`, and `%23`, verbatim raw
paths, `file:///a/50%off.mp4` fallback; and the restore expression for all seven rows of §4.4.

The full vm-harness suite (with the §5.4 harness deltas and the 12 new tests) passed:
`node --test tests/*.test.js` → **69 passed, 0 failed** (baseline 52).

### 6.10 `tests/background.test.js` is falsifiable

Against the unpatched `extension/background.js`: 4 of 5 tests failed (the `BACKEND_TIMEOUT_MS`
check passed). After applying P6 exactly as specified: **5 passed, 0 failed**. This demonstrates the
test is not vacuous.

### 6.11 Timeout kill path

`_run_bounded(["sleep", "30"], timeout=0.3)` raised `asyncio.TimeoutError` after 0.30 s; a `ps` scan
found no surviving `sleep 30` process, confirming the `proc.kill()` + bounded `proc.wait()` path.

### 6.12 Full suite runs

| Command (conda `daily` interpreter) | Baseline (real repo) | Patched scratch copy |
| --- | --- | --- |
| `python -m pytest tests/ -q` | **55 passed** | **144 passed** (55 + 76 + 13) |
| `node --test tests/*.test.js` | **52 passed** | **69 passed** |

The same Python suite was also run with an interpreter lacking `pytest-asyncio` (file-bridge venv):
baseline 54 passed + 1 failed, patched copy 143 passed + 1 failed — the one failure is the
pre-existing `tests/test_config.py::TestTimeoutWiring::test_transcribe_file_wires_configured_timeouts`
(`async def functions are not natively supported`). That is an interpreter gap, not a regression:
under the canonical `daily` env every test passes. The new tests deliberately use `asyncio.run(...)`
(the `tests/test_transcription_chunking.py` pattern) so they add no new dependency.

### 6.13 What was NOT executed

- The headless-Chromium end-to-end popup check from design §12.6 (real action popup + fake localhost
  backends) — **deferred, not dropped**: it is acceptance-checklist item 11. The reusable harness is
  the earlier keepalive feature's real-action-popup driver `/tmp/yt2txt-e2e/run2.cjs` with its fake
  backends `/tmp/yt2txt-e2e/server.cjs` on ports 18666/18765/18964 and CDP on 9335
  (`chrome.action.openPopup()`); the reproduction procedure is recorded in the
  `yt2txt/projects-memory` skill `repro-yt2txt-popup-sw-lifetime`.
- Any real network/OpenAI transcription (the provider call was monkeypatched).
- The 120-minute `fetch` survival claim (design §14) — inferred, not measured; the keepalive lane is
  proven only to 390 s.
- The optional real acceptance run on `ART_CRITICISM_-_ASSIGNMENT_BRIEFING.mp4` (requires explicit
  user go-ahead).
- `uvicorn backend.main:app` import style (see I-9).

### 6.14 Round-2 falsifiability verification (review blockers B1–B4)

An independent review of the first verification round found four blockers: in each, a production
mutation left every test green because the tests did not pin the mechanism they claimed to cover.
The spec fixes above (new and strengthened tests in §5.2/§5.4, prose in §3.3/§4.3, counts in §5.6/§6.12/§10) were verified by an independent round-2 reviewer that re-materialized this spec from its own fences and reproduced every previously-green mutation as caught; that review returned CLEAN with 0 blockers. Its two wording notes are applied: the I-2 TOCTOU quantifier is softened (a size/mtime-restoring sidecar restore is the one reachable path), and the §5.4 change is described as a strengthened assertion rather than a new test.
re-materialized by extracting the fenced blocks from this document into a fresh throwaway copy
(`/tmp/specfix-verify/repo`, based on `0e3834c`). Materialization fidelity was re-checked
mechanically: the `backend/local_file.py`, `tests/test_local_file.py`, and
`tests/background.test.js` fences compare byte-equal to the materialized files, and the §5.4 popup
fence is the exact tail of `tests/popup.test.js`. Each mutation below was applied **one at a time**
in the throwaway copy, the named test was run, and the file was reverted with `git checkout --`
before the next mutation (the real worktree was never touched; its `git status` stayed empty).

| Blocker | Mutation applied (throwaway copy only) | Catching test | Observed failure |
| --- | --- | --- | --- |
| B1a | `path_hash = sha256(str(path))[:16]` → `sha256(b"constant")[:16]` | `TestCacheKey::test_stable_for_unchanged_file` | `assert '96f6549c6b97a641' == '08d409a4a4208df0'` |
| B1b | same `path_hash` constant | `TestCacheKey::test_identical_bytes_and_mtime_still_distinct_paths` | `assert '96f6549c6b97a641' != '96f6549c6b97a641'` (content hashes equal, path hashes equal) |
| B1b-control | same constant, run the pre-fix `test_distinct_paths_distinct_keys` alone | (old test) | `1 passed` — the old test is blind to it; the new test is what makes the fix falsifiable |
| B1c | stale delete pattern `f"local:{path_hash}:%"` → `"local:%"` | `TestCacheKey::test_cache_put_local_deletes_stale_same_path_rows` | right side contains one more item `local:ffffffffffffffff:beef`; the other-path row was deleted |
| N2 | `content_hash` drops `stat.st_size` | `TestCacheKey::test_size_change_with_same_mtime_changes_key` | cache keys equal after a +64-byte size change with `mtime_ns` restored |
| N8 | extra `conn.commit()` before the stale delete | `TestCacheKey::test_cache_put_local_one_connection_one_commit` | `{'connections': 1, 'commits': 2} != {'connections': 1, 'commits': 1}` |
| N8b | open a second `_get_cache_db()` connection inside `_cache_put_local` | `TestCacheKey::test_cache_put_local_one_connection_one_commit` | `{'connections': 2} != {'connections': 1}` |
| B2a | `_is_english_like(...)` → `return False` | `TestSidecarCascade::test_english_variant_beats_alphabetically_earlier_tag` | index 0 differs: `video.de.srt != video.en.srt` |
| B2b | `_language_rank(...)` → `return 0` | `TestEmbeddedCascade::test_english_track_preferred_over_lower_index_other_language` | `assert ['deu', 'eng'] == ['eng', 'deu']` |
| B3a | non-zero-returncode branch → `StreamProbe(ok=True, has_audio=False, ...)` | `TestStreamProbeUnknownModes::...test_failure_modes...[nonzero]` | differing attribute `ok: True != False` |
| B3b | JSON-exception branch → `StreamProbe(ok=True, has_audio=False, ...)` | `TestStreamProbeUnknownModes::...test_failure_modes...[unparseable]` | differing attribute `ok: True != False` |
| B3c | timeout branch → `StreamProbe(ok=True, has_audio=False, ...)` | `TestStreamProbeUnknownModes::...test_failure_modes...[timeout]` | differing attribute `ok: True != False` |
| B4 | `Path(unquote(parsed.path))` → `unquote_plus` | `TestClassification::test_literal_plus_is_not_a_space` | `assert '/a/My Video.mp4' == '/a/My+Video.mp4'` |
| N7 | `shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None` → ffmpeg only | `TestAccessPolicy::test_missing_tool_500[ffprobe]` | `Failed: DID NOT RAISE HTTPException` |
| N6 | fixture `else` maps audio before subtitle (`audio_before_subtitle=False` ignored) | `TestEmbeddedCascade::test_subtitle_before_audio_uses_global_index` | `assert [2] == [1]` |
| N5 | `decodeURIComponent` → `decodeURI` in `popup.sourceKey` | `sourceKey equates a file URL with the equivalent raw path` | `'/a/My%3FVideo.mp4' != '/a/My?Video.mp4'` (the `%23` assertion follows in the same test) |

Every behaviour-changing mutation was caught; the only `NOT-CAUGHT` row is the deliberate B1b
control that demonstrates why the old assertion was insufficient. After all mutations were reverted,
the clean materialization passed **144 passed** under the canonical conda `daily` interpreter
(the non-`pytest-asyncio` file-bridge venv: **143 passed + 1 failed**, the pre-existing
`tests/test_config.py::TestTimeoutWiring::test_transcribe_file_wires_configured_timeouts` async
test) and **69 passed** under `node --test tests/*.test.js`.

---

## 7. Documentation and release deltas

All edits are exact old-text → new-text replacements; line numbers refer to the base commit. `P8` in
§2.8 already covers `backend/config.example.yaml`.

### D1 — `AGENTS.md`

**D1a — backend tree (`AGENTS.md:19–21`):**

Old:

```
backend/                 ← FastAPI backend (transcript extraction only)
  main.py                ← FastAPI app with /transcript and /health endpoints
  config.yaml            ← live config (GITIGNORED)
```

New:

```
backend/                 ← FastAPI backend (transcript extraction only)
  main.py                ← FastAPI app with /transcript and /health endpoints
  local_file.py          ← local-file pipeline (classification, sidecars, embedded subtitles, ffmpeg audio extraction)
  config.yaml            ← live config (GITIGNORED)
```

**D1b — endpoint flow note (after `AGENTS.md:95`):**

Old:

```
8. Send to OpenAI `/v1/audio/transcriptions`, cache, return.
```

New:

```
8. Send to OpenAI `/v1/audio/transcriptions`, cache, return.

Local-file inputs (`file://` URL, absolute path, or `~/` path) take a separate
pipeline before step 2: `backend/local_file.py` classifies and validates the
path (allowlist + existence + regular file + readability + usability gate),
uses sidecar then embedded text subtitles when present, otherwise extracts
audio with ffmpeg (`-map 0:a:0 -b:a 64k -ac 1`), and caches under
`local:<path_hash>:<content_hash>` — a content-sensitive key covering the video
and all sidecar candidates. `_extract_video_id()` is never called for local
inputs.
```

**D1c — config block (`AGENTS.md:107–109`):**

Old:

```
cache:
  enabled: true
  ttl_days: 30
debug: false
```

New:

```
cache:
  enabled: true
  ttl_days: 30
local_files:
  allowed_roots: []   # empty = unrestricted; non-empty restricts reads to these resolved absolute paths
debug: false
```

and append one bullet to the config bullet list (after the "Cache uses SQLite…" bullet):

```
- `local_files.allowed_roots` restricts which local paths the backend may read (empty = unrestricted). Entries must be absolute (or `~`); relative entries are a startup error.
```

**D1d — popup UI design (`AGENTS.md:136`):**

Old:

```
- Status bars on all tabs showing progress.
```

New:

```
- Status bars on all tabs showing progress.
- A display-only source chip under the URL input shows `Local file · <name>` or `Web URL · <host>` (hidden for unrecognised input); it never changes what is sent to the background.
```

**D1e — conventions (`AGENTS.md:147`):**

Old:

```
- yt-dlp must be installed on the system.
```

New:

```
- yt-dlp must be installed on the system.
- ffmpeg and ffprobe must be installed for local-file transcription; the backend returns 500 `ffmpeg is not installed.` when they are missing.
```

### D2 — `ARCHITECTURE.md`

**D2a — new §2.6 (inserted between §2.5's "New files needed" list and `## 3. State Management`):**

Old:

```
**New files needed:**
- `extension/offscreen.html` — minimal HTML loading offscreen.js
- `extension/offscreen.js` — clipboard handler (exact copy from TextKit)

---

## 3. State Management
```

New (the inserted section is the only addition):

````
**New files needed:**
- `extension/offscreen.html` — minimal HTML loading offscreen.js
- `extension/offscreen.js` — clipboard handler (exact copy from TextKit)

### 2.6 Local file transcript (backend)

`POST /transcript` accepts a local video as a `file://` URL, an absolute path, or a `~/` path. The
backend classifies the input first:

```
raw → strip
 ├─ starts with "//"                          → WEB  (yt-dlp handles scheme-relative URLs today)
 ├─ URL scheme is "file" (case-insensitive)   → LOCAL
 ├─ starts with "/"                           → LOCAL
 ├─ starts with "~"                           → LOCAL
 └─ anything else                             → WEB  (existing yt-dlp pipeline, unchanged)
```

For LOCAL inputs `backend/local_file.py`:

1. normalises the path (percent-decoding and netloc checks for `file:`-scheme inputs only; raw paths
   are verbatim), expands `~`, resolves symlinks, checks the `local_files.allowed_roots` allowlist,
   existence, regular-file, and readability;
2. runs one 30 s-bounded `ffprobe -show_entries stream=index,codec_type,codec_name:stream_tags=language
   -of json` to learn audio presence and the ordered subtitle candidates; a failed probe means
   "streams unknown" and never fails the request;
3. tries sidecar subtitles (`<stem>.srt`/`.vtt`, then `<stem>.<lang>.srt|vtt` with English-likes
   first), then embedded text subtitle streams (extracted with
   `ffmpeg -nostdin -v error -i <video> -map 0:<global ffprobe index> -f srt -`, 120 s bound);
4. otherwise extracts audio with `ffmpeg -nostdin -v error -y -i <video> -vn -sn -dn -map 0:a:0
   -b:a 64k -ac 1 <tmpdir>/<stem>.mp3` and calls the existing `_transcribe_audio` unchanged.

Local results are cached under `local:<path_hash>:<content_hash>`, where the content hash covers the
video size, the video mtime, and a fingerprint of every discovered sidecar candidate — so editing a
sidecar or re-exporting the video forces a cache miss, and `_cache_put_local` deletes stale rows for
the same path in the same transaction as the insert. The response contract, cache table, and TextKit
/ File Bridge boundaries are unchanged.

---

## 3. State Management
````

**D2b — §10 init flow step 3 (`ARCHITECTURE.md:703`):**

Old:

```
  3. Pre-fill URL from current tab (existing)
```

New:

```
  3. Pre-fill URL from current tab (existing) and update the source chip
```

**D2c — §10 init flow step 5 (`ARCHITECTURE.md:705`):**

Old:

```
  5. Load persisted transcript result (existing)
```

New:

```
  5. Load persisted transcript result (existing; absolute local raw paths match a file:// tab URL via sourceKey equivalence)
```

> **Errata (post-implementation, lane-review finding F-1).** The delta above originally read "local raw
> paths"; the delivered text reads "**absolute** local raw paths" because §9.4 and §4.4 establish that
> `~` paths are compared verbatim and therefore cannot `sourceKey`-equal a decoded `file://` pathname —
> the documented low-impact gap. Only this documentation-precision wording changed: no normative
> requirement, contract, or code behaviour is affected. The executed plan text retains the original
> wording; the divergence is recorded here and in the PM run ledger.

### D3 — `README.md`

**D3a — prerequisites (`README.md:25`):**

Old:

```
- ffmpeg (for audio splitting on long videos)
```

New:

```
- ffmpeg (for audio splitting on long videos and local-file audio extraction)
```

**D3b — usage subsection (after the "Transcript tab" steps, `README.md:95–102`):**

Old:

```
### Transcript tab

1. Navigate to a video page (YouTube, Vimeo, etc.)
2. Click the YT2TXT icon — the current page URL is pre-filled
3. Optionally check **Force refresh** to bypass cache
4. Click **Get Transcript**
5. Copy or download the result
```

New:

```
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
```

**D3c — config example (`README.md`, the `cache:` block in step 2):**

Old:

```
cache:
  enabled: true
  ttl_days: 30
```

New:

```
cache:
  enabled: true
  ttl_days: 30

# Optional: restrict which local paths the backend may read.
# Empty (the default) means unrestricted.
local_files:
  allowed_roots: []
```

**D3d — architecture tree (`README.md:166`):**

Old:

```
backend/              ← FastAPI backend
  main.py             ← FastAPI app with /transcript and /health
```

New:

```
backend/              ← FastAPI backend
  main.py             ← FastAPI app with /transcript and /health
  local_file.py       ← local-file pipeline (classification, subtitles, ffmpeg)
```

---

## 8. Out of scope

Copied from the approved design §4; implementation **MUST NOT** creep into any of these:

- Browser file picker or uploading file bytes to the backend.
- File Bridge (`:8964`) path autocomplete for the URL box.
- Windows drive-letter path support (`C:\Users\x.mp4` stays WEB and keeps yt-dlp's existing error).
- OCR of bitmap subtitle tracks (`hdmv_pgs_subtitle`, `dvd_subtitle`, `dvb_subtitle`, `xsub`).
- Batch / multiple-file selection, playlists, or directory input.
- Changes to TextKit (`:8765`) or File Bridge (`:8964`).
- New `manifest.json` permissions (none are required).
- Per-audio-track selection: `-map 0:a:0` (first audio stream) is the documented limitation.

Also out of scope for this change specifically: adding a `pytest-asyncio` dev dependency; changing
the `/transcript` request/response contract; changing the SQLite schema. The headless-Chromium E2E
harness (design §12.6) is **deferred to post-implementation verification** (acceptance checklist
item 11 / §6.13), not dropped; the in-scope popup coverage is the harness tests in §5.4.

---

## 9. Interpretations flagged for review

Each item is a genuine point where the approved design does not dictate one mechanical edit. The
chosen resolution is the one implemented by the normative code in §2; none of these change D1–D6.

- **I-1 — `prepare()` and `probe_streams()` must be coroutines.** Design §5.1 shows
  `prepare(...)`/`probe_streams(...)` without `await`, but the mandated
  `asyncio.create_subprocess_exec` + "MUST NOT block the event loop" rule makes a synchronous
  signature impossible inside the running loop. *Recommended resolution (adopted):* `prepare` and
  `probe_streams` are `async def`, and `main.py` awaits `prepare`. Names, parameters, and return
  types are exactly as the design lists them. Alternative if reviewers insist on the literal
  signatures: run ffprobe via `asyncio.to_thread(subprocess.run, ...)` and make `prepare` async
  anyway — strictly worse (thread hop, no kill-on-timeout symmetry).

- **I-2 — `try_subtitles` needs `allowed_roots`.** §5.4 is normative that an escaping sidecar
  "neither authorises the request nor can be returned as its result", but the interface line is
  `try_subtitles(target, debug)` and `LocalTarget`'s declared field list contains no roots or
  candidate list. *Recommended resolution (adopted):*
  `async def try_subtitles(target, allowed_roots, debug)`; the selector re-runs the same
  deterministic discovery as the gate. Alternative: add `sidecar_candidates: tuple[Path, ...]` to
  `LocalTarget`, which would also avoid the second directory listing; either is fine, but both are
  extensions of the design's declared surface, so one must be recorded.

- **I-3 — where `_cache_put_local` gets `path_hash`.** The helper's signature is pinned
  (`video_id, text, source, ttl_days, path_hash`), but `LocalTarget` has no `path_hash` field.
  *Recommended resolution (adopted):* `main._transcript_local` derives it from the pinned key format
  `target.cache_key.split(":", 2)[1]` (exact, because `path_hash` is lowercase hex and the format has
  two colons). Alternative: add `path_hash` to `LocalTarget`. Relatedly, `size`/`mtime_ns` are
  sampled once with a single `path.stat()` **after** the gate; the design does not specify the
  sampling point.

- **I-4 — `classifyInput`'s final branch.** §9.2 says "…then `~`/`~/` → local, else web", but the
  next bullet and the §12.3 test matrix require relative paths, `//host/…`, and unrecognised schemes
  to be hidden. Both cannot hold. *Recommended resolution (adopted):* only `http://`/`https://`
  inputs that `new URL` parses produce `{kind:'web'}`; every other input reaching the final branch
  returns `null`. The test matrix is the pinned behaviour and "the backend stays authoritative".

- **I-5 — `file://` host case sensitivity.** §5.3 says netloc "must be empty or `localhost`".
  *Recommended resolution (adopted):* compare case-insensitively (`FILE://LOCALHOST/x` is accepted),
  because RFC 3986 hosts are case-insensitive; pinned tests use lowercase. A literal comparison would
  reject `LOCALHOST` with E2.

- **I-6 — sidecar ordering details.** §6.1 fixes "English-likes first and the remainder sorted
  deterministically" without naming the total order, and does not state the case rule for language
  tags or stems. *Recommended resolution (adopted):* language tags and extensions are compared
  lowercased; the sort key is `(group, lang_key, ext_rank, name_lower, name)` with group 0 = bare,
  1 = English-like (`en`, `en-*`, `eng`), 2 = other, and `ext_rank` `.srt` < `.vtt`; stems are matched
  case-sensitively (only the extension is case-insensitive, per the design's wording). Consequence:
  `Video.SRT` next to `video.mp4` is **not** discovered.

- **I-7 — position of the ffmpeg/ffprobe presence check.** §5.4 says `shutil.which` "first", then
  lists the resolved-path checks. *Recommended resolution (adopted):* classification → normalisation
  → `expanduser().resolve()` → tool presence (500) → allowlist/existence/regular/readable → probe and
  gate. The tool check cannot precede classification (web inputs must not need ffmpeg), and putting
  it after the path checks would return 403/404 instead of 500 on a machine without ffmpeg. Adding
  `ffmpeg` is a setup requirement, so E10 is deliberately the first path-independent failure.

- **I-8 — probe JSON shape strictness.** §5.4 lists "unparseable JSON" as streams-unknown.
  *Recommended resolution (adopted):* a payload that parses but cannot be used (`streams` missing or
  not a list) is also treated as streams-unknown (`ok=False`); individual malformed stream entries
  are skipped rather than failing the whole probe.

- **I-9 — flat `import local_file`.** `backend/` has no `__init__.py`; every existing invocation
  (`cd backend && python3 main.py`, `tests/` inserting `backend/` on `sys.path`) works with a flat
  import. *Recommended resolution (adopted):* keep `import local_file`. If `uvicorn backend.main:app`
  ever becomes a supported entry point, add
  `try: import local_file` / `except ModuleNotFoundError: from backend import local_file`; nothing in
  the repository or README uses that style today.

- **I-10 — the popup's empty-input message is part of P4.** The design's error table lists E1 (the
  long "Enter a video URL or a local video path…" string) under "Empty input, popup side", but
  neither design §9 nor §12.3 mentions changing `popup.js`'s `'Enter a video URL first.'`.
  *Recommended resolution (adopted):* P4.6 replaces it with the exact table string and §5.4 pins it
  with a test. The table is normative and test-pinned, so leaving the old string would violate it.

- **I-11 — trim policy for the popup helpers.** The design says "raw verbatim" for `sourceKey`'s
  non-`file:` cases, while §5.2's backend rules begin `raw → strip`. *Recommended resolution
  (adopted):* `classifyInput` trims (it mirrors the backend's classify step and needs the empty
  check), and `sourceKey` is verbatim (it implements the design's literal table). The difference is
  unobservable in practice: `entry.url` is stored from `startCapture`'s already-trimmed
  `urlInput.value.trim()`, and `tab.url` never carries surrounding whitespace.

---

## 10. Acceptance checklist

Implementation is complete when all of the following hold:

1. Production diff is exactly P1–P8 (§2): `backend/local_file.py` (new), `backend/main.py`,
   `backend/config.example.yaml`, `extension/popup.js`, `extension/popup.html`,
   `extension/background.js`, `extension/manifest.json`; `git diff` shows no other production edits.
2. `git diff` on `backend/main.py` shows the web branch of `/transcript` unchanged (only the
   `import local_file`, the `_parse_subtitle_text` body, the inserted `_cache_put_local`, the local
   branch block, `_transcript_local`, the `LocalFilesConfig`/parser additions, and the version bump
   differ).
3. `grep -n "Request timed out after 15 minutes" extension/background.js` returns nothing;
   `grep -n "TRANSCRIPT_TIMEOUT_MS = 120" extension/background.js` matches.
4. `grep -rn "local_files\|local_file" extension/offscreen.js extension/offscreen.html` returns
   nothing, and `extension/manifest.json`'s `permissions`/`host_permissions` are byte-identical to
   the base commit.
5. `python -m pytest tests/ -q` (canonical interpreter) passes 144/144 with the new tests present
   (76 in `test_local_file.py`, 13 in `test_config.py`); no existing assertion was modified or
   deleted.
6. `node --test tests/*.test.js` passes 69/69 including the 12 new popup tests and 5 new background
   tests.
7. The failing-then-passing probe: with P6 reverted, `node --test tests/background.test.js` fails
   at least the "abort message built from `TRANSCRIPT_TIMEOUT_MS`" and "no hard-coded timeout
   duration" tests.
8. Every error string in §3.5 is present verbatim in the source (spot-check E2, E4, E5, E9, E12).
9. Docs D1–D3 and `backend/config.example.yaml` (P8) are applied; version is 1.0.8 in all three
   locations (P7).
10. No commit is made by the implementer; the PM commits after review.
11. **Deferred post-implementation verification:** run the design §12.6 headless-Chromium E2E
    (real action popup + fake localhost backends) using the keepalive feature's harness
    `/tmp/yt2txt-e2e/run2.cjs` + `/tmp/yt2txt-e2e/server.cjs` (or the procedure in the
    `repro-yt2txt-popup-sw-lifetime` skill); it is not an implementation task and is not required
    to start implementation, but it MUST be run before the feature is declared accepted.
