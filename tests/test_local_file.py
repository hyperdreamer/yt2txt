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
