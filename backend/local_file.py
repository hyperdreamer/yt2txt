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


