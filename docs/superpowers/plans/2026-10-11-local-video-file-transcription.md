# Local Video File Transcription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.

**Goal:** Let `POST /transcript` accept a local video file (`file://` URL, absolute path, or `~/` path) and return a transcript from sidecar or embedded text subtitles, or from ffmpeg-extracted audio, while the popup labels the input source and the extension's transcript timeout grows from 15 to 120 minutes.

**Architecture:** A new `backend/local_file.py` owns classification, path normalisation, allowlist validation, sidecar discovery, one 30-second ffprobe, the subtitle cascade, and ffmpeg audio extraction; `backend/main.py` gains an additive local branch in `/transcript`, a local cache writer keyed `local:<path_hash>:<content_hash>`, and a thin `_parse_subtitle_text` wrapper over `local_file.parse_subtitle_text`. The extension changes are display- and timeout-only: a popup source chip plus `sourceKey`-equivalent result restore, and `TRANSCRIPT_TIMEOUT_MS` 15 → 120 minutes with a pure `formatTimeoutMessage(ms)` helper. Timelines are documented in `AGENTS.md`, `ARCHITECTURE.md`, and `README.md`.

**Tech Stack:** Python 3.14 FastAPI backend with async subprocesses (`asyncio.create_subprocess_exec`, ffprobe/ffmpeg) and a SQLite transcript cache; Chromium MV3 extension in plain JavaScript with Node `node:test` VM harnesses; pytest 9 with `asyncio.run(...)` so no `pytest-asyncio` dependency is added.

## Global Constraints

- Python tests run with the canonical interpreter `/data/home/henry-arch/anaconda3/envs/daily/bin/python` (Python 3.14.6, pytest 9.1.0, pytest-asyncio 1.4.0, fastapi 0.137.0, httpx 0.28.1); a bare system `python3` lacks fastapi/httpx and `pytest_asyncio`.
- Run the Python suite as `/data/home/henry-arch/anaconda3/envs/daily/bin/python -m pytest tests/ -q`; when this plan is complete it must report **144 passed** (baseline 55 = 29 `tests/test_config.py` + 26 `tests/test_transcription_chunking.py`; additions = 13 `tests/test_config.py` + 76 `tests/test_local_file.py`).
- Node v24.15.0 is the JavaScript runtime; run `node --test tests/*.test.js` (bare `node --test` from the repository root also works); when this plan is complete it must report **69 passed** (baseline 52 = 34 `tests/filebridge.test.js` + 18 `tests/popup.test.js`; additions = 12 `tests/popup.test.js` + 5 `tests/background.test.js`). Do not use `node --test tests/`.
- `ffmpeg` and `ffprobe` are installed (ffmpeg n9.0.2) and are required at runtime for local-file transcription; a missing binary is the pinned `HTTPException` 500 `ffmpeg is not installed.`
- No new dependencies: do not add `pytest-asyncio`, an npm package, or a build step; the extension stays plain JavaScript with no TypeScript.
- The only files that may change are `backend/local_file.py` (new), `backend/main.py`, `backend/config.example.yaml`, `tests/test_local_file.py` (new), `tests/test_config.py`, `extension/popup.js`, `extension/popup.html`, `extension/background.js`, `extension/manifest.json`, `tests/popup.test.js`, `tests/background.test.js` (new), `AGENTS.md`, `ARCHITECTURE.md`, and `README.md`.
- The web branch of `POST /transcript` (from `# ── Cache lookup ──` onward) and `extension/offscreen.js` / `extension/offscreen.html` must not change; no new manifest permission, no new HTTP endpoint, no new message type, no new `chrome.storage` key, and no change to the `/transcript` request/response shape.
- `local_file.prepare()` returns `None` for every web input and `_extract_video_id()` is never called for a local input, so `https://`, scheme-relative `//host/path`, relative, `rtmp:`, and Windows-style inputs reach the existing yt-dlp pipeline byte-for-byte unchanged.
- Python tests use `asyncio.run(...)` inside sync test functions (the `tests/test_transcription_chunking.py` pattern); no existing assertion may be weakened or deleted.
- Each task commits only the files its Files block names; do not use `git add -A` or `git add .`.

## Task 1: `local_files` configuration parser and config example

**Implementer tier:** Standard

**Lane:** backend

**Depends on:** none

**Files:**
- Modify: `backend/main.py:58-81` (insert `LocalFilesConfig` before `AppConfig`; add the `AppConfig.local_files` field)
- Modify: `backend/main.py:133` (insert `_parse_local_files_config` immediately after `_parse_timeout_config`)
- Modify: `backend/main.py:165-176` (add the `local_files=` keyword to the `AppConfig(...)` call in `load_config`)
- Modify: `backend/config.example.yaml:31-38` (insert the `local_files` block between `cache:` and the trailing debug comment)
- Test: `tests/test_config.py:10-22` (extend the existing `from main import (...)` list) and append `TestLocalFilesConfig`

**Interfaces:**
- Consumes (existing base-commit code): `_load_yaml_config(path: Path = CONFIG_PATH) -> dict[str, Any]`; the frozen dataclass `TimeoutConfig`; `_parse_timeout_config(raw_timeout: Any) -> TimeoutConfig`; `load_config() -> AppConfig`; the imported names `Any` and `Path`; existing `AppConfig` fields `host: str`, `port: int`, `debug: bool`, `api_base: str`, `api_key: str`, `model: str`, `timeout: TimeoutConfig`, `cache_enabled: bool`, `cache_ttl_days: int`. From `tests/test_config.py`: `import main as backend_main` and the existing `from main import (...)` list.
- Produces:
  - `LocalFilesConfig` — `@dataclass(frozen=True)` with `allowed_roots: tuple[Path, ...] = ()`.
  - `_parse_local_files_config(raw_local_files: Any) -> LocalFilesConfig`, raising `RuntimeError` with these exact messages: `local_files must be a mapping`; `Unknown local_files setting(s): <names>`; `local_files.allowed_roots must be a list, got <type>`; `local_files.allowed_roots entries must be non-empty strings`; `local_files.allowed_roots entry must be absolute after expansion: <entry>`. Entries become `Path(entry).expanduser().resolve()` once at load time; root existence is not required.
  - `AppConfig.local_files: LocalFilesConfig = LocalFilesConfig()` — consumed by Task 4 as `config.local_files.allowed_roots: tuple[Path, ...]`.
  - `backend/config.example.yaml` documents `local_files.allowed_roots: []` (empty = unrestricted).
- Cross-lane dependencies: none — the `backend`, `extension`, and `docs` lanes are file-disjoint, and this task consumes nothing from the other two; same-lane ordering is expressed by plan order (Task 2 follows).

