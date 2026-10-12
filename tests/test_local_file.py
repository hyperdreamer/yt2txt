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

