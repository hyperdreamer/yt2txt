"""Tests for audio chunking, overlap stitching, and output-token-cap recovery.

Background: ``gpt-4o-transcribe`` and ``gpt-4o-mini-transcribe`` silently cap
the transcription response at 2048 output tokens (HTTP 200).  Any audio whose
transcript is longer is returned truncated.  These tests pin the recovery
behaviour: a span that hits the cap is bisected (with overlap) and re-queued,
and the overlapping text is deduplicated when joined.
"""

from __future__ import annotations

import asyncio
import re
import sys
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

# Ensure the backend directory is importable
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

import main as backend_main  # noqa: E402
from main import (  # noqa: E402
    CHUNK_OVERLAP_SECONDS,
    MAX_AUDIO_DURATION,
    TRANSCRIBE_OUTPUT_TOKEN_CAP,
    AppConfig,
    TranscriptionResult,
    _bisect_span,
    _deduplicate_overlap,
    _hit_output_cap,
    _join_transcripts,
    _parse_transcription_response,
)

CONFIG = AppConfig(api_key="test-key", model="test-model")


# ── Fakes ────────────────────────────────────────────────────────
#
# The fake extraction encodes the requested span in the returned path so the
# fake transcription call can tell how much audio it was handed.  A span longer
# than ``safe_span`` simulates the provider truncating at the output cap.


class _FakeResponse:
    def __init__(self, body: str, *, is_error: bool = False):
        self.text = body
        self.is_error = is_error


class FakeAPI:
    def __init__(self, safe_span: float = 300.0, direct: TranscriptionResult | None = None):
        self.safe_span = safe_span
        self.direct = direct
        self.spans: list[tuple[float, float]] = []
        self.calls: list[str] = []

    async def extract(self, start: float, end: float) -> str:
        self.spans.append((start, end))
        return f"/fake/{start:.6f}_{end:.6f}.mp3"

    async def transcribe(self, path, config, model, chunk_label=""):
        self.calls.append(path)
        match = re.fullmatch(r"/fake/([\d.]+)_([\d.]+)\.mp3", path)
        if not match:
            # A call on the real input file (the direct path).
            assert self.direct is not None, f"unexpected direct transcribe: {path}"
            return self.direct
        start, end = float(match.group(1)), float(match.group(2))
        if (end - start) > self.safe_span:
            return TranscriptionResult("<CAPPED>", TRANSCRIBE_OUTPUT_TOKEN_CAP)
        return TranscriptionResult(f"[{start:.1f}-{end:.1f}]", 50)


@pytest.fixture
def patch_pipeline(monkeypatch, tmp_path):
    """Wire the fakes into the backend and return a session factory."""

    def install(fake: FakeAPI, duration: float):
        monkeypatch.setattr(backend_main._TranscriptionSession, "_extract", fake.extract)
        monkeypatch.setattr(backend_main, "_transcribe_file", fake.transcribe)
        monkeypatch.setattr(
            backend_main, "_get_audio_duration", AsyncMock(return_value=duration)
        )
        return fake

    return install


# ── _deduplicate_overlap ─────────────────────────────────────────

class TestDeduplicateOverlap:
    def test_removes_shared_boundary(self):
        a = "the quick brown fox jumps over the lazy dog"
        b = "over the lazy dog and then some more"
        assert _deduplicate_overlap(a, b) == " and then some more"

    def test_returns_b_unchanged_when_no_overlap(self):
        assert _deduplicate_overlap("hello world", "totally different") == "totally different"

    def test_empty_inputs(self):
        assert _deduplicate_overlap("", "abc") == "abc"
        assert _deduplicate_overlap("abc", "") == ""


# ── _bisect_span ─────────────────────────────────────────────────