- [ ] **Step 1: Extend the config test imports and append the failing `TestLocalFilesConfig`**

In `tests/test_config.py`, replace the existing `from main import (...)` list:

```python
from main import (  # noqa: E402
    DEFAULT_TIMEOUT_CONNECT,
    DEFAULT_TIMEOUT_POOL,
    DEFAULT_TIMEOUT_READ,
    DEFAULT_TIMEOUT_WRITE,
    TIMEOUT_RANGES,
    AppConfig,
    TimeoutConfig,
    _parse_timeout_config,
)
```

with:

```python
from main import (  # noqa: E402
    DEFAULT_TIMEOUT_CONNECT,
    DEFAULT_TIMEOUT_POOL,
    DEFAULT_TIMEOUT_READ,
    DEFAULT_TIMEOUT_WRITE,
    TIMEOUT_RANGES,
    AppConfig,
    LocalFilesConfig,
    TimeoutConfig,
    _parse_local_files_config,
    _parse_timeout_config,
)
```

Then append the following to the end of `tests/test_config.py` (do not place it inside any existing class):

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

- [ ] **Step 2: Run the new tests and observe the failure**

Run: `/data/home/henry-arch/anaconda3/envs/daily/bin/python -m pytest tests/test_config.py -q`
Expected: FAIL — collection error `ImportError: cannot import name 'LocalFilesConfig' from 'main'` while importing `tests/test_config.py`. The 29 pre-existing tests in the file do not run; this is the expected pre-implementation state.

- [ ] **Step 3: Add `LocalFilesConfig` and the `AppConfig` field to `backend/main.py`**

Replace the current `AppConfig` dataclass (which is preceded by the `TimeoutConfig` dataclass):

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

with `LocalFilesConfig` inserted before it and the `local_files` field added as the last field:

```python
@dataclass(frozen=True)
class LocalFilesConfig:
    """Local-file input settings loaded from the local_files section."""

    allowed_roots: tuple[Path, ...] = ()

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

Do not change `TimeoutConfig`.

- [ ] **Step 4: Insert `_parse_local_files_config` after `_parse_timeout_config`**

Insert the following immediately after the closing `)` and `return` of `_parse_timeout_config` and before the blank line that precedes `def load_config() -> AppConfig:`:

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

Validation-order invariant: the absolute-path check runs **after** `expanduser()` but **before** `resolve()`. `resolve()` would make a relative entry absolute and silently defeat the check, so those two calls must keep that order.

- [ ] **Step 5: Wire the parser into `load_config`**

In the `AppConfig(...)` call inside `load_config`:

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

replace it with:

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

`raw.get("local_files")` is passed directly, never through `... or {}`: a scalar or list value must reach the parser so it can raise `RuntimeError`. `load_config()` must still set the module global `_debug_enabled = config.debug` and return the config.

- [ ] **Step 6: Run the config tests and observe them pass**

Run: `/data/home/henry-arch/anaconda3/envs/daily/bin/python -m pytest tests/test_config.py -q`
Expected: PASS — **42 passed** (29 pre-existing + 13 new). No test may be skipped.

- [ ] **Step 7: Document the `local_files` block in `backend/config.example.yaml`**

Current:

```yaml
# Transcription cache (SQLite). Enabled by default.
# Cache hits skip all yt-dlp and API work — instant response.
cache:
  enabled: true
  ttl_days: 30
```

Replacement:

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

- [ ] **Step 8: Reviewer validation (non-mutating) and commit**

Run: `grep -n allowed_roots backend/config.example.yaml`
Expected: two matching lines — the `# ... allowed_roots ...` comment line and `  allowed_roots: []`.

Run: `/data/home/henry-arch/anaconda3/envs/daily/bin/python -m pytest tests/test_config.py -q`
Expected: 42 passed.

```bash
git add backend/main.py backend/config.example.yaml tests/test_config.py
git commit -m "feat(backend): add local_files.allowed_roots configuration"
```

## Task 2: `local_file.py` core — classification through prepare

**Implementer tier:** Fast

**Lane:** backend

**Depends on:** none

**Files:**
- Create: `backend/local_file.py` (Task 3 appends the subtitle cascade and audio extraction to this file)
- Create: `tests/test_local_file.py` (Task 3 inserts and appends the remaining test classes; Task 4 adds the last two methods and the final class)

**Interfaces:**
- Consumes: Python standard library (`asyncio`, `hashlib`, `json`, `os`, `re`, `shlex`, `shutil`, `dataclasses.dataclass`, `pathlib.Path`, `typing.Callable`, `urllib.parse.unquote`, `urllib.parse.urlparse`) and `fastapi.HTTPException`. This module must **not** import `backend/main.py`: `main` imports this module, so the reverse import would create a cycle.
- Produces (exact signatures, consumed by Tasks 3 and 4):
  - `Logger = Callable[[str, str], None]`, always called as `debug(tag, message)`.
  - Constants: `PROBE_TIMEOUT = 30.0`; `EMBEDDED_SUBTITLE_TIMEOUT = 120.0` (first consumed by Task 3); `AUDIO_EXTRACTION_TIMEOUT = 900.0` (first consumed by Task 3); `TEXT_SUBTITLE_CODECS: frozenset[str] = frozenset({"subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text", "ttml"})`; `_SIDECAR_EXTENSIONS = (".srt", ".vtt")`.
  - Frozen dataclasses: `StreamCandidate(index: int, codec_name: str, language: str | None)` where `index` is the ffprobe global stream index (not a subtitle ordinal); `StreamProbe(ok: bool, has_audio: bool | None, subtitle_candidates: tuple[StreamCandidate, ...])` with the invariant `ok is False` implies `has_audio is None` and `subtitle_candidates == ()`; `LocalTarget(raw: str, path: Path, sidecar_fingerprint: str, cache_key: str, size: int, mtime_ns: int, streams: StreamProbe)` where `path` is resolved and `cache_key == f"local:{path_hash}:{content_hash}"`.
  - `classify(raw: str) -> str` — `"web"` when the trimmed input starts with `//` (checked first), `"local"` for `file:`-scheme, `/`-rooted, and `~`-rooted inputs, `"web"` otherwise.
  - `normalize_local_path(raw: str) -> Path` — raises `HTTPException(400, "file:// URLs with a remote host are not supported: <host>")`, then `HTTPException(400, "file:// URL must have an absolute path")`, then `HTTPException(400, "file:// URLs must not contain a query or fragment; percent-encode literal ? and # as %3F and %23")`. Only `file:`-scheme inputs are URL-parsed; raw absolute and `~` inputs are used verbatim so a filename containing `?` or `#` is not truncated.
  - `parse_subtitle_text(content: str) -> str` — pure, never raises; `is_text_subtitle_codec(codec: str) -> bool` — `codec.strip().lower() in TEXT_SUBTITLE_CODECS`.
  - `async probe_streams(path: str, debug: Logger) -> StreamProbe` — **never raises**; returns `StreamProbe(ok=False, has_audio=None, subtitle_candidates=())` for a missing `ffprobe` binary, a 30-second timeout, a non-zero exit, or an unparseable payload.
  - `async prepare(raw: str, allowed_roots: tuple[Path, ...], debug: Logger) -> LocalTarget | None` — `None` for every web input; raises `HTTPException` 500 `ffmpeg is not installed.`, 403 `Path is outside local_files.allowed_roots (configured: <roots>): <path>`, 404 `Local file not found: <path>`, 400 `<path> is not a regular file`, 403 `<path> is not readable`, 400 `No audio or subtitle stream found in: <path>`.
  - Internal helpers (used by the tests): `_language_rank(language: str | None) -> int`; `_is_english_like(tag: str) -> bool`; `_sidecar_ext_rank(ext: str) -> int`; `_discover_sidecars(path: Path, allowed_roots: tuple[Path, ...], debug: Logger) -> list[Path]`; `_sidecar_fingerprint(candidates: list[Path]) -> str`; `_first_usable_sidecar(candidates: list[Path], debug: Logger) -> tuple[Path, str] | None`; `_run_bounded(cmd: list[str], *, timeout: float, debug: Logger) -> tuple[int, bytes, bytes]`.
