"""FastAPI backend: extract transcripts from YouTube/yt-dlp-supported sites.

Two paths:
1. Video has native subtitles → download directly via yt-dlp.
2. No subtitles → download audio via yt-dlp, transcribe via OpenAI API.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import shlex
import shutil
import signal
import sqlite3
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from dataclasses import dataclass
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
PRODUCTION = not (
    os.environ.get("YT2TXT_DEBUG") or os.environ.get("FLASK_DEBUG")
)


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

    model = str(ai_section.get("model", DEFAULT_MODEL))

    return AppConfig(
        host=str(raw.get("host", DEFAULT_HOST)),
        port=int(raw.get("port", DEFAULT_PORT)),
        debug=bool(raw.get("debug", False)),
        api_base=api_base,
        api_key=api_key,
        model=model,
        cache_enabled=bool(cache_section.get("enabled", True)),
        cache_ttl_days=int(cache_section.get("ttl_days", 30)),
    )


# ── App setup ───────────────────────────────────────────────────

app = FastAPI(title="YT2TXT", version="1.0.0")


# ── Config (cached) ────────────────────────────────────────────────

_config_cache: AppConfig | None = None
_config_cache_ts: float = 0.0
_config_lock = asyncio.Lock()


async def get_config() -> AppConfig:
    """Return the current AppConfig, re-reading config.yaml at most every 60 s."""
    global _config_cache, _config_cache_ts
    now = time.monotonic()
    if _config_cache is not None and (now - _config_cache_ts) < 60:
        return _config_cache
    async with _config_lock:
        # Re-check — another coroutine may have refreshed while we waited.
        if _config_cache is not None and (now - _config_cache_ts) < 60:
            return _config_cache
        _config_cache = load_config()
        _config_cache_ts = time.monotonic()
    return _config_cache


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
    # Close after every response to avoid TCP connection reuse issues with
    # Chrome MV3 extensions. Chrome's extension fetch() may reuse a connection
    # whose keep-alive has already expired on the uvicorn side, causing
    # spurious "Connection reset" errors on subsequent requests.  Explicitly
    # closing forces a fresh TCP handshake each time and avoids this class of
    # flaky failures entirely.
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


def _resolve_subs_path(tmpdir: str, url: str) -> str | None:
    """Return the first .srt/.vtt path written into tmpdir, or None."""
    for fname in os.listdir(tmpdir):
        if not fname.endswith((".srt", ".vtt")):
            continue
        full = os.path.join(tmpdir, fname)
        if os.path.isfile(full):
            return full
    return None


async def _download_subs_manual(url: str, tmpdir: str) -> str | None:
    """Try to download manual subtitles. Returns .srt/.vtt path or None."""
    args: list[str] = [
        "--write-subs",
        "--no-write-auto-subs",
        "--skip-download",
        "--convert-subs",
        "srt",
        "-o",
        os.path.join(tmpdir, "%(id)s.%(ext)s"),
        url,
    ]
    try:
        await _run_ytdlp(args, timeout=300)
    except HTTPException as exc:
        _debug("subs", f"manual download failed: {exc.detail}")
        return None
    return _resolve_subs_path(tmpdir, url)


async def _download_subs_auto(url: str, tmpdir: str) -> str | None:
    """Try to download auto-generated captions. Returns .srt/.vtt path or None."""
    args: list[str] = [
        "--write-auto-subs",
        "--no-write-subs",
        "--skip-download",
        "--convert-subs",
        "srt",
        "-o",
        os.path.join(tmpdir, "%(id)s.%(ext)s"),
        url,
    ]
    try:
        await _run_ytdlp(args, timeout=300)
    except HTTPException as exc:
        _debug("subs", f"auto download failed: {exc.detail}")
        return None
    return _resolve_subs_path(tmpdir, url)


# ── OpenAI transcription ────────────────────────────────────────


MAX_AUDIO_BYTES = (
    24 * 1024 * 1024
)  # OpenAI 25MB limit, leave 1MB for multipart overhead
MAX_AUDIO_DURATION = 1300  # seconds — under OpenAI's 1400s limit per request
CHUNK_DURATION_SECONDS = 20 * 60  # ~20 minutes per chunk at 64kbps ≈ 10MB
CHUNK_OVERLAP_SECONDS = 10  # overlap between chunks to avoid word-boundary cuts

AUDIO_BITRATE_BPS = 64_000  # matches yt-dlp --postprocessor-args 64k


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
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "csv=p=0",
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

    file_size = os.path.getsize(audio_path)
    if file_size == 0:
        raise HTTPException(
            status_code=500,
            detail="Audio file is empty — nothing to transcribe.",
        )

    with open(audio_path, "rb") as f:
        audio_data = f.read()

    # Sanitize model name: strip CR/LF to prevent multipart header injection
    # when the value is interpolated into the raw multipart body below.
    safe_model = model.replace("\r", "").replace("\n", "")

    filename = os.path.basename(audio_path)

    boundary = os.urandom(16).hex()
    body = b""
    fields: list[tuple[str, str]] = [
        ("model", safe_model),
        ("response_format", "text"),
    ]
    for field_name, field_value in fields:
        body += f"--{boundary}\r\n".encode()
        body += f'Content-Disposition: form-data; name="{field_name}"\r\n\r\n'.encode()
        body += f"{field_value}\r\n".encode()

    body += f"--{boundary}\r\n".encode()
    body += f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'.encode()
    body += "Content-Type: audio/mpeg\r\n\r\n".encode()
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
                timeout=httpx.Timeout(
                    connect=10.0, read=deadline, write=60.0, pool=10.0
                )
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
                if PRODUCTION:
                    detail = "Transcription API returned an error"
                elif len(detail) > 500:
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

    if last_exc is None:
        raise RuntimeError(
            "Retry loop exhausted but no exception was captured — "
            "this should never happen."
        )
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
    prefix = text_b[: max_overlap * 2]
    for i in range(len(suffix)):
        candidate = suffix[i:]
        if len(candidate) < 5:  # too short to be a meaningful overlap
            break
        if prefix.startswith(candidate):
            trimmed = text_b[len(candidate) :]
            _debug(
                "chunk",
                f"Dedup overlap: removed {len(candidate)} chars "
                f"('{candidate[:50]}...')",
            )
            return trimmed
    return text_b


async def _transcribe_audio(audio_path: str, config: AppConfig, model: str) -> str:
    """Transcribe audio, chunking if file exceeds OpenAI's 25MB limit or 1400s duration.

    If the file is ≤24MB and ≤1300s, transcribes directly.
    Otherwise splits with ffmpeg into chunks, transcribes each, and joins.
    """
    file_size = os.path.getsize(audio_path)
    duration = await _get_audio_duration(audio_path)

    if file_size <= MAX_AUDIO_BYTES and duration <= MAX_AUDIO_DURATION:
        _debug(
            "transcribe",
            f"File {file_size / 1024 / 1024:.1f}MB, {duration:.0f}s — direct",
        )
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
    #
    # max(2, …) ensures we always produce at least two chunks when the
    # split path is taken.  A single-chunk split is pointless (the audio
    # is barely over the direct-transcription threshold), and the dedup
    # logic expects at least two adjacent chunks to work with.
    num_chunks = max(
        2,
        int(duration // CHUNK_DURATION_SECONDS)
        + (1 if duration % CHUNK_DURATION_SECONDS > 0 else 0),
    )

    chunk_paths: list[str] = []
    for i in range(num_chunks):
        start = max(
            0.0, i * CHUNK_DURATION_SECONDS - (CHUNK_OVERLAP_SECONDS if i > 0 else 0)
        )
        is_last = i == num_chunks - 1
        # ffprobe duration can be slightly shorter than the actual file
        # (rounding, mp3 frame padding).  For the last chunk, omit -to so
        # ffmpeg copies to the true EOF instead of stopping at `duration`.
        ffmpeg_args: list[str] = [
            ffmpeg,
            "-y",
            "-i",
            audio_path,
            "-ss",
            str(start),
            "-c",
            "copy",
        ]
        if not is_last:
            end = min(
                duration, (i + 1) * CHUNK_DURATION_SECONDS + CHUNK_OVERLAP_SECONDS
            )
            ffmpeg_args += ["-to", str(end)]
        chunk_path = os.path.join(chunks_dir, f"chunk_{i:03d}.mp3")
        proc = await asyncio.create_subprocess_exec(
            *ffmpeg_args,
            chunk_path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            _stdout, _stderr = await asyncio.wait_for(proc.communicate(), timeout=60)
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

    # Debug: save last chunk's audio and transcription for inspection.
    # Only when debug mode is enabled — prevents leaking transcript content
    # to /tmp in production and avoids concurrent-request file collisions.
    if config.debug:
        try:
            shutil.copy2(chunk_paths[-1], "/tmp/last_chunk_audio.mp3")
            _debug("transcribe", "Saved last chunk audio to /tmp/last_chunk_audio.mp3")
        except Exception as exc:
            import sys

            print(f"Failed to save last chunk audio: {exc}", file=sys.stderr)

        try:
            with open("/tmp/last_chunk_transcription.txt", "w") as f:
                f.write(texts[-1])
            _debug(
                "transcribe",
                "Saved last chunk transcription to /tmp/last_chunk_transcription.txt",
            )
        except Exception as exc:
            import sys

            print(f"Failed to save last chunk transcription: {exc}", file=sys.stderr)

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
            text        TEXT NOT NULL,
            source      TEXT NOT NULL,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        )
        """
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
    """Return a cached transcript if present and within TTL, else None.

    Expired rows are deleted immediately (not just ignored).
    """
    conn = _get_cache_db()
    try:
        cur = conn.execute(
            "SELECT text, source, created_at FROM transcript_cache "
            "WHERE video_id = ?",
            (video_id,),
        )
        row = cur.fetchone()
    finally:
        conn.close()

    if not row:
        return None

    text, source, created_at = row
    try:
        created_dt = datetime.strptime(created_at, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        # Corrupt timestamp — delete and treat as miss
        _cache_prune_video(video_id)
        return None
    now = datetime.now(timezone.utc)
    if created_dt.tzinfo is None:
        created_dt = created_dt.replace(tzinfo=timezone.utc)
    if created_dt + timedelta(days=ttl_days) < now:
        _cache_prune_video(video_id)
        return None

    return {"text": text, "source": source}


def _cache_prune_video(video_id: str) -> None:
    """Delete a single cache entry by video_id."""
    conn = _get_cache_db()
    try:
        conn.execute("DELETE FROM transcript_cache WHERE video_id = ?", (video_id,))
        conn.commit()
    finally:
        conn.close()


def _cache_prune_expired(ttl_days: int) -> int:
    """Delete all expired cache rows. Returns the number of rows removed."""
    conn = _get_cache_db()
    try:
        cur = conn.execute(
            "DELETE FROM transcript_cache "
            "WHERE datetime(created_at, '+' || ? || ' days') < datetime('now')",
            (ttl_days,),
        )
        conn.commit()
        return cur.rowcount
    finally:
        conn.close()


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


# ── Endpoints ───────────────────────────────────────────────────


@app.get("/health")
def health() -> Response:
    return JSONResponse({"status": "ok"})


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
        video_id = await _extract_video_id(url)
        if not req.force:
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
        else:
            _debug("cache", f"force refresh video_id={video_id}")

    # ── Try subtitles first ──────────────────────────────────
    with tempfile.TemporaryDirectory() as tmpdir:
        # Download ALL available subtitle languages (no language filter).
        sub_path: str | None = None
        sub_path = await _download_subs_manual(url, tmpdir)
        if not sub_path:
            sub_path = await _download_subs_auto(url, tmpdir)

        if sub_path and os.path.isfile(sub_path):
            text = _parse_subtitle_text(sub_path)
            _debug("transcript", f"Extracted {len(text)} chars from subtitles")
            if config.cache_enabled and video_id is not None:
                _cache_put(
                    video_id, text, "subtitles", config.cache_ttl_days
                )
                _debug("cache", f"stored video_id={video_id} source=subtitles")
            return {
                "text": text,
                "source": "subtitles",
                "model": "yt-dlp",
                "error": None,
            }

        # No subtitles available (or extraction failed) — fall back to transcription.
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
            _cache_put(
                video_id, text, "transcription", config.cache_ttl_days
            )
            _debug("cache", f"stored video_id={video_id} source=transcription")

        return {
            "text": text,
            "source": "transcription",
            "model": model,
            "error": None,
        }


# ── Startup cleanup ────────────────────────────────────────────

CACHE_CLEANUP_HOUR = 20  # 8 PM local time


async def _daily_cache_cleanup(ttl_days: int) -> None:
    """Run cache expiry cleanup once per day at CACHE_CLEANUP_HOUR (8 PM)."""
    while True:
        now = datetime.now()
        # Calculate seconds until the next 8 PM
        next_run = now.replace(hour=CACHE_CLEANUP_HOUR, minute=0, second=0, microsecond=0)
        if now >= next_run:
            next_run += timedelta(days=1)
        delay = (next_run - now).total_seconds()
        _debug("cache", f"Next daily cleanup at {next_run.strftime('%Y-%m-%d %H:%M:%S')} ({delay:.0f}s)")
        await asyncio.sleep(delay)

        removed = _cache_prune_expired(ttl_days)
        if removed:
            _debug("cache", f"Daily cleanup: removed {removed} expired cache row(s)")


@app.on_event("startup")
async def _startup_cleanup() -> None:
    """Prune expired cache rows on every server start, then schedule daily cleanup."""
    config = load_config()
    if not config.cache_enabled:
        return
    removed = _cache_prune_expired(config.cache_ttl_days)
    if removed:
        _debug("cache", f"Startup cleanup: removed {removed} expired cache row(s)")
    asyncio.create_task(_daily_cache_cleanup(config.cache_ttl_days))


# ── Run ─────────────────────────────────────────────────────────


if __name__ == "__main__":
    import uvicorn

    cfg = load_config()
    _debug("startup", f"Starting YT2TXT backend on {cfg.host}:{cfg.port}")
    uvicorn.run(app, host=cfg.host, port=cfg.port, log_level="info")
