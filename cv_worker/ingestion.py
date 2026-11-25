"""
ROADSHADOW 2.0 — CV Worker Video Ingestion Module
Loads local uploaded traffic video files, SSRF-validated HTTP video downloads,
and timeout-bounded RTSP camera probes via OpenCV.
"""

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Generator, Optional, Tuple
import os
import tempfile

from security import scrub_url_credentials, validate_remote_url

# Enforce bounded FFmpeg TCP/socket timeout for RTSP stream probes (5 seconds)
os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp|stimeout;5000000")

try:
    import cv2
except ImportError:  # pragma: no cover
    cv2 = None  # type: ignore[assignment]

try:
    import httpx
except ImportError:  # pragma: no cover
    httpx = None  # type: ignore[assignment]


ALLOWED_VIDEO_EXTENSIONS = {".mp4", ".mov", ".webm"}


@dataclass
class VideoMetadata:
    width: int
    height: int
    fps: float
    total_frames: int
    duration_sec: float


def _open_capture_with_timeouts(source: str, timeout_ms: int = 5000):
    if cv2 is None:
        raise RuntimeError("OpenCV (cv2) is not installed in this environment.")
    cap = cv2.VideoCapture(source, cv2.CAP_FFMPEG)
    if hasattr(cv2, "CAP_PROP_OPEN_TIMEOUT_MSEC"):
        cap.set(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, float(timeout_ms))
    if hasattr(cv2, "CAP_PROP_READ_TIMEOUT_MSEC"):
        cap.set(cv2.CAP_PROP_READ_TIMEOUT_MSEC, float(timeout_ms))
    if not cap.isOpened():
        cap.release()
        # Fallback to default backend for local files
        if not source.startswith(("rtsp://", "rtsps://")):
            cap = cv2.VideoCapture(source)
    return cap


def probe_video_source(source: str, timeout_ms: int = 5000) -> VideoMetadata:
    """Open a local video file or RTSP stream with OpenCV and read real stream metadata."""
    cap = _open_capture_with_timeouts(source, timeout_ms=timeout_ms)
    if not cap.isOpened():
        safe_src = scrub_url_credentials(source)
        raise RuntimeError(f"Unable to open video source: {safe_src}")
    try:
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
        fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        if fps <= 0.0 or fps > 240.0:
            fps = 25.0
        duration_sec = round(total_frames / fps, 2) if total_frames > 0 else 0.0
        ok, frame = cap.read()
        if not ok or frame is None:
            raise RuntimeError("Video source opened, but no decodable video frames were found.")
        if width == 0 or height == 0:
            height, width = frame.shape[:2]
        return VideoMetadata(
            width=width,
            height=height,
            fps=round(fps, 2),
            total_frames=max(total_frames, 1),
            duration_sec=duration_sec,
        )
    finally:
        cap.release()


def iter_sampled_frames(
    source: str,
    target_sample_fps: float = 4.0,
    max_frames: int = 360,
) -> Generator[Tuple[int, float, Any], None, None]:
    """
    Yield (frame_number, timestamp_sec, bgr_frame) sampled at approximately
    `target_sample_fps` to keep inference responsive while preserving motion continuity.
    """
    if not source or not os.path.exists(source):
        raise FileNotFoundError("Local video file not found for frame extraction.")

    cap = _open_capture_with_timeouts(source, timeout_ms=10000)
    if not cap.isOpened():
        raise RuntimeError("Failed to open video file for frame extraction.")

    try:
        fps = float(cap.get(cv2.CAP_PROP_FPS) or 25.0)
        if fps <= 0.0 or fps > 240.0:
            fps = 25.0
        stride = max(1, int(round(fps / max(0.5, target_sample_fps))))

        frame_idx = 0
        yielded = 0
        while yielded < max_frames:
            ok, frame = cap.read()
            if not ok or frame is None:
                break
            if frame_idx % stride == 0:
                timestamp_sec = round(frame_idx / fps, 3)
                yield frame_idx, timestamp_sec, frame
                yielded += 1
            frame_idx += 1
    finally:
        cap.release()


def download_remote_video_to_temp(
    video_url: str,
    max_bytes: int,
    timeout_sec: float = 45.0,
) -> str:
    """
    Safely download an SSRF-validated HTTP(S) traffic video to a temporary file
    while enforcing strict byte limits and redirect validation.
    """
    ok, err = validate_remote_url(video_url, allowed_schemes=("http", "https"), resolve_dns=True)
    if not ok:
        raise ValueError(err or "Blocked video URL.")
    if httpx is None:
        raise RuntimeError("httpx is required for URL-based video downloads.")

    suffix = Path(video_url.split("?")[0]).suffix.lower()
    if suffix not in ALLOWED_VIDEO_EXTENSIONS:
        suffix = ".mp4"

    tmp_path: Optional[str] = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp_path = tmp.name
            bytes_written = 0
            with httpx.Client(timeout=timeout_sec, follow_redirects=False) as client:
                with client.stream("GET", video_url) as resp:
                    if resp.status_code in (301, 302, 303, 307, 308):
                        raise ValueError("HTTP redirects are not permitted for remote video downloads.")
                    if resp.status_code >= 400:
                        raise RuntimeError(f"Failed to fetch remote video (HTTP {resp.status_code}).")
                    for chunk in resp.iter_bytes(chunk_size=1024 * 1024):
                        bytes_written += len(chunk)
                        if bytes_written > max_bytes:
                            raise ValueError(f"Remote video exceeds maximum permitted size ({max_bytes // (1024 * 1024)} MB).")
                        tmp.write(chunk)
            if bytes_written == 0:
                raise ValueError("Remote video file is empty.")
        return tmp_path
    except Exception:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
        raise


def probe_rtsp_stream(rtsp_url: str, timeout_ms: int = 5000) -> Tuple[bool, Optional[VideoMetadata], Optional[str]]:
    """Actively test an SSRF-validated RTSP stream connection with bounded OpenCV timeouts."""
    ok, err = validate_remote_url(rtsp_url, allowed_schemes=("rtsp", "rtsps"), resolve_dns=True)
    if not ok:
        return False, None, err or "Blocked RTSP stream target."
    try:
        meta = probe_video_source(rtsp_url, timeout_ms=timeout_ms)
        return True, meta, None
    except Exception as exc:  # noqa: BLE001
        safe_err = scrub_url_credentials(str(exc))
        return False, None, safe_err