- Cross-lane dependencies: none — the `extension` lane is independent at the code level and the `docs` lane is literal text edits; this task consumes no interface from either. Same-lane ordering is expressed by plan order (Task 3 follows and extends this file).

- [ ] **Step 1: Create `tests/test_local_file.py` with the classification, access-policy, and cache-key tests**

Create the file with exactly this content. It contains the module scaffolding, all four ffmpeg fixture builders, `TestClassification`, `TestAccessPolicy` (without `test_symlinked_sidecar_escaping_roots_is_skipped`, which Task 3 inserts), and `TestCacheKey` (without the two `test_cache_put_local_*` methods, which Task 4 inserts). Do not add any other test.

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

```

- [ ] **Step 2: Run the new test file and observe the failure**

Run: `/data/home/henry-arch/anaconda3/envs/daily/bin/python -m pytest tests/test_local_file.py -q`
Expected: FAIL — collection error `ModuleNotFoundError: No module named 'local_file'` raised by the test module's `import local_file` after it inserts `backend/` on `sys.path`. No test runs yet; this is the expected pre-implementation state.

- [ ] **Step 3: Create `backend/local_file.py` with the core module**

Create the file with exactly this content. It is the first of two parts; Task 3 appends the subtitle cascade and audio extraction after the end of this content.

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


```

- [ ] **Step 4: Run the test file and observe it pass**

Run: `/data/home/henry-arch/anaconda3/envs/daily/bin/python -m pytest tests/test_local_file.py -q`
Expected: PASS — **45 passed** (26 in `TestClassification`, 10 in `TestAccessPolicy`, 9 in `TestCacheKey`). No test may be skipped; the two `chmod 000` tests run because the test runner is not root. The suite generates its own ffmpeg fixtures and needs no network.

- [ ] **Step 5: Reviewer validation (non-mutating) and commit**

Run: `/data/home/henry-arch/anaconda3/envs/daily/bin/python -m pytest tests/test_local_file.py -q`
Expected: 45 passed.

Run: `grep -c try_subtitles backend/local_file.py`
Expected: `0` with a non-zero exit status — the function arrives in Task 3; this only confirms the Task 2 cut is where this plan says it is.

```bash
git add backend/local_file.py tests/test_local_file.py
git commit -m "feat(backend): add local_file core (classification, sidecars, probe, prepare)"
```

## Task 3: `local_file.py` subtitle cascade and audio extraction

**Implementer tier:** Fast

**Lane:** backend

**Depends on:** none

**Files:**
- Modify: `backend/local_file.py` (append `try_subtitles` and `extract_audio` after the end of `prepare()`)
- Modify: `tests/test_local_file.py` (insert `test_symlinked_sidecar_escaping_roots_is_skipped` plus the usability-gate and stream-probe classes before the `# ── Cache key ──` banner; append the sidecar, embedded, and audio classes at the end)

**Interfaces:**
- Consumes (from Task 2, restated exactly): `LocalTarget(raw: str, path: Path, sidecar_fingerprint: str, cache_key: str, size: int, mtime_ns: int, streams: StreamProbe)`; `StreamProbe(ok: bool, has_audio: bool | None, subtitle_candidates: tuple[StreamCandidate, ...])`; `StreamCandidate(index: int, codec_name: str, language: str | None)`; `parse_subtitle_text(content: str) -> str`; `is_text_subtitle_codec(codec: str) -> bool`; `_discover_sidecars(path: Path, allowed_roots: tuple[Path, ...], debug: Logger) -> list[Path]`; `_first_usable_sidecar(candidates: list[Path], debug: Logger) -> tuple[Path, str] | None`; `_run_bounded(cmd: list[str], *, timeout: float, debug: Logger) -> tuple[int, bytes, bytes]`; constants `EMBEDDED_SUBTITLE_TIMEOUT = 120.0` and `AUDIO_EXTRACTION_TIMEOUT = 900.0`; `Logger = Callable[[str, str], None]`. Also `fastapi.HTTPException`, `asyncio`, `os`.
- Produces:
  - `async try_subtitles(target: LocalTarget, allowed_roots: tuple[Path, ...], debug: Logger) -> tuple[str, str] | None` — returns `(text, "sidecar")` for the first usable sidecar, `(text, "ffmpeg")` for the first text-codec embedded stream that yields text, or `None` when every candidate fails. Subtitle problems never raise except `HTTPException(500, "ffmpeg is not installed.")` when the `ffmpeg` binary is missing. It reads `target.streams.subtitle_candidates` and **never** calls `probe_streams()` (the one-probe rule).
  - `async extract_audio(target: LocalTarget, tmpdir: str, debug: Logger) -> str` — returns `<tmpdir>/<target.path.stem>.mp3`; raises `HTTPException(500, "ffmpeg is not installed.")`, `HTTPException(504, f"Timed out extracting audio from {target.path}")`, or `HTTPException(400, f"Failed to extract audio: {stderr_tail}")` where `stderr_tail = stderr.decode("utf-8", errors="replace")[:300]`.
- Cross-lane dependencies: none. Same-lane ordering is expressed by plan order (Task 4 follows).

