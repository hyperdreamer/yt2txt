"""Tests for timeout configuration parsing, validation, and wiring."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Ensure the backend directory is importable
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

import main as backend_main  # noqa: E402
from main import (  # noqa: E402
    DEFAULT_TIMEOUT_CONNECT,
    DEFAULT_TIMEOUT_POOL,
    DEFAULT_TIMEOUT_READ,
    DEFAULT_TIMEOUT_WRITE,
    TIMEOUT_RANGES,
    AppConfig,
    TimeoutConfig,
    _parse_timeout_config,
    load_config,
)


# ── TimeoutConfig defaults ──────────────────────────────────────

class TestTimeoutConfigDefaults:
    """TimeoutConfig uses the same defaults as TextKit."""

    def test_default_factory(self):
        tc = TimeoutConfig()
        assert tc.connect == 10.0
        assert tc.read == 600.0
        assert tc.write == 60.0
        assert tc.pool == 10.0

    def test_defaults_match_constants(self):
        tc = TimeoutConfig()
        assert tc.connect == DEFAULT_TIMEOUT_CONNECT
        assert tc.read == DEFAULT_TIMEOUT_READ
        assert tc.write == DEFAULT_TIMEOUT_WRITE
        assert tc.pool == DEFAULT_TIMEOUT_POOL

    def test_explicit_values(self):
        tc = TimeoutConfig(connect=5.0, read=300.0, write=30.0, pool=5.0)
        assert tc.connect == 5.0
        assert tc.read == 300.0
        assert tc.write == 30.0
        assert tc.pool == 5.0

    def test_frozen(self):
        tc = TimeoutConfig()
        with pytest.raises(Exception):  # FrozenInstanceError or AttributeError
            tc.connect = 999  # type: ignore[misc]


# ── _parse_timeout_config: defaults ─────────────────────────────

class TestParseTimeoutDefaults:
    """When config does not specify timeout, defaults are used."""

    def test_none_returns_defaults(self):
        tc = _parse_timeout_config(None)
        assert tc == TimeoutConfig()

    def test_empty_dict_returns_defaults(self):
        tc = _parse_timeout_config({})
        assert tc == TimeoutConfig()

    def test_partial_overrides(self):
        tc = _parse_timeout_config({"read": 120.0})
        assert tc.read == 120.0
        assert tc.connect == DEFAULT_TIMEOUT_CONNECT
        assert tc.write == DEFAULT_TIMEOUT_WRITE
        assert tc.pool == DEFAULT_TIMEOUT_POOL


# ── _parse_timeout_config: configured values ────────────────────

class TestParseTimeoutConfigured:
    """Valid timeout values are accepted."""

    def test_all_keys_set(self):
        tc = _parse_timeout_config({
            "connect": 15.0,
            "read": 900.0,
            "write": 120.0,
            "pool": 20.0,
        })
        assert tc.connect == 15.0
        assert tc.read == 900.0
        assert tc.write == 120.0
        assert tc.pool == 20.0

    def test_integer_values_accepted(self):
        tc = _parse_timeout_config({"connect": 5, "read": 300})
        assert tc.connect == 5.0
        assert tc.read == 300.0

    def test_boundary_max_values(self):
        """Values at the upper bound are allowed."""
        tc = _parse_timeout_config({
            "connect": 300.0,
            "read": 3600.0,
            "write": 600.0,
            "pool": 300.0,
        })
        assert tc.connect == 300.0
        assert tc.read == 3600.0
        assert tc.write == 600.0
        assert tc.pool == 300.0


# ── _parse_timeout_config: validation ───────────────────────────

class TestParseTimeoutValidation:
    """Invalid timeout values raise RuntimeError."""

    def test_not_a_dict_raises(self):
        with pytest.raises(RuntimeError, match="ai.timeout must be a mapping"):
            _parse_timeout_config("not a dict")

    def test_non_numeric_raises(self):
        with pytest.raises(RuntimeError, match="ai.timeout.connect must be a number"):
            _parse_timeout_config({"connect": "fast"})

    def test_zero_raises(self):
        with pytest.raises(RuntimeError, match="ai.timeout.read must be > 0"):
            _parse_timeout_config({"read": 0.0})

    def test_negative_raises(self):
        with pytest.raises(RuntimeError, match="ai.timeout.read must be > 0"):
            _parse_timeout_config({"read": -5.0})

    def test_exceeds_max_raises(self):
        with pytest.raises(RuntimeError, match="ai.timeout.read must be > 0"):
            _parse_timeout_config({"read": 3601.0})

    def test_connect_exceeds_max_raises(self):
        with pytest.raises(RuntimeError, match="ai.timeout.connect"):
            _parse_timeout_config({"connect": 301.0})

    def test_write_zero_raises(self):
        with pytest.raises(RuntimeError, match="ai.timeout.write must be > 0"):
            _parse_timeout_config({"write": 0})

    def test_pool_exceeds_max_raises(self):
        with pytest.raises(RuntimeError, match="ai.timeout.pool"):
            _parse_timeout_config({"pool": 301.0})

    def test_none_value_raises(self):
        with pytest.raises(RuntimeError, match="ai.timeout.connect must be a number"):
            _parse_timeout_config({"connect": None})

    def test_boolean_value_raises(self):
        with pytest.raises(RuntimeError, match="ai.timeout.connect must be a number"):
            _parse_timeout_config({"connect": True})

    def test_unknown_key_raises(self):
        with pytest.raises(RuntimeError, match="Unknown ai.timeout setting.*idle"):
            _parse_timeout_config({"idle": 30})


# ── AppConfig integration ───────────────────────────────────────

class TestAppConfigTimeout:
    """AppConfig carries a TimeoutConfig."""

    def test_default_appconfig_has_timeout(self):
        cfg = AppConfig()
        assert isinstance(cfg.timeout, TimeoutConfig)
        assert cfg.timeout.read == DEFAULT_TIMEOUT_READ

    def test_appconfig_with_explicit_timeout(self):
        tc = TimeoutConfig(read=120.0)
        cfg = AppConfig(timeout=tc)
        assert cfg.timeout.read == 120.0


# ── TIMEOUT_RANGES contract ────────────────────────────────────

class TestTimeoutRanges:
    """Range definitions are consistent with TimeoutConfig defaults."""

    def test_all_range_keys_have_defaults(self):
        for key in TIMEOUT_RANGES:
            assert hasattr(TimeoutConfig(), key), f"Missing default for {key}"

    def test_defaults_within_ranges(self):
        tc = TimeoutConfig()
        for key, (low, high) in TIMEOUT_RANGES.items():
            val = getattr(tc, key)
            assert low < val <= high, f"{key}={val} not in ({low}, {high}]"


# ── Wiring: _transcribe_file uses config.timeout ────────────────

class TestTimeoutWiring:
    """Verify that the transcription function receives timeout from config."""

    def test_default_deadline_equals_read_plus_60(self):
        """The outer asyncio deadline = timeout.read + 60 (buffer)."""
        tc = TimeoutConfig()
        deadline = tc.read + 60
        assert deadline == DEFAULT_TIMEOUT_READ + 60
        assert deadline > tc.read

    def test_configured_read_adds_60_buffer(self):
        """With a custom read timeout, deadline still gets the +60 buffer."""
        tc = TimeoutConfig(read=120.0)
        deadline = tc.read + 60
        assert deadline == 180.0
        assert deadline > tc.read

    def test_httpx_timeout_matches_config(self):
        """The httpx.Timeout uses the configured per-phase values directly."""
        import httpx
        tc = TimeoutConfig(connect=5.0, read=300.0, write=30.0, pool=8.0)
        t = httpx.Timeout(
            connect=tc.connect,
            read=tc.read,
            write=tc.write,
            pool=tc.pool,
        )
        assert t.connect == 5.0
        assert t.read == 300.0
        assert t.write == 30.0
        assert t.pool == 8.0

    @pytest.mark.asyncio
    async def test_transcribe_file_wires_configured_timeouts(
        self, monkeypatch, tmp_path
    ):
        captured = {}

        class Response:
            is_error = False
            text = "transcribed"

        class Client:
            def __init__(self, *, timeout):
                captured["httpx_timeout"] = timeout

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return False

            async def post(self, *_args, **_kwargs):
                return Response()

        original_wait_for = backend_main.asyncio.wait_for  # type: ignore[attr-defined]

        async def capture_wait_for(awaitable, *, timeout):
            captured["outer_deadline"] = timeout
            return await original_wait_for(awaitable, timeout=timeout)

        monkeypatch.setattr(
            backend_main.httpx, "AsyncClient", Client  # type: ignore[attr-defined]
        )
        monkeypatch.setattr(
            backend_main.asyncio,  # type: ignore[attr-defined]
            "wait_for",
            capture_wait_for,
        )

        audio = tmp_path / "chunk.mp3"
        audio.write_bytes(b"audio")
        timeout = TimeoutConfig(connect=5, read=300, write=30, pool=8)
        config = AppConfig(api_key="test-key", timeout=timeout)

        result = await backend_main._transcribe_file(  # type: ignore[attr-defined]
            str(audio), config, config.model
        )

        assert result == "transcribed"
        assert captured["httpx_timeout"].connect == 5
        assert captured["httpx_timeout"].read == 300
        assert captured["httpx_timeout"].write == 30
        assert captured["httpx_timeout"].pool == 8
        assert captured["outer_deadline"] == 360
