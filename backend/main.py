"""FastAPI backend: extract transcripts from YouTube/yt-dlp-supported sites.

Two paths:
1. Video has native subtitles → download directly via yt-dlp.
2. No subtitles → download audio via yt-dlp, transcribe via OpenAI API.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shlex
import shutil
import signal
import sqlite3
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
import yaml
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

# ── Config ──────────────────────────────────────────────────────

CONFIG_PATH = Path(__file__).with_name("config.yaml")
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8666
DEFAULT_MODEL = "gpt-4o-transcribe"
PRODUCTION = not os.environ.get("FLASK_DEBUG")


def _load_yaml_config(path: Path = CONFIG_PATH) -> dict[str, Any]:
    """Load config.yaml if it exists, otherwise return empty dict."""
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as f:
        loaded = yaml.safe_load(f) or {}
    if not isinstance(loaded, dict):
        raise RuntimeError("config.yaml must contain a YAML mapping at the top level")
    return loaded


@dataclass(frozen=True)
class AppConfig:
    """Application settings loaded from YAML and environment variables."""

    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    debug: bool = False
    api_base: str = "https://api.openai.com/v1"
    api_key: str = ""
    model: str = DEFAULT_MODEL
    cache_enabled: bool = True
    cache_ttl_days: int = 30


def load_config() -> AppConfig:
    """Load configuration from config.yaml with env-var fallbacks."""
    raw = _load_yaml_config()

    ai_section = raw.get("ai") or {}
    if not isinstance(ai_section, dict):
        ai_section = {}

    # Resolve API key: $VAR reference → env var → OPENAI_API_KEY fallback
    api_key = ""
    raw_key = ai_section.get("api_key", "")
    if isinstance(raw_key, str) and raw_key:
        if raw_key.startswith("$"):
            api_key = os.getenv(raw_key[1:], "")
        else:
            api_key = raw_key
    if not api_key:
        api_key = os.getenv("OPENAI_API_KEY", "")

    # Normalize api_base: auto-append /v1 if not present
    api_base = str(ai_section.get("api_base", "https://api.openai.com"))
    if not api_base.rstrip("/").endswith("/v1"):
        api_base = api_base.rstrip("/") + "/v1"

    cache_section = raw.get("cache") or {}
    if not isinstance(cache_section, dict):
        cache_section = {}

    return AppConfig(
        host=str(raw.get("host", DEFAULT_HOST)),
        port=int(raw.get("port", DEFAULT_PORT)),
        debug=bool(raw.get("debug", False)),
        api_base=api_base,
        api_key=api_key,
        model=str(ai_section.get("model", DEFAULT_MODEL)),
        cache_enabled=bool(cache_section.get("enabled", True)),
        cache_ttl_days=int(cache_section.get("ttl_days", 30)),
    )


# ── App setup ───────────────────────────────────────────────────

app = FastAPI(title="YT2TXT", version="0.0.19")


# ── Request logging ─────────────────────────────────────────────

@app.middleware("http")
async def _log_requests(request: Request, call_next: Any) -> Response:
    req_id = os.urandom(4).hex()
    start = time.monotonic()
    try:
        response = await call_next(request)
    except Exception:
        elapsed = time.monotonic() - start
        _debug(
            "req",
            f"[{req_id}] {request.method} {request.url.path} → 500 ({elapsed:.3f}s)",
        )
        raise
    elapsed = time.monotonic() - start
    _debug(
        "req",
        f"[{req_id}] {request.method} {request.url.path} → {response.status_code} ({elapsed:.3f}s)",
    )
    # Prevent TCP connection reuse issues with Chrome extensions
    response.headers["Connection"] = "close"
    return response


def _debug(tag: str, msg: str) -> None:
    """Print a timestamped debug message when debug mode is enabled."""
    config = load_config()
    if not config.debug:
        return
    from datetime import datetime, timezone

    ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
    print(f"[DEBUG][{tag}] {ts} {msg}", file=sys.stderr, flush=True)


def _error_message(exc: Exception, is_client_error: bool = False) -> str:
    """Return a safe error message for the client."""
    if is_client_error:
        return str(exc)
    if PRODUCTION:
        return "Request failed. Check server logs for details."
    return str(exc)


# ── Graceful shutdown ───────────────────────────────────────────


def _handle_shutdown(signum: int, frame: Any) -> None:
    _debug("signal", f"Received {signal.Signals(signum).name} — shutting down.")
    sys.exit(0)


signal.signal(signal.SIGTERM, _handle_shutdown)
signal.signal(signal.SIGINT, _handle_shutdown)


# ── Models ──────────────────────────────────────────────────────


class TranscriptRequest(BaseModel):
    url: str
    model: str | None = None
    language: str = ""
    force: bool = False


class TranscriptResponse(BaseModel):
    text: str = ""
    source: str = ""  # "subtitles" or "transcription"
    model: str = ""
    error: str | None = None


# ── YT-DLP helpers ──────────────────────────────────────────────

YT_DLP = shutil.which("yt-dlp") or "yt-dlp"


async def _run_ytdlp(args: list[str], timeout: float = 180) -> str:
    """Run yt-dlp and return stdout. Kills process on timeout. Raises on failure."""
    cmd = [YT_DLP, *args]
    _debug("ytdlp", f"Running: {shlex.join(cmd)}")
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError:
        raise HTTPException(
            status_code=500,
            detail="yt-dlp is not installed. Install it with: pip install yt-dlp",
        )

    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        try:
            await asyncio.wait_for(proc.wait(), timeout=10)
        except asyncio.TimeoutError:
            pass
        raise HTTPException(
            status_code=504,
            detail=f"yt-dlp timed out after {timeout}s",
        )

    if proc.returncode != 0:
        err = stderr.decode("utf-8", errors="replace").strip()
        detail = err[:500] if not PRODUCTION else "yt-dlp failed to process the URL"
        raise HTTPException(status_code=500, detail=detail)

    return stdout.decode("utf-8", errors="replace")


def _find_subtitle_file(tmpdir: str, video_id: str) -> str | None:
    """Find a .srt or .vtt subtitle file for the given video ID."""
    extensions = [".srt", ".vtt", ".en.srt", ".en.vtt"]
    for ext in extensions:
        candidate = os.path.join(tmpdir, f"{video_id}{ext}")
        if os.path.isfile(candidate):
            return candidate
    # Search for any .srt/.vtt in the temp dir
    for fname in os.listdir(tmpdir):
        if fname.endswith((".srt", ".vtt")):
            return os.path.join(tmpdir, fname)
    return None


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

    # Remove sequence numbers (SRT)
    content = re.sub(r"^\d+\s*$", "", content, flags=re.M)

    # Remove <c> / </c> and other inline tags
    content = re.sub(r"<[^>]+>", "", content)

    # Collapse blank lines
    lines = [line.strip() for line in content.splitlines() if line.strip()]
    return "\n".join(lines)


def _parse_subtitle_langs(list_subs_output: str) -> tuple[set[str], set[str]]:
    """Parse yt-dlp --list-subs output into (manual_langs, auto_langs).

    manual_langs: simple codes like {"en", "de", "zh"}
    auto_langs: compound codes like {"en-en", "zh-Hans-en", "fr-en"}

    yt-dlp format:
        [info] Available subtitles for VIDEOID:
        Language Name    Formats
        en       English vtt, srt, ttml...

        [info] Available automatic captions for VIDEOID:
        Language   Name                    Formats
        en-en      English from English    vtt, srt, ttml...
        zh-Hans-en Chinese (Simplified) from English  vtt, srt, ttml...
    """
    import re

    manual: set[str] = set()
    auto: set[str] = set()
    section: str | None = None
    # Match simple codes (en, de) and compound codes (en-en, zh-Hans-en).
    code_re = re.compile(r"^\s*([A-Za-z]{2,3}(?:-[A-Za-z]{2,4}){0,3})(?:\s|$)")

    for raw_line in list_subs_output.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if "Available subtitles" in line:
            section = "manual"
            continue
        if "Available automatic captions" in line:
            section = "auto"
            continue
        # Skip the column header line that follows each section banner.
        if line.lower().startswith("language"):
            continue
        if section is None:
            continue
        m = code_re.match(raw_line)
        if not m:
            continue
        code = m.group(1)
        if section == "manual":
            manual.add(code)
        else:
            auto.add(code)

    return manual, auto


def _resolve_auto_lang(lang: str, auto_langs: set[str]) -> str | None:
    """Resolve a simple language code (e.g. "en") to a compound auto-subs code.

    yt-dlp --write-auto-subs requires compound codes (en-en, zh-Hans-en) but
    users normally think in simple codes. Match by checking which auto code
    starts with "<lang>-". Returns the matched compound code, or None.
    """
    if not lang:
        return None
    prefix = f"{lang}-"
    for code in auto_langs:
        if code.startswith(prefix):
            return code
    return None


def _resolve_subs_path(tmpdir: str, url: str) -> str | None:
    """Return the first .srt/.vtt path written into tmpdir, or None."""
    for fname in os.listdir(tmpdir):
        if not fname.endswith((".srt", ".vtt")):
            continue
        full = os.path.join(tmpdir, fname)
        if os.path.isfile(full):
            return full
    return None


async def _download_subs_manual(
    url: str, lang: str | None, tmpdir: str
) -> str | None:
    """Try to download manual subtitles. Returns .srt/.vtt path or None.

    lang: simple code (e.g. "en"), "all", "" for yt-dlp default, or None.
    """
    args: list[str] = [
        "--write-subs",
        "--no-write-auto-subs",
        "--skip-download",
        "--convert-subs",
        "srt",
    ]
    if lang:
        # yt-dlp accepts "all" or comma-separated simple codes here.
        args += ["--sub-langs", lang]
    args += ["-o", os.path.join(tmpdir, "%(id)s.%(ext)s"), url]
    try:
        await _run_ytdlp(args, timeout=300)
    except HTTPException as exc:
        _debug("subs", f"manual download failed: {exc.detail}")
        return None
    return _resolve_subs_path(tmpdir, url)


async def _download_subs_auto(
    url: str,
    lang: str | None,
    tmpdir: str,
    auto_langs: set[str] | None = None,
) -> str | None:
    """Try to download auto-generated captions. Returns .srt/.vtt path or None.

    lang: simple code (e.g. "en"), "" for yt-dlp default, or None.
    When auto_langs is provided and lang is set, the simple code is resolved to
    the matching compound code required by yt-dlp --write-auto-subs.
    """
    args: list[str] = [
        "--write-auto-subs",
        "--no-write-subs",
        "--skip-download",
        "--convert-subs",
        "srt",
    ]
    sub_langs: str | None = None
    if lang:
        compound = _resolve_auto_lang(lang, auto_langs) if auto_langs else None
        if compound:
            sub_langs = compound
        else:
            # Best-effort fallback: pass the simple code anyway. yt-dlp will
            # error and we will return None to the caller.
            sub_langs = lang
    if sub_langs:
        args += ["--sub-langs", sub_langs]
    args += ["-o", os.path.join(tmpdir, "%(id)s.%(ext)s"), url]
    try:
        await _run_ytdlp(args, timeout=300)
    except HTTPException as exc:
        _debug("subs", f"auto download failed: {exc.detail}")
        return None
    return _resolve_subs_path(tmpdir, url)


# ── OpenAI transcription ────────────────────────────────────────


MAX_AUDIO_BYTES = 24 * 1024 * 1024  # OpenAI 25MB limit, leave 1MB for multipart overhead
MAX_AUDIO_DURATION = 1300          # seconds — under OpenAI's 1400s limit per request
CHUNK_DURATION_SECONDS = 20 * 60   # ~20 minutes per chunk at 64kbps ≈ 10MB
CHUNK_OVERLAP_SECONDS = 10         # overlap between chunks to avoid word-boundary cuts

AUDIO_BITRATE_BPS = 64_000         # matches yt-dlp --postprocessor-args 64k


def _estimate_duration(file_size: int) -> float:
    """Estimate audio duration from file size and configured bitrate."""
    return (file_size * 8) / AUDIO_BITRATE_BPS  # bits / bps = seconds


async def _get_audio_duration(audio_path: str) -> float:
    """Get actual audio duration in seconds using ffprobe. Falls back to estimate."""
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return _estimate_duration(os.path.getsize(audio_path))
    try:
        proc = await asyncio.create_subprocess_exec(
            ffprobe,
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "csv=p=0",
            audio_path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
        if proc.returncode == 0 and stdout.strip():
            return float(stdout.decode().strip())
    except Exception:
        pass
    return _estimate_duration(os.path.getsize(audio_path))


async def _transcribe_file(
    audio_path: str, config: AppConfig, model: str, chunk_label: str = ""
) -> str:
    """Send a single audio file to OpenAI /v1/audio/transcriptions and return text."""
    if not config.api_key:
        raise HTTPException(
            status_code=500,
            detail="No API key configured. Set OPENAI_API_KEY or ai.api_key in config.yaml.",
        )

    url = f"{config.api_base}/audio/transcriptions"

    with open(audio_path, "rb") as f:
        audio_data = f.read()

    filename = os.path.basename(audio_path)

    boundary = os.urandom(16).hex()
    body = b""
    for field_name, field_value in [
        ("model", model),
        ("response_format", "text"),
    ]:
        body += f"--{boundary}\r\n".encode()
        body += (
            f'Content-Disposition: form-data; name="{field_name}"\r\n\r\n'.encode()
        )
        body += f"{field_value}\r\n".encode()

    body += f"--{boundary}\r\n".encode()
    body += f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'.encode()
    body += f"Content-Type: audio/mpeg\r\n\r\n".encode()
    body += audio_data
    body += f"\r\n--{boundary}--\r\n".encode()

    headers = {
        "Authorization": f"Bearer {config.api_key}",
        "Content-Type": f"multipart/form-data; boundary={boundary}",
    }

    deadline = 300  # 5 min per chunk

    last_exc: Exception | None = None
    for attempt in (1, 2):
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(connect=10.0, read=deadline, write=60.0, pool=10.0)
            ) as client:
                response = await asyncio.wait_for(
                    client.post(url, headers=headers, content=body),
                    timeout=deadline,
                )
        except asyncio.TimeoutError:
            raise HTTPException(
                status_code=504,
                detail=f"Transcription API did not respond within {deadline}s",
            )
        except httpx.ConnectError as exc:
            last_exc = HTTPException(
                status_code=502,
                detail=f"Transcription API connection failed: {exc}",
            )
        except httpx.RequestError as exc:
            raise HTTPException(
                status_code=502,
                detail=f"Transcription API request failed: {type(exc).__name__}: {exc}",
            ) from exc
        else:
            if response.is_error:
                detail = response.text
                if len(detail) > 500:
                    detail = detail[:500] + "..."
                raise HTTPException(
                    status_code=502,
                    detail=f"Transcription API failed: {detail}",
                )
            text = response.text.strip()
            label = f" ({chunk_label})" if chunk_label else ""
            _debug("transcribe", f"Got {len(text)} chars of transcription{label}")
            return text

        if attempt == 1:
            await asyncio.sleep(1)

    assert last_exc is not None
    raise last_exc


def _deduplicate_overlap(text_a: str, text_b: str, max_overlap: int = 300) -> str:
    """Remove overlapping text at the boundary between two chunk transcriptions.

    When chunks overlap in audio, adjacent transcriptions contain duplicate
    text at the boundary.  Finds the longest suffix of *text_a* that also
    appears as a prefix of *text_b* and returns *text_b* with the overlap
    trimmed.  If no overlap is detected the original text is returned.

    *max_overlap* is the maximum number of characters to compare (controls
    how aggressively we search for overlaps).
    """
    if not text_a or not text_b:
        return text_b
    suffix = text_a[-max_overlap:]
    prefix = text_b[:max_overlap * 2]
    for i in range(len(suffix)):
        candidate = suffix[i:]
        if len(candidate) < 5:  # too short to be a meaningful overlap
            break
        if prefix.startswith(candidate):
            trimmed = text_b[len(candidate):]
            _debug(
                "chunk",
                f"Dedup overlap: removed {len(candidate)} chars "
                f"('{candidate[:50]}...')",
            )
            return trimmed
    return text_b


async def _transcribe_audio(
    audio_path: str, config: AppConfig, model: str
) -> str:
    """Transcribe audio, chunking if file exceeds OpenAI's 25MB limit or 1400s duration.

    If the file is ≤24MB and ≤1300s, transcribes directly.
    Otherwise splits with ffmpeg into chunks, transcribes each, and joins.
    """
    file_size = os.path.getsize(audio_path)
    duration = await _get_audio_duration(audio_path)

    if file_size <= MAX_AUDIO_BYTES and duration <= MAX_AUDIO_DURATION:
        _debug("transcribe", f"File {file_size / 1024 / 1024:.1f}MB, {duration:.0f}s — direct")
        return await _transcribe_file(audio_path, config, model)

    reason = "size" if file_size > MAX_AUDIO_BYTES else "duration"
    _debug(
        "transcribe",
        f"File {file_size / 1024 / 1024:.1f}MB, {duration:.0f}s — splitting ({reason})",
    )

    ffmpeg = shutil.which("ffmpeg") or "ffmpeg"
    chunks_dir = os.path.join(os.path.dirname(audio_path), "chunks")
    os.makedirs(chunks_dir, exist_ok=True)

    # Split into overlapping chunks so no word is cut at a boundary.
    # Each chunk covers CHUNK_DURATION_SECONDS of audio; adjacent chunks
    # share CHUNK_OVERLAP_SECONDS.  Transcription text is deduplicated
    # afterward to remove the repeated overlap region.
    num_chunks = max(2, int(duration // CHUNK_DURATION_SECONDS)
                     + (1 if duration % CHUNK_DURATION_SECONDS > 0 else 0))

    chunk_paths: list[str] = []
    for i in range(num_chunks):
        start = max(0.0, i * CHUNK_DURATION_SECONDS
                    - (CHUNK_OVERLAP_SECONDS if i > 0 else 0))
        is_last = (i == num_chunks - 1)
        # ffprobe duration can be slightly shorter than the actual file
        # (rounding, mp3 frame padding).  For the last chunk, omit -to so
        # ffmpeg copies to the true EOF instead of stopping at `duration`.
        ffmpeg_args: list[str] = [
            ffmpeg,
            "-y",
            "-i", audio_path,
            "-ss", str(start),
            "-c", "copy",
        ]
        if not is_last:
            end = min(duration,
                      (i + 1) * CHUNK_DURATION_SECONDS + CHUNK_OVERLAP_SECONDS)
            ffmpeg_args += ["-to", str(end)]
        chunk_path = os.path.join(chunks_dir, f"chunk_{i:03d}.mp3")
        proc = await asyncio.create_subprocess_exec(
            *ffmpeg_args,
            chunk_path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            _stdout, _stderr = await asyncio.wait_for(
                proc.communicate(), timeout=60
            )
        except asyncio.TimeoutError:
            proc.kill()
            raise HTTPException(
                status_code=504,
                detail=f"Timed out creating chunk {i}",
            )
        if proc.returncode != 0:
            err = _stderr.decode("utf-8", errors="replace")[:300]
            raise HTTPException(
                status_code=500,
                detail=f"Failed to create chunk {i}: {err}",
            )
        chunk_paths.append(chunk_path)

    _debug(
        "transcribe",
        f"Split into {len(chunk_paths)} overlapping chunks "
        f"({CHUNK_OVERLAP_SECONDS}s overlap)",
    )

    texts: list[str] = []
    for i, chunk_path in enumerate(chunk_paths):
        _debug("transcribe", f"Transcribing chunk {i + 1}/{len(chunk_paths)}")
        text = await _transcribe_file(
            chunk_path, config, model, f"chunk {i + 1}/{len(chunk_paths)}"
        )
        texts.append(text)

    # Deduplicate overlap text at boundaries between adjacent chunks.
    joined = texts[0]
    for i in range(1, len(texts)):
        deduped = _deduplicate_overlap(texts[i - 1], texts[i])
        joined += "\n" + deduped
    _debug(
        "transcribe",
        f"Joined {len(chunk_paths)} chunks → {len(joined)} chars (deduped)",
    )
    return joined


# ── Transcript cache ──────────────────────────────────────────────

CACHE_DB_PATH = Path(__file__).with_name("transcript_cache.db")


def _get_cache_db() -> sqlite3.Connection:
    """Open (or create) the SQLite cache DB with WAL mode and required schema."""
    conn = sqlite3.connect(str(CACHE_DB_PATH), check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS transcript_cache (
            video_id    TEXT PRIMARY KEY,
            url         TEXT NOT NULL,
            text        TEXT NOT NULL,
            source      TEXT NOT NULL,
            model       TEXT NOT NULL,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_transcript_cache_created_at "
        "ON transcript_cache(created_at)"
    )
    conn.commit()
    return conn


async def _extract_video_id(url: str) -> str:
    """Extract a stable video identifier from a URL.

    1. Try yt-dlp --print id (authoritative for any supported site).
    2. Fall back to regex extraction for YouTube URLs.
    3. Fall back to a SHA-256 hash of the URL for opaque identifiers.
    """
    import re

    try:
        result = await _run_ytdlp(["--print", "id", url], timeout=15)
        video_id = result.strip()
        if video_id:
            return video_id
    except HTTPException as exc:
        _debug("cache", f"yt-dlp id lookup failed: {exc.detail}")

    yt_re = re.compile(
        r"(?:youtube\.com/watch\?v=|youtu\.be/|youtube\.com/embed/|"
        r"youtube\.com/shorts/)([A-Za-z0-9_-]{11})"
    )
    m = yt_re.search(url)
    if m:
        return m.group(1)

    return hashlib.sha256(url.encode("utf-8")).hexdigest()[:16]


def _cache_get(video_id: str, ttl_days: int) -> dict | None:
    """Return a cached transcript if present and within TTL, else None."""
    conn = _get_cache_db()
    try:
        cur = conn.execute(
            "SELECT text, source, model, created_at FROM transcript_cache "
            "WHERE video_id = ?",
            (video_id,),
        )
        row = cur.fetchone()
    finally:
        conn.close()

    if not row:
        return None

    text, source, model, created_at = row
    try:
        created_dt = datetime.fromisoformat(created_at)
    except ValueError:
        return None
    now = datetime.now(timezone.utc)
    # SQLite datetime('now') returns UTC when used unqualified, but treat
    # naive values as UTC defensively.
    if created_dt.tzinfo is None:
        created_dt = created_dt.replace(tzinfo=timezone.utc)
    if created_dt + timedelta(days=ttl_days) < now:
        return None

    return {"text": text, "source": source, "model": model}


def _cache_put(
    video_id: str,
    url: str,
    text: str,
    source: str,
    model: str,
    ttl_days: int,
) -> None:
    """Insert or replace a cached transcript and prune expired rows."""
    conn = _get_cache_db()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO transcript_cache "
            "(video_id, url, text, source, model, created_at) "
            "VALUES (?, ?, ?, ?, ?, datetime('now'))",
            (video_id, url, text, source, model),
        )
        conn.execute(
            "DELETE FROM transcript_cache "
            "WHERE datetime(created_at, '+' || ? || ' days') < datetime('now')",
            (ttl_days,),
        )
        conn.commit()
    finally:
        conn.close()


# ── Endpoints ───────────────────────────────────────────────────


@app.get("/health")
def health() -> Response:
    return JSONResponse({"status": "ok"})


@app.post("/transcript")
async def transcript(req: TranscriptRequest) -> dict[str, Any]:
    config = load_config()

    # ── Validate input ──────────────────────────────────────
    if not req.url or not isinstance(req.url, str) or not req.url.strip():
        raise HTTPException(status_code=400, detail="url is required")
    url = req.url.strip()

    model = req.model or config.model
    language = (req.language or "").strip()

    _debug("transcript", f"Processing: {url} [lang={language}]")

    # ── Cache lookup ─────────────────────────────────────────
    video_id: str | None = None
    if config.cache_enabled:
        video_id = await _extract_video_id(url)
        if not req.force:
            cached = _cache_get(video_id, config.cache_ttl_days)
            if cached:
                _debug("cache", f"hit video_id={video_id} source={cached['source']}")
                return {
                    "text": cached["text"],
                    "source": cached["source"],
                    "model": cached["model"],
                    "error": None,
                }
            _debug("cache", f"miss video_id={video_id}")
        else:
            _debug("cache", f"force refresh video_id={video_id}")

    # ── Try subtitles first ──────────────────────────────────
    with tempfile.TemporaryDirectory() as tmpdir:
        try:
            list_output = await _run_ytdlp(
                ["--list-subs", "--skip-download", url], timeout=60
            )
        except HTTPException:
            # If --list-subs fails, try downloading audio directly
            list_output = ""

        # Parse available subtitle languages (may be empty if --list-subs failed).
        manual_langs, auto_langs = _parse_subtitle_langs(list_output) if list_output else (set(), set())
        _debug(
            "subs",
            f"Available — manual: {sorted(manual_langs) or 'none'}, "
            f"auto: {sorted(auto_langs) or 'none'}",
        )

        # Resolve the requested language. Empty string = yt-dlp default
        # (video's original language); the helpers omit --sub-langs in that case.
        req_lang: str | None = language or None

        # If the user picked a specific language that isn't available in either
        # section, fall through to transcription. This avoids yt-dlp errors
        # for unavailable languages and gives a consistent fallback path.
        if req_lang and req_lang != "all":
            in_manual = req_lang in manual_langs
            in_auto = _resolve_auto_lang(req_lang, auto_langs) is not None
            if not (in_manual or in_auto):
                _debug(
                    "subs",
                    f"Requested language '{req_lang}' not available — falling back to transcription",
                )
                req_lang = None

        # Try manual subs first (preferred over auto-generated captions).
        sub_path: str | None = None
        # Manual attempt is worth running when:
        #   - the video has any manual track, OR
        #   - we have a specific language to filter by (lets yt-dlp try
        #     the requested manual language even if list-subs output was empty).
        try_manual = bool(manual_langs) or bool(req_lang)
        if try_manual:
            _debug("subs", f"Trying manual subs (lang={req_lang or 'default'})")
            sub_path = await _download_subs_manual(url, req_lang, tmpdir)

        # If manual didn't yield a file, try auto-generated captions
        # whenever auto subs are available for this video.
        if not sub_path and auto_langs:
            _debug("subs", f"Trying auto-generated subs (lang={req_lang or 'default'})")
            sub_path = await _download_subs_auto(url, req_lang, tmpdir, auto_langs)

        if sub_path and os.path.isfile(sub_path):
            text = _parse_subtitle_text(sub_path)
            _debug("transcript", f"Extracted {len(text)} chars from subtitles")
            if config.cache_enabled and video_id is not None:
                _cache_put(video_id, url, text, "subtitles", "yt-dlp", config.cache_ttl_days)
                _debug("cache", f"stored video_id={video_id} source=subtitles")
            return {
                "text": text,
                "source": "subtitles",
                "model": "yt-dlp",
                "error": None,
            }

        # No subtitles available (or extraction failed) — fall back to transcription.
        if list_output:
            _debug("transcript", "No usable subtitles — falling back to transcription")

        # ── Download audio and transcribe ────────────────────
        _debug("transcript", "Downloading audio for transcription")
        try:
            await _run_ytdlp(
                [
                    "-f",
                    "bestaudio",
                    "--extract-audio",
                    "--audio-format",
                    "mp3",
                    "--postprocessor-args",
                    "ffmpeg:-b:a 64k -ac 1",  # mono 64kbps — keeps under 25MB for ~50min
                    "-o",
                    os.path.join(tmpdir, "%(id)s.%(ext)s"),
                    url,
                ],
                timeout=600,
            )
        except HTTPException:
            raise

        # Find the downloaded audio file
        audio_path = None
        for fname in os.listdir(tmpdir):
            if fname.endswith(".mp3"):
                audio_path = os.path.join(tmpdir, fname)
                break

        if not audio_path:
            raise HTTPException(
                status_code=500,
                detail="Failed to download audio — no output file found.",
            )

        _debug("transcript", f"Transcribing audio: {audio_path} with model {model}")
        try:
            text = await _transcribe_audio(audio_path, config, model)
        except HTTPException:
            raise

        if config.cache_enabled and video_id is not None:
            _cache_put(video_id, url, text, "transcription", model, config.cache_ttl_days)
            _debug("cache", f"stored video_id={video_id} source=transcription")

        return {
            "text": text,
            "source": "transcription",
            "model": model,
            "error": None,
        }


# ── Run ─────────────────────────────────────────────────────────


if __name__ == "__main__":
    import uvicorn

    cfg = load_config()
    _debug("startup", f"Starting YT2TXT backend on {cfg.host}:{cfg.port}")
    uvicorn.run(app, host=cfg.host, port=cfg.port, log_level="info")