- [ ] **Step 1: Insert the sidecar-escape, usability-gate, and stream-probe tests into `tests/test_local_file.py`**

Replace this exact text (the end of `TestAccessPolicy` as left by Task 2, followed by the blank line and the `# ── Cache key ──` banner):

```python
        assert exc.value.detail == "ffmpeg is not installed."

# ── Cache key ───────────────────────────────────────────────────
```

with (this inserts the skipped access-policy method and the two reserved test sections before the cache-key banner):

```python
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
```

- [ ] **Step 2: Append the sidecar, embedded, and audio tests to `tests/test_local_file.py`**

Append the following at the end of `tests/test_local_file.py`:

```python
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


```

- [ ] **Step 3: Run the test file and observe the red state**

Run: `/data/home/henry-arch/anaconda3/envs/daily/bin/python -m pytest tests/test_local_file.py -q`
Expected: FAIL — **21 failed, 48 passed**. The failures are `AttributeError: module 'local_file' has no attribute 'try_subtitles'` and the same for `extract_audio`; the three tests that only exercise `prepare()` (`test_no_audio_no_subs_400`, `test_no_audio_with_only_empty_sidecar_400`, `test_is_text_subtitle_codec_predicate`) plus the 45 Task 2 tests pass. This is the expected pre-implementation state for this task.

- [ ] **Step 4: Append `try_subtitles` and `extract_audio` to `backend/local_file.py`**

Append the following at the end of `backend/local_file.py`:

```python
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

- [ ] **Step 5: Run the test file and observe it pass**

Run: `/data/home/henry-arch/anaconda3/envs/daily/bin/python -m pytest tests/test_local_file.py -q`
Expected: PASS — **69 passed** (45 from Task 2 + 24 new: 1 access-policy, 4 usability-gate, 3 stream-probe, 5 sidecar, 8 embedded, 3 audio). No test may be skipped.

- [ ] **Step 6: Reviewer validation (non-mutating) and commit**

Run: `/data/home/henry-arch/anaconda3/envs/daily/bin/python -m pytest tests/test_local_file.py -q`
Expected: 69 passed.

```bash
git add backend/local_file.py tests/test_local_file.py
git commit -m "feat(backend): add local-file subtitle cascade and ffmpeg audio extraction"
```

## Task 4: `/transcript` local branch and local cache writer

**Implementer tier:** Standard

**Lane:** backend

**Depends on:** none

**Files:**
- Modify: `backend/main.py:29` (add the `import local_file` line after `from pydantic import BaseModel`); all `backend/main.py` line numbers are base-commit anchors and Task 1's insertion shifts them by about 50 lines, so locate each region by the quoted symbol
- Modify: `backend/main.py:322-353` (`_parse_subtitle_text` becomes a thin wrapper)
- Modify: `backend/main.py:994-1017` (insert `_cache_put_local` immediately after `_cache_put`)
- Modify: `backend/main.py:1027-1042` (insert the local branch into `transcript()`)
- Modify: `backend/main.py` (insert `_transcript_local` immediately after the closing `}` of `transcript()` and before the `# ── Startup cleanup ──` banner)
- Modify: `backend/main.py:183` (`app = FastAPI(title="YT2TXT", version="1.0.7")` → `version="1.0.8"`)
- Modify: `tests/test_local_file.py` (insert the two `test_cache_put_local_*` methods into `TestCacheKey`; append `TestResponseFields` at the end)

**Interfaces:**
- Consumes (restated from the producing tasks):
  - From Task 1: `config.local_files.allowed_roots: tuple[Path, ...]` on `AppConfig`, defaulting to `()`.
  - From Task 2: `async local_file.prepare(raw: str, allowed_roots: tuple[Path, ...], debug: Logger) -> LocalTarget | None`; `LocalTarget.cache_key: str` in the exact form `f"local:{path_hash}:{content_hash}"` with both hashes 16 lowercase hex characters; `LocalTarget.path: Path` (resolved); `LocalTarget.streams: StreamProbe`.
  - From Task 3: `async local_file.try_subtitles(target: LocalTarget, allowed_roots: tuple[Path, ...], debug: Logger) -> tuple[str, str] | None`; `async local_file.extract_audio(target: LocalTarget, tmpdir: str, debug: Logger) -> str`.
  - Existing `backend/main.py`: `get_config() -> AppConfig`; `_debug(tag: str, msg: str) -> None`; `_cache_get(video_id: str, ttl_days: int) -> dict | None`; `_cache_put(video_id: str, text: str, source: str, ttl_days: int) -> None`; `_get_cache_db() -> sqlite3.Connection`; `async _transcribe_audio(audio_path: str, config: AppConfig, model: str) -> str`; `TranscriptRequest`; `tempfile`.
- Produces:
  - Module-scope `import local_file` (flat import; `tests/` inserts `backend/` on `sys.path` and `python3 main.py` runs with `backend/` as the script directory).
  - `_parse_subtitle_text(path: str) -> str` — identical behaviour, delegating the regex to `local_file.parse_subtitle_text(content)`.
  - `_cache_put_local(video_id: str, text: str, source: str, ttl_days: int, path_hash: str) -> None` — exactly one `_get_cache_db()` connection and exactly one `conn.commit()`, covering three statements: the `INSERT OR REPLACE`, the existing TTL prune, and the same-path stale delete `WHERE video_id LIKE ? AND video_id <> ?` with `(f"local:{path_hash}:%", video_id)`.
  - `async _transcript_local(target: local_file.LocalTarget, config: AppConfig, model: str, force: bool) -> dict[str, Any]` — returns exactly `{"text": str, "source": "subtitles" | "transcription", "model": "sidecar" | "ffmpeg" | "cached" | <model>, "error": None}`.
  - The local branch in `transcript()`: `target = await local_file.prepare(url, config.local_files.allowed_roots, _debug)` and `if target is not None: return await _transcript_local(target, config, model, req.force)`, placed immediately after `_debug("transcript", f"Processing: {url}")` and before `# ── Cache lookup ──`.
  - `app = FastAPI(title="YT2TXT", version="1.0.8")`.
- Cross-lane dependencies: none. The `extension` and `docs` lanes consume nothing from this task at the code level. The web branch of `transcript()` from `# ── Cache lookup ──` onward must stay byte-for-byte identical.

- [ ] **Step 1: Insert the local-cache and response-field tests into `tests/test_local_file.py`**

Replace the `# ── Sidecar cascade ──` banner line:

```python
# ── Sidecar cascade ─────────────────────────────────────────────
```

with this text (the two `TestCacheKey` methods followed by the same banner, so they land as the last methods of `TestCacheKey`):

```python
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
```