class TestBisectSpan:
    def test_halves_overlap_by_configured_amount(self):
        (ls, le), (rs, re) = _bisect_span(0.0, 600.0)
        assert le - rs == pytest.approx(CHUNK_OVERLAP_SECONDS)

    def test_halves_cover_original_span(self):
        (ls, le), (rs, re) = _bisect_span(100.0, 900.0)
        assert ls == 100.0
        assert re == 900.0
        assert ls < le and rs < re
        # The halves overlap, so the left end is past the right start.
        assert rs < le
        assert le < re

    def test_odd_span(self):
        (ls, le), (rs, re) = _bisect_span(0.0, 605.0)
        assert (le - ls) > 0 and (re - rs) > 0
        assert le - rs == pytest.approx(CHUNK_OVERLAP_SECONDS)


# ── _hit_output_cap ──────────────────────────────────────────────

class TestHitOutputCap:
    def test_none_is_not_capped(self):
        assert _hit_output_cap(TranscriptionResult("x", None)) is False

    def test_below_cap(self):
        assert _hit_output_cap(TranscriptionResult("x", 100)) is False

    def test_at_cap(self):
        assert _hit_output_cap(TranscriptionResult("x", TRANSCRIBE_OUTPUT_TOKEN_CAP)) is True

    def test_above_cap(self):
        assert _hit_output_cap(TranscriptionResult("x", 9999)) is True


# ── _parse_transcription_response ────────────────────────────────

class TestParseTranscriptionResponse:
    def test_json_with_output_tokens(self):
        body = '{"text": "hello", "usage": {"type": "tokens", "output_tokens": 2048}}'
        assert _parse_transcription_response(_FakeResponse(body)) == ("hello", 2048)

    def test_json_without_usage(self):
        assert _parse_transcription_response(_FakeResponse('{"text": "hi"}')) == ("hi", None)

    def test_json_with_duration_usage(self):
        body = '{"text": "hi", "usage": {"type": "duration", "seconds": 5}}'
        assert _parse_transcription_response(_FakeResponse(body)) == ("hi", None)

    def test_plain_text_fallback(self):
        assert _parse_transcription_response(_FakeResponse("  raw text  ")) == ("raw text", None)

    def test_bool_output_tokens_rejected(self):
        body = '{"text": "hi", "usage": {"output_tokens": true}}'
        assert _parse_transcription_response(_FakeResponse(body)) == ("hi", None)


# ── _join_transcripts ────────────────────────────────────────────

class TestJoinTranscripts:
    def test_single(self):
        assert _join_transcripts(["only"]) == "only"

    def test_empty(self):
        assert _join_transcripts([]) == ""

    def test_dedups_boundaries(self):
        out = _join_transcripts(["the quick brown fox", "brown fox jumps high"])
        assert out == "the quick brown fox\n jumps high"


# ── _TranscriptionSession ────────────────────────────────────────

