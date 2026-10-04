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
DEFAULT_TIMEOUT_CONNECT = 10.0
DEFAULT_TIMEOUT_READ = 600.0
DEFAULT_TIMEOUT_WRITE = 60.0
DEFAULT_TIMEOUT_POOL = 10.0
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
class TimeoutConfig:
    """Per-phase AI provider timeouts, in seconds."""

    connect: float = DEFAULT_TIMEOUT_CONNECT
    read: float = DEFAULT_TIMEOUT_READ
    write: float = DEFAULT_TIMEOUT_WRITE
    pool: float = DEFAULT_TIMEOUT_POOL


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


TIMEOUT_RANGES: dict[str, tuple[float, float]] = {
    'connect': (0.0, 300.0),
    'read': (0.0, 3600.0),
    'write': (0.0, 600.0),
    'pool': (0.0, 300.0),
}


def _parse_timeout_config(raw_timeout: Any) -> TimeoutConfig:
    """Parse and validate ai.timeout section from YAML.

    Accepts a dict with optional numeric keys.  Missing keys get defaults.
    Values must be >0 and within allowed ranges (same as TextKit).
    Raises RuntimeError for invalid values.
    """
    if raw_timeout is None:
        return TimeoutConfig()
    if not isinstance(raw_timeout, dict):
        raise RuntimeError("ai.timeout must be a mapping")

    unknown = set(raw_timeout) - set(TIMEOUT_RANGES)
    if unknown:
        names = ", ".join(sorted(map(str, unknown)))
        raise RuntimeError(f"Unknown ai.timeout setting(s): {names}")

    values: dict[str, float] = {}
    for key, (low, high) in TIMEOUT_RANGES.items():
        if key not in raw_timeout:
            continue
        raw = raw_timeout[key]
        if isinstance(raw, bool):
            raise RuntimeError(f"ai.timeout.{key} must be a number, got bool")
        try:
            val = float(raw)
        except (TypeError, ValueError):
            raise RuntimeError(
                f'ai.timeout.{key} must be a number, got {type(raw).__name__}'
            ) from None
        if not (low < val <= high):
            raise RuntimeError(
                f'ai.timeout.{key} must be > {low} and <= {high}, got {val}'
            )
        values[key] = val

    return TimeoutConfig(
        connect=values.get('connect', DEFAULT_TIMEOUT_CONNECT),
        read=values.get('read', DEFAULT_TIMEOUT_READ),
        write=values.get('write', DEFAULT_TIMEOUT_WRITE),
        pool=values.get('pool', DEFAULT_TIMEOUT_POOL),
    )


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
    global _debug_enabled
    _debug_enabled = config.debug
    return config


# ── App setup ───────────────────────────────────────────────────

app = FastAPI(title="YT2TXT", version="1.0.6")


# ── Config (cached) ────────────────────────────────────────────────

_config_cache: AppConfig | None = None
_config_cache_ts: float = 0.0
_config_lock = asyncio.Lock()
_debug_enabled: bool = False


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
        global _debug_enabled
        _debug_enabled = _config_cache.debug
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
    if not _debug_enabled:
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


def _resolve_subs_path(tmpdir: str) -> str | None:
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
    return _resolve_subs_path(tmpdir)


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
    return _resolve_subs_path(tmpdir)


# ── OpenAI transcription ────────────────────────────────────────


MAX_AUDIO_BYTES = (
    24 * 1024 * 1024
)  # OpenAI 25MB limit, leave 1MB for multipart overhead
MAX_AUDIO_DURATION = 1300  # seconds — under OpenAI's 1400s limit per request
CHUNK_DURATION_SECONDS = 20 * 60  # ~20 minutes per span at 64kbps ≈ 10MB
CHUNK_OVERLAP_SECONDS = 10  # shared audio between adjacent spans
# ``gpt-4o-transcribe`` and ``gpt-4o-mini-transcribe`` silently stop at this
# many output tokens and still return HTTP 200, so any response reporting the
# cap is incomplete and its audio must be split further.
TRANSCRIBE_OUTPUT_TOKEN_CAP = 2048
MIN_SPAN_SECONDS = 30.0  # never recurse below this much audio
MAX_SPLIT_DEPTH = 10  # safety bound on recursive span bisection

AUDIO_BITRATE_BPS = 64_000  # matches yt-dlp --postprocessor-args 64k


@dataclass(frozen=True)
class TranscriptionResult:
    """One transcription response: the text plus the provider's token usage."""

    text: str
    output_tokens: int | None = None


def _hit_output_cap(result: TranscriptionResult) -> bool:
    """True when the provider reported hitting its output-token ceiling."""
    return (
        result.output_tokens is not None
        and result.output_tokens >= TRANSCRIBE_OUTPUT_TOKEN_CAP
    )