Then append the following at the end of `tests/test_local_file.py`:

```python
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

- [ ] **Step 2: Run the test file and observe the red state**

Run: `/data/home/henry-arch/anaconda3/envs/daily/bin/python -m pytest tests/test_local_file.py -q`
Expected: FAIL — **6 failed, 70 passed**. The failures are `AttributeError: module 'main' has no attribute '_cache_put_local'` (2 tests in `TestCacheKey`) and `AttributeError: module 'main' has no attribute '_transcript_local'` (4 tests in `TestResponseFields`). `test_web_regression_never_enters_local_branch` already passes because it exercises only the unchanged web path; it guards against regressions rather than driving new code.

- [ ] **Step 3: Add the `local_file` import to `backend/main.py`**

The third-party import block currently reads:

```python
import httpx
import yaml
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel
```

Append a blank line and the flat import after the last line so the block ends:

```python
from pydantic import BaseModel

import local_file
```

- [ ] **Step 4: Make `_parse_subtitle_text` a thin wrapper**

Replace:

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

with:

```python
def _parse_subtitle_text(path: str) -> str:
    """Extract plain text from an SRT/VTT file (strip timestamps and indices)."""
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()
    return local_file.parse_subtitle_text(content)
```

The regex logic now lives in `local_file.parse_subtitle_text(content)`, so the yt-dlp subtitle flow and any external caller of `main._parse_subtitle_text` are behaviourally unchanged. The string form is required because embedded subtitles are extracted to stdout, not to a file.

- [ ] **Step 5: Insert `_cache_put_local` immediately after `_cache_put`**

`_cache_put` is currently (insert the new helper immediately after its closing `finally:` block):

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

Insert after it:

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

Invariants: exactly one `_get_cache_db()` connection and exactly one `conn.commit()` for the three statements; `path_hash` is lowercase hex, so the `LIKE 'local:<path_hash>:%'` pattern cannot over-match another path. `_cache_get()` and `_cache_prune_video()` are reused verbatim and the table schema is unchanged.

- [ ] **Step 6: Insert the local branch into `transcript()`**

Replace:

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

with:

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

`_extract_video_id()` is therefore never called for a local input. The web pipeline after `# ── Cache lookup ──` is byte-for-byte unchanged, and for a web input `prepare()` returns `None`.

- [ ] **Step 7: Insert `_transcript_local` before the Startup cleanup banner**

Immediately after the closing `}` of `transcript()` and before `# ── Startup cleanup ────────────────────────────────────────────`, insert:

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

Notes: audio extraction and transcription share the existing `tempfile.TemporaryDirectory()`; `_transcribe_audio(audio_path, config, model)` is the unchanged function; `force=True` skips only the read and still writes a successful result; `config.cache_enabled=False` disables both the read and the write. `path_hash` is the middle segment of `target.cache_key` (`local:<path_hash>:<content_hash>`), derived with `target.cache_key.split(":", 2)[1]`.

- [ ] **Step 8: Bump the FastAPI version string**

Replace `app = FastAPI(title="YT2TXT", version="1.0.7")` with:

```python
app = FastAPI(title="YT2TXT", version="1.0.8")
```

- [ ] **Step 9: Run the test file and observe it pass**

Run: `/data/home/henry-arch/anaconda3/envs/daily/bin/python -m pytest tests/test_local_file.py -q`
Expected: PASS — **76 passed** (69 from Task 3 + 2 local-cache methods + 5 response-field tests). No test may be skipped.

- [ ] **Step 10: Reviewer validation (whole suite) and commit**

Run: `/data/home/henry-arch/anaconda3/envs/daily/bin/python -m pytest tests/ -q`
Expected: PASS — **144 passed** (29 + 13 in `tests/test_config.py`, 26 in `tests/test_transcription_chunking.py`, 76 in `tests/test_local_file.py`). This is the backend-lane acceptance command.

Run: `grep -c 1.0.7 backend/main.py`
Expected: `0` (the version is now 1.0.8).

```bash
git add backend/main.py tests/test_local_file.py
git commit -m "feat(backend): add local-file branch, local cache writer, and /transcript wiring"
```

## Task 5: Popup source chip, local-path restore, and empty-input message

**Implementer tier:** Standard

**Lane:** extension

**Depends on:** none

**Files:**
- Modify: `extension/popup.js:42` (source-chip element references), `:90` (chip helper block), `:138` (input listener), `:262-265` (chip update after the init prefill), `:275` (restore condition), `:494-496` (empty-input message)
- Modify: `extension/popup.html:157` (dark-theme chip CSS), `:311` (light-theme chip CSS), `:354` (displayed version `v1.0.7` → `v1.0.8`), `:383-385` (chip markup)
- Test: `tests/popup.test.js:36-37` (harness `localData`), `:40-50` (`el` helper), `:90` (chip elements), `:138-145` (`chrome.storage.local.get`), `:148` (`tabs.query`), and append 12 tests
- Note: `extension/manifest.json`'s version is handled in Task 6; the popup's visible version is handled here.

**Interfaces:**
- Consumes: existing `extension/popup.js` internals `urlInput`, `resultEl`, `statusBar`, `startCapture()`, `init()`, `chrome.storage.local.get(key)`, and the `// ── State ──` banner location; the VM harness `createPopupHarness(options: { localData?: object, tabUrl?: string, ... })` returning `{ context, elements, fetchCalls, syncValues, runtimeMessages }`, where `context` exposes top-level function declarations (`init`, `classifyInput`, `sourceKey`, `updateSourceChip`, `startCapture`, ...) and `elements[id]` returns the stubbed DOM node.
- Produces:
  - `inputBasename(p: string) -> string` — last `/`-separated segment, or `p` when empty.
  - `fileUrlDisplayPath(raw: string) -> string` — `decodeURIComponent(new URL(raw).pathname)`, falling back to `raw` when either step throws.
  - `classifyInput(raw: string) -> { kind: 'local' | 'web', label: string, title: string } | null` — trims; returns `null` for empty, for `//`-prefixed input (checked first), and for anything not `file:`-scheme, `/`-rooted, `~`-rooted, or a parseable `http(s)://` URL. Local: `label = 'Local file · ' + inputBasename(<decoded path>)`, `title` = decoded path (or the raw string when decoding throws). Web: `label = 'Web URL · ' + new URL(s).hostname`, `title = s`.
  - `sourceKey(raw: unknown) -> string` — for `/^file:/i` input whose `new URL` and `decodeURIComponent` both succeed, `decodeURIComponent(new URL(s).pathname)`; otherwise `String(raw ?? '')` verbatim.
  - `updateSourceChip(): void` — toggles the `hidden` class on `#source-chip`, sets the icon (`📁` local / `🌐` web / empty), label, and title.
  - DOM contract: `#source-chip` (class `source-chip hidden`), `#source-chip-icon`, `#source-chip-label`.
  - Restore contract: `transcript:<tabId>` restores when `entry.url === tab?.url` **or** `sourceKey(entry.url) === sourceKey(tab?.url ?? '')`.
  - Empty-input message (E1, exact): `Enter a video URL or a local video path (for example the file:// URL of a video open in this tab).`
