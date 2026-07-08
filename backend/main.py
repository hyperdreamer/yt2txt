"""FastAPI backend: extract transcripts from YouTube/yt-dlp-supported sites.

Two paths:
1. Video has native subtitles → download directly via yt-dlp.
2. No subtitles → download audio via yt-dlp, transcribe via OpenAI API.
"""

from __future__ import annotations

import asyncio
import json
import os
import shlex
import shutil
import signal
import sys
import tempfile
import time
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

    return AppConfig(
        host=str(raw.get("host", DEFAULT_HOST)),
        port=int(raw.get("port", DEFAULT_PORT)),
        debug=bool(raw.get("debug", False)),
        api_base=api_base,
        api_key=api_key,
        model=str(ai_section.get("model", DEFAULT_MODEL)),
    )


# ── App setup ───────────────────────────────────────────────────

app = FastAPI(title="YT2TXT", version="0.0.9")


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
    language: str = "en"


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


def _has_subtitles(list_subs_output: str) -> bool:
    """Check if yt-dlp --list-subs output indicates available subtitles."""
    # Look for language codes in the subtitles listing
    for line in list_subs_output.splitlines():
        line = line.strip()
        # Auto-generated subtitles lines look like: "en,fr,ja,..."
        # Available subtitles: "Language Name" or just language codes
        if (
            "Available subtitles" in line
            or "Available automatic captions" in line
            or "has subtitles" in line.lower()
        ):
            return True
    # Also check if any language code lines exist
    import re

    lines = list_subs_output.splitlines()
    in_subs_section = False
    for line in lines:
        if "subtitles" in line.lower() or "caption" in line.lower():
            in_subs_section = True
            continue
        if in_subs_section and re.match(r"^\s*[a-z]{2,3}(\s|$)", line):
            return True
        if line.strip() == "":
            in_subs_section = False

    return False


# ── OpenAI transcription ────────────────────────────────────────


MAX_AUDIO_BYTES = 24 * 1024 * 1024  # OpenAI 25MB limit, leave 1MB for multipart overhead
CHUNK_DURATION_SECONDS = 25 * 60   # ~25 minutes per chunk at 64kbps ≈ 12MB


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


async def _transcribe_audio(
    audio_path: str, config: AppConfig, model: str
) -> str:
    """Transcribe audio, chunking if file exceeds OpenAI's 25MB limit.

    If the file is ≤24MB, transcribes directly.
    If larger, splits with ffmpeg into ~23MB chunks, transcribes each,
    and joins the results.
    """
    file_size = os.path.getsize(audio_path)

    if file_size <= MAX_AUDIO_BYTES:
        _debug("transcribe", f"File {file_size / 1024 / 1024:.1f}MB — direct transcription")
        return await _transcribe_file(audio_path, config, model)

    _debug("transcribe", f"File {file_size / 1024 / 1024:.1f}MB — splitting into chunks")

    ffmpeg = shutil.which("ffmpeg") or "ffmpeg"
    chunks_dir = os.path.join(os.path.dirname(audio_path), "chunks")
    os.makedirs(chunks_dir, exist_ok=True)

    # Split into chunks of ~CHUNK_DURATION_SECONDS each
    chunk_pattern = os.path.join(chunks_dir, "chunk_%03d.mp3")
    proc = None
    try:
        proc = await asyncio.create_subprocess_exec(
            ffmpeg,
            "-y",
            "-i", audio_path,
            "-f", "segment",
            "-segment_time", str(CHUNK_DURATION_SECONDS),
            "-c", "copy",
            chunk_pattern,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=120)
        if proc.returncode != 0:
            err = stderr.decode("utf-8", errors="replace")[:300]
            raise HTTPException(
                status_code=500,
                detail=f"Failed to split audio: {err}",
            )
    except asyncio.TimeoutError:
        if proc:
            proc.kill()
        raise HTTPException(status_code=504, detail="Audio splitting timed out")
    except FileNotFoundError:
        raise HTTPException(
            status_code=500,
            detail="ffmpeg is not installed. Required for splitting long audio files.",
        )

    chunks = sorted(
        [os.path.join(chunks_dir, f) for f in os.listdir(chunks_dir) if f.endswith(".mp3")]
    )
    _debug("transcribe", f"Split into {len(chunks)} chunks")

    texts: list[str] = []
    for i, chunk_path in enumerate(chunks):
        _debug("transcribe", f"Transcribing chunk {i + 1}/{len(chunks)}")
        text = await _transcribe_file(chunk_path, config, model, f"chunk {i + 1}/{len(chunks)}")
        texts.append(text)

    joined = "\n\n".join(texts)
    _debug("transcribe", f"Joined {len(chunks)} chunks → {len(joined)} chars")
    return joined


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
    language = req.language or "en"

    _debug("transcript", f"Processing: {url} [lang={language}]")

    # ── Try subtitles first ──────────────────────────────────
    with tempfile.TemporaryDirectory() as tmpdir:
        try:
            list_output = await _run_ytdlp(
                ["--list-subs", "--skip-download", url], timeout=60
            )
        except HTTPException:
            # If --list-subs fails, try downloading audio directly
            list_output = ""

        if list_output and _has_subtitles(list_output):
            _debug("transcript", "Subtitles available — extracting")
            sub_args = [
                "--write-subs",
                "--write-auto-subs",
                "--skip-download",
                "--convert-subs",
                "srt",
                "-o",
                os.path.join(tmpdir, "%(id)s.%(ext)s"),
                url,
            ]
            # If language is set, add --sub-langs; empty = Original (yt-dlp default)
            if language:
                sub_args.insert(2, language)
                sub_args.insert(2, "--sub-langs")
            try:
                await _run_ytdlp(sub_args, timeout=300)
            except HTTPException:
                raise

            video_id = ""
            # Try to extract video ID from URL or from downloaded files
            for fname in os.listdir(tmpdir):
                if fname.endswith((".srt", ".vtt")):
                    video_id = os.path.splitext(fname)[0]
                    # Strip language suffix (e.g. "abc123.en" → "abc123")
                    parts = video_id.rsplit(".", 1)
                    if len(parts) == 2 and len(parts[1]) <= 5:
                        video_id = parts[0]
                    break

            sub_path = _find_subtitle_file(tmpdir, video_id)
            if sub_path:
                text = _parse_subtitle_text(sub_path)
                _debug("transcript", f"Extracted {len(text)} chars from subtitles")
                return {
                    "text": text,
                    "source": "subtitles",
                    "model": "yt-dlp",
                    "error": None,
                }

            # Fallback: subtitles listed but extraction failed
            _debug("transcript", "Subtitles listed but not found — falling back to transcription")

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
