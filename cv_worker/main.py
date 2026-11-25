"""
ROADSHADOW 2.0 — External Python Computer Vision Microservice
FastAPI + OpenCV + Ultralytics YOLO + ByteTrack + Trajectory Conflict Pipeline.

Endpoints:
  GET  /health                -> Model readiness, runtime info, and dependency check
  POST /api/v1/analyze-upload -> Analyze a multipart-uploaded video file directly (used by server.ts)
  POST /api/v1/analyze        -> Analyze an SSRF-validated remote HTTP(S) traffic video URL
  POST /api/v1/rtsp/probe     -> Actively test an SSRF-validated RTSP stream via OpenCV
"""

from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional
import asyncio
import json
import logging
import os
import tempfile
import threading
import time

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from pydantic import BaseModel

from conflict_analyzer import analyze_conflicts
from detector import RoadUserDetector
from ingestion import (
    ALLOWED_VIDEO_EXTENSIONS,
    download_remote_video_to_temp,
    iter_sampled_frames,
    probe_rtsp_stream,
    probe_video_source,
)
from security import sanitize_identifier, verify_bearer_token
from tracker import VelocityTracker
from trajectory import build_trajectories


logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("roadshadow.cv.api")

API_KEY = os.getenv("CV_SERVICE_API_KEY", "").strip()
SAMPLE_FPS = float(os.getenv("CV_SAMPLE_FPS", "4.0"))
MAX_FRAMES = int(os.getenv("CV_MAX_FRAMES", "360"))
CONF_THRESHOLD = float(os.getenv("CV_CONF_THRESHOLD", "0.30"))
MAX_UPLOAD_MB = max(10, min(1024, int(os.getenv("CV_MAX_UPLOAD_MB", "250"))))
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024
PRELOAD_MODEL = os.getenv("CV_PRELOAD_MODEL", "true").strip().lower() in {"1", "true", "yes"}

_detector: Optional[RoadUserDetector] = None
_detector_error: Optional[str] = None
_model_init_lock = threading.Lock()
_inference_lock = threading.Lock()


def structured_log(level: str, event: str, **fields) -> None:
    payload = {"event": event, **fields}
    msg = json.dumps(payload, default=str)
    if level == "ERROR":
        logger.error(msg)
    elif level == "WARN":
        logger.warning(msg)
    else:
        logger.info(msg)


def get_detector() -> RoadUserDetector:
    global _detector, _detector_error
    if _detector is None:
        with _model_init_lock:
            if _detector is None:
                try:
                    _detector = RoadUserDetector(conf_threshold=CONF_THRESHOLD)
                    _detector_error = None
                except Exception as exc:  # noqa: BLE001
                    _detector_error = str(exc)
                    structured_log("ERROR", "detector_init_failed", error=str(exc))
                    raise
    return _detector


def require_api_key(authorization: Optional[str]) -> None:
    if not verify_bearer_token(authorization, API_KEY):
        structured_log("WARN", "cv_worker_auth_denied")
        raise HTTPException(status_code=401, detail="Unauthorized CV worker request.")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if PRELOAD_MODEL:
        try:
            det = get_detector()
            structured_log(
                "INFO",
                "cv_worker_startup",
                model_ready=det.is_ready,
                model_version=det.model_version,
                device=det.device,
                tracker=det.tracker_cfg,
            )
        except Exception as exc:  # noqa: BLE001
            structured_log("WARN", "cv_worker_preload_failed", error=str(exc))
    yield


app = FastAPI(
    title="ROADSHADOW 2.0 Computer Vision Worker",
    version="2.0.0",
    lifespan=lifespan,
)


class AnalyzeUrlRequest(BaseModel):
    job_id: str
    video_id: str
    project_id: str = "default"
    location_id: str = "default"
    owner_id: str = "worker"
    video_url: str
    duration_sec: Optional[float] = None
    occurred_at_iso: Optional[str] = None


class RtspProbeRequest(BaseModel):
    rtsp_url: str