- Cross-lane dependencies: none. This lane is independent of the `backend` changes at the code level (the chip is display-only and the restore condition is storage-only) and of `docs`; same-lane ordering is expressed by plan order (Task 6 follows).

- [ ] **Step 1: Add the `localData` stub to `tests/popup.test.js`**

Replace:

```javascript
  const fetchCalls = [];
  const runtimeMessages = [];
```

with:

```javascript
  const fetchCalls = [];
  const runtimeMessages = [];
  const localData = { ...(options.localData || {}) };
```

- [ ] **Step 2: Give the harness a real class-list stub and chip elements**

Replace the existing `el()` helper:

```javascript
  function el(id, overrides = {}) {
    const defaults = {
      value: '',
      disabled: false,
      checked: false,
      textContent: '',
      classList: { add() {}, remove() {}, toggle() {}, contains() {} },
      addEventListener() {},
      replaceChildren() {},
    };
    return { id, ...defaults, ...overrides };
  }
```

with:

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

Then add the three chip elements to the `elements` map immediately after `force: el('force'),`:

```javascript
    'source-chip': el('source-chip'),
    'source-chip-icon': el('source-chip-icon'),
    'source-chip-label': el('source-chip-label'),
```

- [ ] **Step 3: Make the `chrome.storage.local.get` stub honour `localData`**

Replace the current body:

```javascript
        get(keys) {
          let result = {};
          if (typeof keys === 'object' && !Array.isArray(keys)) result = { ...keys };
          return Promise.resolve(result);
        },
```

with:

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

- [ ] **Step 4: Make the active-tab URL overridable**

Replace the `tabs` stub:

```javascript
    tabs: {
      query: async () => [{ id: 1, url: 'https://youtube.com/watch?v=test' }],
    },
```

with:

```javascript
    tabs: {
      query: async () => [{ id: 1, url: options.tabUrl || 'https://youtube.com/watch?v=test' }],
    },
```

- [ ] **Step 5: Append the failing chip, restore, and empty-input tests**

Append the following at the end of `tests/popup.test.js`:

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

- [ ] **Step 6: Run the popup tests and observe the red state**

Run: `node --test tests/popup.test.js`
Expected: FAIL — **18 passed, 12 failed** (Node prints `pass 18` / `fail 12`). The failures are `TypeError: harness.context.classifyInput is not a function` (and the same for `sourceKey`/`updateSourceChip`), plus the empty-input message expectation. The 18 pre-existing tests still pass.

- [ ] **Step 7: Apply the `extension/popup.js` changes**

Reference the chip elements after `const forceCheckbox = document.getElementById('force');`:

```javascript
const forceCheckbox = document.getElementById('force');
const sourceChip = document.getElementById('source-chip');
const sourceChipIcon = document.getElementById('source-chip-icon');
const sourceChipLabel = document.getElementById('source-chip-label');
```

Insert the helper block immediately before the `// ── State ──` banner:

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

Add the input listener directly above the existing host listener:

```javascript
urlInput.addEventListener('input', updateSourceChip);
hostInput.addEventListener('change', saveYt2txtSettings);
```

Update the chip once after the init prefill (a programmatic `.value` assignment does not fire the `input` event):

```javascript
  // Pre-fill URL from current tab
  if (tab?.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('about:')) {
    urlInput.value = tab.url;
  }
  updateSourceChip();
```

Replace the restore condition:

```javascript
      if (typeof entry === 'object' && entry.url === tab?.url) {
        resultEl.value = entry.text || '';
      } else if (typeof entry === 'string') {
```

with:

```javascript
      if (
        typeof entry === 'object' &&
        (entry.url === tab?.url ||
          sourceKey(entry.url) === sourceKey(tab?.url ?? ''))
      ) {
        resultEl.value = entry.text || '';
      } else if (typeof entry === 'string') {
```

Replace the empty-input message:

```javascript
  const url = urlInput.value.trim();
  if (!url) {
    statusBar.textContent = 'Enter a video URL first.';
```

with:

```javascript
  const url = urlInput.value.trim();
  if (!url) {
    statusBar.textContent =
      'Enter a video URL or a local video path (for example the file:// URL of a video open in this tab).';
```

- [ ] **Step 8: Apply the `extension/popup.html` changes**

Append the chip CSS after `#url:focus { border-color: #38bdf8; outline: none; }` in the dark theme:

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

Append the light-theme overrides after `#url:focus { border-color: #0284c7; }` inside the `@media (prefers-color-scheme: light)` block:

```css
      #url:focus { border-color: #0284c7; }

      .source-chip { background: #e2e8f0; color: #64748b; }
      .source-chip .source-chip-icon { color: #0284c7; }
```

Replace the URL-row markup:

```html
    <div class="url-row">
      <input id="url" type="text" placeholder="Paste video URL or use current page...">
    </div>
```

with (the chip starts hidden via the existing `.hidden` utility class; element IDs are normative):

```html
    <div class="url-row">
      <input id="url" type="text" placeholder="Paste video URL or use current page...">
    </div>
    <div id="source-chip" class="source-chip hidden"><span id="source-chip-icon"></span><span id="source-chip-label"></span></div>
```

Replace the displayed version:

```html
    <span class="version">v1.0.7</span>
```

with:

```html
    <span class="version">v1.0.8</span>
```

- [ ] **Step 9: Run the popup tests and the full JavaScript suite**

Run: `node --test tests/popup.test.js`
Expected: PASS — **30 passed** (18 pre-existing + 12 new). No test may be skipped.

Run: `node --test tests/*.test.js`
Expected: **64 passed** at this point in plan order (30 in `tests/popup.test.js` + 34 pre-existing in `tests/filebridge.test.js`); `tests/background.test.js` arrives in Task 6 and lifts this to 69.

- [ ] **Step 10: Reviewer validation (non-mutating) and commit**

Run: `node --test tests/popup.test.js`
Expected: 30 passed.

```bash
git add extension/popup.js extension/popup.html tests/popup.test.js
git commit -m "feat(extension): label local-file input and restore local transcripts in the popup"
```

## Task 6: 120-minute transcript timeout and manifest version

**Implementer tier:** Fast

**Lane:** extension