def _parse_transcription_response(response: httpx.Response) -> tuple[str, int | None]:
    """Extract transcript text and output-token usage from a response body.

    Requests use ``response_format=json`` so the provider reports ``usage``.
    Some OpenAI-compatible providers ignore that and return raw text, so fall
    back to the raw body in that case.
    """
    body = response.text
    try:
        payload = json.loads(body)
    except (json.JSONDecodeError, ValueError):
        return body.strip(), None
    if not isinstance(payload, dict):
        return body.strip(), None
    text = payload.get("text")
    if not isinstance(text, str):
        return body.strip(), None
    output_tokens: int | None = None
    usage = payload.get("usage")
    if isinstance(usage, dict):
        raw = usage.get("output_tokens")
        if isinstance(raw, int) and not isinstance(raw, bool):
            output_tokens = raw
    return text.strip(), output_tokens


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
) -> TranscriptionResult:
    """Send one audio file to /v1/audio/transcriptions.

    Returns the transcript together with the provider's output-token usage so
    callers can detect a silently truncated (cap-hitting) response.
    """
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
    # ``json`` (rather than ``text``) is required to receive ``usage`` and thus
    # detect providers that truncate the transcript at an output-token cap.
    fields: list[tuple[str, str]] = [
        ("model", safe_model),
        ("response_format", "json"),
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

    timeout_cfg = config.timeout
    deadline = timeout_cfg.read + 60  # buffer beyond read timeout

    last_exc: Exception | None = None
    for attempt in (1, 2):
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(
                    connect=timeout_cfg.connect,
                    read=timeout_cfg.read,
                    write=timeout_cfg.write,
                    pool=timeout_cfg.pool,
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
            text, output_tokens = _parse_transcription_response(response)
            label = f" ({chunk_label})" if chunk_label else ""
            usage_note = (
                f", {output_tokens} output tokens" if output_tokens is not None else ""
            )
            _debug(
                "transcribe",
                f"Got {len(text)} chars of transcription{label}{usage_note}",
            )
            return TranscriptionResult(text=text, output_tokens=output_tokens)

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


def _bisect_span(
    start: float, end: float
) -> tuple[tuple[float, float], tuple[float, float]]:
    """Split a span in half, leaving CHUNK_OVERLAP_SECONDS of shared audio."""
    mid = (start + end) / 2
    half_overlap = CHUNK_OVERLAP_SECONDS / 2
    left = (start, min(end, mid + half_overlap))
    right = (max(start, mid - half_overlap), end)
    return left, right


def _join_transcripts(texts: list[str]) -> str:
    """Join segment transcripts, removing duplicated overlap at each seam."""
    if not texts:
        return ""
    joined = texts[0]
    for i in range(1, len(texts)):
        joined += "\n" + _deduplicate_overlap(texts[i - 1], texts[i])
    return joined


async def _extract_segment(
    audio_path: str,
    start: float,
    end: float,
    out_path: str,
    ffmpeg: str,
    *,
    to_eof: bool,
) -> None:
    """Write audio[start:end] to *out_path* with ffmpeg stream copy.

    When *to_eof* is true the ``-to`` bound is omitted so ffmpeg copies to the
    true EOF.  ffprobe duration can be slightly shorter than the real file
    (rounding, mp3 frame padding), and clamping the final segment to it would
    silently drop the last fraction of a second of audio.
    """
    args: list[str] = [
        ffmpeg,
        "-y",
        "-i",
        audio_path,
        "-ss",
        str(start),
        "-c",
        "copy",
    ]
    if not to_eof:
        args += ["-to", str(end)]
    args.append(out_path)

    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        _stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=60)
    except asyncio.TimeoutError:
        proc.kill()
        raise HTTPException(
            status_code=504,
            detail=f"Timed out creating audio segment {start:.0f}-{end:.0f}s",
        )
    if proc.returncode != 0:
        err = stderr.decode("utf-8", errors="replace")[:300]
        raise HTTPException(
            status_code=500,
            detail=f"Failed to create audio segment: {err}",
        )


class _TranscriptionSession:
    """Transcribe one audio file, splitting spans that hit the provider cap.

    The file is covered by overlapping top-level spans of at most
    ``CHUNK_DURATION_SECONDS``.  Each span is one API request.  If the provider
    reports that the response reached its output-token cap (``gpt-4o-transcribe``
    truncates at :data:`TRANSCRIBE_OUTPUT_TOKEN_CAP`), the span is bisected with
    overlap and each half transcribed recursively.  The largest span known to be
    unsafe is remembered for the rest of the request so later spans start small
    instead of rediscovering the cap.
    """

    def __init__(
        self,
        audio_path: str,
        config: AppConfig,
        model: str,
        chunks_dir: str,
        duration: float,
    ) -> None:
        self.audio_path = audio_path
        self.config = config
        self.model = model
        self.chunks_dir = chunks_dir
        self.duration = duration
        self.ffmpeg = shutil.which("ffmpeg") or "ffmpeg"
        self.target_span = float(CHUNK_DURATION_SECONDS)
        self.segment_count = 0
        self.last_segment_path: str | None = None
        self.last_text = ""

    async def run(self) -> str:
        """Transcribe the whole file and return the deduplicated transcript."""
        texts: list[str] = []
        cursor = 0.0
        while cursor < self.duration:
            start = max(0.0, cursor - (CHUNK_OVERLAP_SECONDS if cursor > 0 else 0.0))
            end = min(self.duration, cursor + self.target_span)
            texts.append(await self._transcribe_span(start, end, depth=0))
            cursor = end
        return _join_transcripts(texts)

    async def _extract(self, start: float, end: float) -> str:
        self.segment_count += 1
        out_path = os.path.join(self.chunks_dir, f"chunk_{self.segment_count:03d}.mp3")
        await _extract_segment(
            self.audio_path,
            start,
            end,
            out_path,
            self.ffmpeg,
            to_eof=end >= self.duration - 1e-6,
        )
        return out_path

    async def _transcribe_span(self, start: float, end: float, depth: int) -> str:
        segment_path = await self._extract(start, end)
        label = f"span {start:.0f}-{end:.0f}s"
        result = await _transcribe_file(segment_path, self.config, self.model, label)
        self.last_segment_path = segment_path
        self.last_text = result.text

        if not _hit_output_cap(result):
            return result.text

        span = end - start
        if span <= MIN_SPAN_SECONDS or depth >= MAX_SPLIT_DEPTH:
            _debug(
                "transcribe",
                f"Span {start:.0f}-{end:.0f}s hit the "
                f"{TRANSCRIBE_OUTPUT_TOKEN_CAP}-token output cap and cannot be "
                "split further; returning a truncated transcript",
            )
            return result.text

        # Any span this large is unsafe for this provider, so shrink the working
        # span size and split the remaining top-level spans up front rather than
        # rediscovering the cap for every chunk.
        self.target_span = max(MIN_SPAN_SECONDS, min(self.target_span, span / 2))
        (left_start, left_end), (right_start, right_end) = _bisect_span(start, end)
        _debug(
            "transcribe",
            f"Span {start:.0f}-{end:.0f}s hit the "
            f"{TRANSCRIBE_OUTPUT_TOKEN_CAP}-token output cap — bisecting into "
            f"{left_start:.0f}-{left_end:.0f}s and {right_start:.0f}-{right_end:.0f}s",
        )
        left = await self._transcribe_span(left_start, left_end, depth + 1)
        right = await self._transcribe_span(right_start, right_end, depth + 1)
        return left + "\n" + _deduplicate_overlap(left, right)


async def _transcribe_audio(audio_path: str, config: AppConfig, model: str) -> str:
    """Transcribe audio, splitting whenever the provider imposes a limit.

    Splits when the file exceeds OpenAI's 25MB limit or 1400s duration, and also
    when a response reaches the provider's output-token cap (which
    ``gpt-4o-transcribe`` hits silently at 2048 tokens).
    """
    file_size = os.path.getsize(audio_path)
    duration = await _get_audio_duration(audio_path)
    direct_capped = False

    if file_size <= MAX_AUDIO_BYTES and duration <= MAX_AUDIO_DURATION:
        _debug(
            "transcribe",
            f"File {file_size / 1024 / 1024:.1f}MB, {duration:.0f}s — direct",
        )
        result = await _transcribe_file(audio_path, config, model)
        if not _hit_output_cap(result):
            return result.text
        direct_capped = True
        _debug(
            "transcribe",
            f"Direct transcription hit the {TRANSCRIBE_OUTPUT_TOKEN_CAP}-token "
            "output cap — re-transcribing in overlapping spans",
        )
    else:
        reason = "size" if file_size > MAX_AUDIO_BYTES else "duration"
        _debug(
            "transcribe",
            f"File {file_size / 1024 / 1024:.1f}MB, {duration:.0f}s — splitting ({reason})",
        )

    chunks_dir = os.path.join(os.path.dirname(audio_path), "chunks")
    os.makedirs(chunks_dir, exist_ok=True)
    session = _TranscriptionSession(audio_path, config, model, chunks_dir, duration)
    if direct_capped:
        # The whole file already hit the cap, so skip re-sending it as one span
        # and start from halves.
        session.target_span = max(MIN_SPAN_SECONDS, duration / 2)
    joined = await session.run()
    _debug(
        "transcribe",
        f"Joined {session.segment_count} segments → {len(joined)} chars (deduped)",
    )

    # Debug: save the last segment's audio and transcription for inspection.
    # Only when debug mode is enabled — prevents leaking transcript content
    # to /tmp in production and avoids concurrent-request file collisions.
    if config.debug and session.last_segment_path:
        try:
            shutil.copy2(session.last_segment_path, "/tmp/last_chunk_audio.mp3")
            _debug("transcribe", "Saved last chunk audio to /tmp/last_chunk_audio.mp3")
        except Exception as exc:
            print(f"Failed to save last chunk audio: {exc}", file=sys.stderr)

        try:
            with open("/tmp/last_chunk_transcription.txt", "w") as f:
                f.write(session.last_text)
            _debug(
                "transcribe",
                "Saved last chunk transcription to /tmp/last_chunk_transcription.txt",
            )
        except Exception as exc:
            print(f"Failed to save last chunk transcription: {exc}", file=sys.stderr)

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