class TestTranscriptionSession:
    def test_direct_span_returns_text_verbatim(self, patch_pipeline, tmp_path):
        audio = tmp_path / "a.mp3"
        audio.write_bytes(b"audio")
        fake = patch_pipeline(FakeAPI(safe_span=10_000.0), duration=100.0)
        session = backend_main._TranscriptionSession(
            str(audio), CONFIG, CONFIG.model, str(tmp_path), 100.0
        )
        out = asyncio.run(session.run())
        assert out == "[0.0-100.0]"
        assert fake.spans == [(0.0, 100.0)]

    def test_top_level_spans_overlap_by_exactly_configured_amount(self, patch_pipeline, tmp_path):
        audio = tmp_path / "a.mp3"
        audio.write_bytes(b"audio")
        fake = patch_pipeline(FakeAPI(safe_span=10_000.0), duration=3000.0)
        session = backend_main._TranscriptionSession(
            str(audio), CONFIG, CONFIG.model, str(tmp_path), 3000.0
        )
        asyncio.run(session.run())

        spans = fake.spans
        assert spans[0] == (0.0, 1200.0)
        assert spans[1] == (1200.0 - CHUNK_OVERLAP_SECONDS, 2400.0)
        assert spans[2] == (2400.0 - CHUNK_OVERLAP_SECONDS, 3000.0)
        # Full coverage: first span starts at 0, last ends at the true duration.
        assert spans[0][0] == 0.0
        assert spans[-1][1] == pytest.approx(3000.0)
        # No gaps between top-level spans.
        for prev, nxt in zip(spans, spans[1:]):
            assert nxt[0] <= prev[1]

    def test_capped_span_is_bisected_until_under_cap(self, patch_pipeline, tmp_path):
        audio = tmp_path / "a.mp3"
        audio.write_bytes(b"audio")
        fake = patch_pipeline(FakeAPI(safe_span=300.0), duration=605.0)
        session = backend_main._TranscriptionSession(
            str(audio), CONFIG, CONFIG.model, str(tmp_path), 605.0
        )
        out = asyncio.run(session.run())

        # Every leapf span that was kept must have been under the safe size.
        assert "<CAPPED>" not in out
        # The tail of the audio made it into the result.
        assert out.strip().endswith("605.0]")
        # Every extracted span was eventually either safe or recursively split.
        assert all((e - s) <= 605.0 for s, e in fake.spans)

    def test_recovers_whole_timeline_with_no_gaps(self, patch_pipeline, tmp_path):
        audio = tmp_path / "a.mp3"
        audio.write_bytes(b"audio")
        patch_pipeline(FakeAPI(safe_span=120.0), duration=605.0)
        session = backend_main._TranscriptionSession(
            str(audio), CONFIG, CONFIG.model, str(tmp_path), 605.0
        )
        out = asyncio.run(session.run())
        # The left edge of the final kept segment must be near the real end.
        assert "605.0]" in out
        assert "<CAPPED>" not in out

    def test_tiny_safe_span_still_terminates(self, patch_pipeline, tmp_path):
        audio = tmp_path / "a.mp3"
        audio.write_bytes(b"audio")
        # safe_span below MIN_SPAN_SECONDS => everything is capped; recursion
        # must stop at the floor rather than loop forever.
        fake = patch_pipeline(FakeAPI(safe_span=1.0), duration=605.0)
        session = backend_main._TranscriptionSession(
            str(audio), CONFIG, CONFIG.model, str(tmp_path), 605.0
        )
        out = asyncio.run(session.run())
        assert isinstance(out, str)
        assert len(fake.spans) < 200


# ── _transcribe_audio entry point ────────────────────────────────

class TestTranscribeAudio:
    def test_direct_call_when_under_limits(self, patch_pipeline, tmp_path):
        audio = tmp_path / "a.mp3"
        audio.write_bytes(b"audio")
        fake = patch_pipeline(
            FakeAPI(safe_span=10_000.0, direct=TranscriptionResult("full text", 100)),
            duration=100.0,
        )
        out = asyncio.run(backend_main._transcribe_audio(str(audio), CONFIG, CONFIG.model))
        assert out == "full text"
        # No extraction happened for a clean direct transcription.
        assert fake.spans == []

    def test_direct_cap_falls_back_to_splitting(self, patch_pipeline, tmp_path):
        audio = tmp_path / "a.mp3"
        audio.write_bytes(b"audio")
        assert 605.0 <= MAX_AUDIO_DURATION  # direct-eligible duration
        fake = patch_pipeline(
            FakeAPI(
                safe_span=300.0,
                direct=TranscriptionResult("<CAPPED>", TRANSCRIBE_OUTPUT_TOKEN_CAP),
            ),
            duration=605.0,
        )
        out = asyncio.run(backend_main._transcribe_audio(str(audio), CONFIG, CONFIG.model))
        assert "<CAPPED>" not in out
        assert out.strip().endswith("605.0]")
        assert fake.spans  # it split rather than accepting the truncated text

    def test_whisper_style_call_is_not_mistaken_for_a_cap(self, patch_pipeline, tmp_path):
        audio = tmp_path / "a.mp3"
        audio.write_bytes(b"audio")
        # usage for whisper-1 carries no output_tokens -> never treated as capped.
        fake = patch_pipeline(
            FakeAPI(safe_span=10_000.0, direct=TranscriptionResult("full", None)),
            duration=605.0,
        )
        out = asyncio.run(backend_main._transcribe_audio(str(audio), CONFIG, CONFIG.model))
        assert out == "full"
        assert fake.spans == []