**Depends on:** none

**Files:**
- Modify: `extension/background.js:7` (timeout constant plus a pure `formatTimeoutMessage` helper)
- Modify: `extension/background.js:402-405` (abort message uses the helper)
- Modify: `extension/manifest.json:4` (`"version": "1.0.7"` → `"version": "1.0.8"`)
- Test: `tests/background.test.js` (new, 5 source-level tests)

**Interfaces:**
- Consumes: existing `extension/background.js` symbols `BACKEND_TIMEOUT_MS = 12 * 60 * 1000` (must stay byte-identical — it governs format/translate/save, not transcript), `TRANSCRIPT_TIMEOUT_MS`, and the `AbortError` branch of `handleStart` where `timedOut` is true.
- Produces:
  - `TRANSCRIPT_TIMEOUT_MS = 120 * 60 * 1000` with the trailing comment `// 120 minutes — safe only because the keepalive lane keeps the worker alive`.
  - `function formatTimeoutMessage(ms)` returning `Request timed out after <Math.round(ms / 60000)> minutes.`
  - The abort message `formatTimeoutMessage(TRANSCRIPT_TIMEOUT_MS)` — no literal duration string remains anywhere in `extension/background.js`.
  - `extension/manifest.json` version `1.0.8` (the third and last version location after `backend/main.py` in Task 4 and `extension/popup.html` in Task 5).
  - `tests/background.test.js`, which reads `extension/background.js` as text and asserts all five facts above.
- Cross-lane dependencies: none. `extension/background.js` is not loadable by the popup VM harness (it registers listeners on load), which is why this task's tests are static; this lane touches no backend file.

- [ ] **Step 1: Create the failing `tests/background.test.js`**

Create `tests/background.test.js` with exactly this content. It is a source-level test because `extension/background.js` cannot be evaluated in the popup VM harness:

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

- [ ] **Step 2: Run the new test file and observe the red state**

Run: `node --test tests/background.test.js`
Expected: FAIL — **1 passed, 4 failed**. The `BACKEND_TIMEOUT_MS` assertion passes (that constant is unchanged and must stay that way); the four failing assertions are the 120-minute constant, the `formatTimeoutMessage` helper, the helper call site, and the absence of a hard-coded duration. This proves the test is real.

- [ ] **Step 3: Change the constant and add the helper**

Replace:

```javascript
const TRANSCRIPT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
```

with:

```javascript
const TRANSCRIPT_TIMEOUT_MS = 120 * 60 * 1000; // 120 minutes — safe only because the keepalive lane keeps the worker alive

function formatTimeoutMessage(ms) {
  return `Request timed out after ${Math.round(ms / 60000)} minutes.`;
}
```

Do not touch the preceding `const BACKEND_TIMEOUT_MS = 12 * 60 * 1000;`.

- [ ] **Step 4: Use the helper in the `AbortError` branch**

Replace:

```javascript
    if (e.name === 'AbortError') {
      const errorMsg = timedOut
        ? "Request timed out after 15 minutes."
        : 'Stopped by user.';
```

with:

```javascript
    if (e.name === 'AbortError') {
      const errorMsg = timedOut
        ? formatTimeoutMessage(TRANSCRIPT_TIMEOUT_MS)
        : 'Stopped by user.';
```

- [ ] **Step 5: Bump the manifest version**

Replace `"version": "1.0.7",` in `extension/manifest.json` with:

```json
  "version": "1.0.8",
```

Do not change `permissions` or `host_permissions`; the only manifest change is the version string.

- [ ] **Step 6: Run the tests and observe them pass**

Run: `node --test tests/background.test.js`
Expected: PASS — **5 passed**. No test may be skipped.

Run: `node --test tests/*.test.js`
Expected: PASS — **69 passed** (30 in `tests/popup.test.js` + 34 in `tests/filebridge.test.js` + 5 in `tests/background.test.js`). This is the extension-lane acceptance command and the whole-suite command for this lane.

- [ ] **Step 7: Reviewer validation (non-mutating) and commit**

Run: `node --test tests/background.test.js`
Expected: 5 passed.

Run: `grep -c 'after [0-9][0-9]* minutes' extension/background.js`
Expected: `0` — no literal duration remains in the abort message.

Run: `grep -c minutes extension/background.js`
Expected: `2` — the `// 120 minutes — ...` rationale comment and the `minutes.`
template inside `formatTimeoutMessage`. Any other count means a literal duration survived.

```bash
git add extension/background.js extension/manifest.json tests/background.test.js
git commit -m "feat(extension): raise the transcript timeout to 120 minutes"
```

## Task 7: AGENTS.md and README.md local-file documentation

**Implementer tier:** Economy

**Lane:** docs

**Depends on:** none

**Files:**
- Modify: `AGENTS.md:19-21` (backend tree gains `local_file.py`)
- Modify: `AGENTS.md:95` (endpoint flow note after step 8)
- Modify: `AGENTS.md:106-109` (config block gains `local_files`) and the config bullet list (add one bullet after the `Cache uses SQLite…` bullet at `:115`)
- Modify: `AGENTS.md:136` (popup UI design gains the chip bullet)
- Modify: `AGENTS.md:147` (conventions gain the ffmpeg/ffprobe bullet)
- Modify: `README.md:25` (prerequisites line)
- Modify: `README.md:95-102` (usage section gains a "Local video files" subsection)
- Modify: `README.md:62-65` (config example gains the optional `local_files` block)
- Modify: `README.md:166-167` (architecture tree gains `local_file.py`)

**Interfaces:**
- Consumes: nothing executable. Every edit is a literal old-text → new-text replacement against the base commit; no code, no test, and no runtime interface is involved.
- Produces: the documented local-file contract — the backend tree entry, the pipeline note, the `local_files` config block and bullet, the popup chip bullet, the ffmpeg/ffprobe convention, the prerequisites line, the "Local video files" usage subsection, and the README architecture-tree entry.
- Cross-lane dependencies: none — the deltas are literal prose and need no artifact from the `backend` or `extension` lanes; same-lane ordering is expressed by plan order (Task 8 follows).

- [ ] **Step 1: Add `local_file.py` to the AGENTS.md backend tree**

Replace:

```text
backend/                 ← FastAPI backend (transcript extraction only)
  main.py                ← FastAPI app with /transcript and /health endpoints
  config.yaml            ← live config (GITIGNORED)
```

with:

```text
backend/                 ← FastAPI backend (transcript extraction only)
  main.py                ← FastAPI app with /transcript and /health endpoints
  local_file.py          ← local-file pipeline (classification, sidecars, embedded subtitles, ffmpeg audio extraction)
  config.yaml            ← live config (GITIGNORED)
```