def run_cv_pipeline(
    source_path: str,
    job_id: str,
    video_id: str,
    project_id: str,
    location_id: str,
    owner_id: str,
    occurred_at_iso: Optional[str] = None,
):
    t0 = time.perf_counter()
    detector = get_detector()
    if not detector.is_ready:
        raise HTTPException(
            status_code=503,
            detail="Ultralytics YOLO runtime is not installed or model weights failed to load in this CV worker.",
        )

    meta = probe_video_source(source_path)
    tracker = VelocityTracker(frame_width=meta.width, frame_height=meta.height)

    all_detections = []
    analyzed_frames = 0

    # Lock around stateful ByteTrack tracker and reset tracker cleanly before every video job
    with _inference_lock:
        detector.reset_tracker()
        for frame_num, ts_sec, frame in iter_sampled_frames(
            source_path, target_sample_fps=SAMPLE_FPS, max_frames=MAX_FRAMES
        ):
            raw_dets = detector.track_frame(frame)
            enriched = tracker.enrich_frame_detections(frame_num, ts_sec, raw_dets)
            all_detections.extend(enriched)
            analyzed_frames += 1

    trajectories = build_trajectories(all_detections)
    events = analyze_conflicts(
        detections=all_detections,
        trajectories=trajectories,
        video_id=video_id,
        project_id=project_id,
        location_id=location_id,
        owner_id=owner_id,
        frame_width=meta.width,
        frame_height=meta.height,
        occurred_at_iso=occurred_at_iso,
    )

    elapsed_ms = int((time.perf_counter() - t0) * 1000)
    warnings = [
        "Camera homography calibration not configured: clearances and speeds represent image-plane pixel measurements, not calibrated meters or km/h.",
    ]
    if len(events) == 0:
        warnings.append(
            "No converging close-proximity road-user interactions crossed provisional conflict thresholds in the sampled frames."
        )

    structured_log(
        "INFO",
        "cv_pipeline_completed",
        job_id=job_id,
        video_id=video_id,
        analyzed_frames=analyzed_frames,
        detections=len(all_detections),
        trajectories=len(trajectories),
        events=len(events),
        processing_time_ms=elapsed_ms,
    )

    return {
        "job_id": sanitize_identifier(job_id, "job"),
        "model_version": f"{detector.model_version}+ByteTrack",
        "tracker": "ByteTrack",
        "device": detector.device,
        "video_metadata": {
            "width": meta.width,
            "height": meta.height,
            "fps": meta.fps,
            "total_frames": meta.total_frames,
            "duration_sec": meta.duration_sec,
        },
        "analyzed_frames": analyzed_frames,
        "processing_time_ms": elapsed_ms,
        "detections": all_detections,
        "trajectories": trajectories,
        "events": events,
        "warnings": warnings,
    }


@app.get("/health")
def health():
    device = "cpu"
    try:
        det = get_detector()
        model_ready = det.is_ready
        model_version = det.model_version
        device = det.device
    except Exception as exc:  # noqa: BLE001
        model_ready = False
        model_version = f"Unavailable ({exc})"

    return {
        "status": "ok" if model_ready else "degraded",
        "service": "roadshadow-cv-worker",
        "model_ready": model_ready,
        "model_version": model_version,
        "tracker": "ByteTrack",
        "device": device,
        "sample_fps": SAMPLE_FPS,
        "max_frames": MAX_FRAMES,
        "max_upload_mb": MAX_UPLOAD_MB,
        "auth_required": bool(API_KEY),
        "error": _detector_error,
    }


@app.post("/api/v1/analyze")
def analyze_by_url(req: AnalyzeUrlRequest, authorization: Optional[str] = Header(default=None)):
    require_api_key(authorization)
    tmp_path: Optional[str] = None
    try:
        tmp_path = download_remote_video_to_temp(req.video_url, max_bytes=MAX_UPLOAD_BYTES)
        return run_cv_pipeline(
            source_path=tmp_path,
            job_id=req.job_id,
            video_id=req.video_id,
            project_id=req.project_id,
            location_id=req.location_id,
            owner_id=req.owner_id,
            occurred_at_iso=req.occurred_at_iso,
        )
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        structured_log("ERROR", "cv_url_analysis_failed", job_id=req.job_id, error=str(exc))
        raise HTTPException(status_code=500, detail=f"CV pipeline failed: {exc}") from exc
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


@app.post("/api/v1/analyze-upload")
async def analyze_upload(
    video: UploadFile = File(...),
    job_id: str = Form(...),
    video_id: str = Form(...),
    project_id: str = Form("default"),
    location_id: str = Form("default"),
    owner_id: str = Form("worker"),
    occurred_at_iso: Optional[str] = Form(None),
    authorization: Optional[str] = Header(default=None),
):
    require_api_key(authorization)
    suffix = Path(video.filename or "upload.mp4").suffix.lower()
    if suffix not in ALLOWED_VIDEO_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Unsupported video extension. Use MP4, MOV, or WebM.")

    tmp_path: Optional[str] = None
    try:
        bytes_written = 0
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp_path = tmp.name
            while True:
                chunk = await video.read(1024 * 1024)
                if not chunk:
                    break
                bytes_written += len(chunk)
                if bytes_written > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=f"Uploaded video exceeds CV worker limit of {MAX_UPLOAD_MB} MB.",
                    )
                tmp.write(chunk)
        if bytes_written == 0:
            raise HTTPException(status_code=400, detail="Uploaded video file is empty.")

        return await asyncio.to_thread(
            run_cv_pipeline,
            source_path=tmp_path,
            job_id=job_id,
            video_id=video_id,
            project_id=project_id,
            location_id=location_id,
            owner_id=owner_id,
            occurred_at_iso=occurred_at_iso,
        )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        structured_log("ERROR", "cv_upload_analysis_failed", job_id=job_id, error=str(exc))
        raise HTTPException(status_code=500, detail=f"CV upload analysis failed: {exc}") from exc
    finally:
        await video.close()
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


@app.post("/api/v1/rtsp/probe")
def rtsp_probe(req: RtspProbeRequest, authorization: Optional[str] = Header(default=None)):
    require_api_key(authorization)
    if not req.rtsp_url.startswith(("rtsp://", "rtsps://")):
        raise HTTPException(status_code=400, detail="Only rtsp:// or rtsps:// stream URLs are permitted.")
    ok, meta, err = probe_rtsp_stream(req.rtsp_url)
    return {
        "connected": ok,
        "metadata": (
            {
                "width": meta.width,
                "height": meta.height,
                "fps": meta.fps,
            }
            if meta
            else None
        ),
        "error": err,
    }