- [ ] **Step 2: Document the local pipeline in the AGENTS.md endpoint flow**

Replace:

```text
8. Send to OpenAI `/v1/audio/transcriptions`, cache, return.
```

with:

```text
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

- [ ] **Step 3: Add the `local_files` block to the AGENTS.md config example**

Replace:

```yaml
cache:
  enabled: true
  ttl_days: 30
debug: false
```

with:

```yaml
cache:
  enabled: true
  ttl_days: 30
local_files:
  allowed_roots: []   # empty = unrestricted; non-empty restricts reads to these resolved absolute paths
debug: false
```

Then insert this bullet immediately after the line `- Cache uses SQLite with WAL mode, proactive expiry (on read, write, startup, daily 8 PM).`:

```text
- `local_files.allowed_roots` restricts which local paths the backend may read (empty = unrestricted). Entries must be absolute (or `~`); relative entries are a startup error.
```

- [ ] **Step 4: Document the popup source chip in AGENTS.md**

Replace:

```text
- Status bars on all tabs showing progress.
```

with:

```text
- Status bars on all tabs showing progress.
- A display-only source chip under the URL input shows `Local file · <name>` or `Web URL · <host>` (hidden for unrecognised input); it never changes what is sent to the background.
```

- [ ] **Step 5: Document the ffmpeg requirement in AGENTS.md conventions**

Replace:

```text
- yt-dlp must be installed on the system.
```

with:

```text
- yt-dlp must be installed on the system.
- ffmpeg and ffprobe must be installed for local-file transcription; the backend returns 500 `ffmpeg is not installed.` when they are missing.
```

- [ ] **Step 6: Update the README prerequisites**

Replace:

```text
- ffmpeg (for audio splitting on long videos)
```

with:

```text
- ffmpeg (for audio splitting on long videos and local-file audio extraction)
```

- [ ] **Step 7: Add the README "Local video files" usage subsection**

Replace:

```text
### Transcript tab

1. Navigate to a video page (YouTube, Vimeo, etc.)
2. Click the YT2TXT icon — the current page URL is pre-filled
3. Optionally check **Force refresh** to bypass cache
4. Click **Get Transcript**
5. Copy or download the result
```

with:

```text
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

- [ ] **Step 8: Add the optional `local_files` block to the README config example**

Replace:

```yaml
cache:
  enabled: true
  ttl_days: 30
```

with:

```yaml
cache:
  enabled: true
  ttl_days: 30

# Optional: restrict which local paths the backend may read.
# Empty (the default) means unrestricted.
local_files:
  allowed_roots: []
```

- [ ] **Step 9: Add `local_file.py` to the README architecture tree**

Replace:

```text
backend/              ← FastAPI backend
  main.py             ← FastAPI app with /transcript and /health
```

with:

```text
backend/              ← FastAPI backend
  main.py             ← FastAPI app with /transcript and /health
  local_file.py       ← local-file pipeline (classification, subtitles, ffmpeg)
```

- [ ] **Step 10: Reviewer validation (non-mutating) and commit**

Run: `grep -n local_file.py AGENTS.md README.md`
Expected: one `local_file.py` tree line in each file.

Run: `grep -n allowed_roots AGENTS.md README.md`
Expected: a `local_files:` block with `allowed_roots: []` in each file, plus the AGENTS.md bullet.

Run: `grep -c '^### Local video files' README.md`
Expected: `1` — the new subsection heading. (A bare `grep -c Local README.md` counts 2,
because the prescribed chip example line also contains the word `Local`.)

```bash
git add AGENTS.md README.md
git commit -m "docs: document local-file transcription in AGENTS.md and README.md"
```

## Task 8: ARCHITECTURE.md local-file section and init-flow deltas

**Implementer tier:** Fast

**Lane:** docs

**Depends on:** none

**Files:**
- Modify: `ARCHITECTURE.md:226-232` (insert a new §2.6 between the §2.5 "New files needed" list and `## 3. State Management`)
- Modify: `ARCHITECTURE.md:703` (§10 init flow step 3)
- Modify: `ARCHITECTURE.md:705` (§10 init flow step 5)

**Interfaces:**
- Consumes: nothing executable. Every edit is a literal old-text → new-text replacement against the base commit.
- Produces: the documented `backend/local_file.py` pipeline (classification table, path validation, one ffprobe, subtitle cascade, audio extraction, `local:<path_hash>:<content_hash>` caching) and the two popup init-flow deltas. The inserted §2.6 text contains a nested fenced code block, so the block below is wrapped in a four-backtick fence exactly as the replacement text must be written.
- Cross-lane dependencies: none — the deltas are literal prose and need no artifact from the `backend` or `extension` lanes. This is the docs lane's last task, so its commit completes the lane.

- [ ] **Step 1: Insert the new §2.6 local-file section**

Replace:

````text
**New files needed:**
- `extension/offscreen.html` — minimal HTML loading offscreen.js
- `extension/offscreen.js` — clipboard handler (exact copy from TextKit)

---

## 3. State Management
````

with (the inserted section is the only addition; `## 3. State Management` and the surrounding context are preserved verbatim, and the inner fence uses three backticks):

````text
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

- [ ] **Step 2: Update the §10 init flow step 3**

Replace:

```text
  3. Pre-fill URL from current tab (existing)
```

with:

```text
  3. Pre-fill URL from current tab (existing) and update the source chip
```

- [ ] **Step 3: Update the §10 init flow step 5**

Replace:

```text
  5. Load persisted transcript result (existing)
```

with:

```text
  5. Load persisted transcript result (existing; local raw paths match a file:// tab URL via sourceKey equivalence)
```

- [ ] **Step 4: Reviewer validation (non-mutating) and commit**

Run: `grep -n local_file ARCHITECTURE.md`
Expected: matches in the new §2.6 (the module name appears several times).

Run: `grep -n sourceKey ARCHITECTURE.md`
Expected: one match in §10 step 5.

Run: `grep -c -F 2.6 ARCHITECTURE.md`
Expected: `1` — the inserted 2.6 section heading (the literal token does not appear in the file before this change).

The `docs` lane owns no test suite, so this task has no whole-suite command of its own: the backend-lane acceptance run is `/data/home/henry-arch/anaconda3/envs/daily/bin/python -m pytest tests/ -q` (144 passed, Task 4) and the extension-lane acceptance run is `node --test tests/*.test.js` (69 passed, Task 6). Do not treat the pre-lane baseline (55 or 52) as a failure of this task when the lanes run concurrently; this task changes no code.

```bash
git add ARCHITECTURE.md
git commit -m "docs: document the local-file pipeline in ARCHITECTURE.md"
```
