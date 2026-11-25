# ROADSHADOW 2.0 — Python Computer Vision Microservice (`cv_worker`)

Standalone Python FastAPI + OpenCV + Ultralytics YOLO + ByteTrack service that powers **Real Analysis** in ROADSHADOW 2.0.

> **Important:** The AI Studio Node.js runtime does not ship `pip` or Python ML wheels (`torch`, `ultralytics`, `opencv-python-headless`). Deploy this directory externally (for example, to **Google Cloud Run** or any Docker/GPU host), then set `CV_SERVICE_URL` (and `CV_SERVICE_API_KEY`) in ROADSHADOW's environment secrets.

---

## 1. Exact API Contract (Matched with `/server.ts`)

| Endpoint | Method | Auth | Purpose |
| :--- | :--- | :--- | :--- |
| `/health` | `GET` | Public | Verifies process liveness, YOLO weight readiness (`model_ready`), `model_version`, `tracker`, `device`, `sample_fps`, `max_upload_mb`. |
| `/api/v1/analyze-upload` | `POST` (`multipart/form-data`) | `Authorization: Bearer <CV_SERVICE_API_KEY>` (when key set) | Primary endpoint called by `/server.ts`. Accepts `video` file + `job_id`, `video_id`, `project_id`, `location_id`, `owner_id`, `occurred_at_iso`. |
| `/api/v1/analyze` | `POST` (`application/json`) | Bearer token | Downloads an SSRF-validated public `http(s)://` traffic video URL (no redirects, size-capped) and runs the same YOLO + ByteTrack pipeline. |
| `/api/v1/rtsp/probe` | `POST` (`application/json`) | Bearer token | Probes an SSRF-validated `rtsp://` or `rtsps://` traffic camera stream over TCP via OpenCV with a 5s timeout. |

### Response Schema (`/api/v1/analyze-upload` and `/api/v1/analyze`)
```json
{
  "job_id": "job_...",
  "model_version": "yolov8n.pt+ByteTrack",
  "tracker": "ByteTrack",
  "device": "cpu",
  "video_metadata": {
    "width": 1280,
    "height": 720,
    "fps": 30.0,
    "total_frames": 900,
    "duration_sec": 30.0
  },
  "analyzed_frames": 120,
  "processing_time_ms": 8420,
  "detections": [],
  "trajectories": [],
  "events": [],
  "warnings": []
}
```
- All conflict `events` match `ConflictEvent` in `/src/types/roadshadow.ts` and `/firestore.rules` with `isDemonstration: false` and `measurementQuality: "uncalibrated_pixel"`.
- Zero detections or events are ever fabricated: if no converging close-proximity road-user pairs exceed conflict thresholds, `events` is `[]` with an explanatory warning.

---

## 2. Dependencies

- **System packages (installed in `Dockerfile`)**: `ffmpeg`, `libgl1`, `libglib2.0-0`, `libsm6`, `libxext6`
- **Python 3.11+ packages (`requirements.txt`)**:
  - `torch`, `torchvision` (CPU wheels in `Dockerfile`, or CUDA wheels on GPU hosts)
  - `ultralytics>=8.3.0` (YOLO detection + built-in ByteTrack tracker)
  - `lapx>=0.5.9` (linear assignment solver used by ByteTrack)
  - `opencv-python-headless>=4.10.0.84`
  - `fastapi>=0.115.0`, `uvicorn[standard]>=0.32.0`, `python-multipart>=0.0.12`
  - `httpx>=0.27.0`, `numpy>=1.26.4`, `pydantic>=2.9.0`

---

## 3. Deploy to Google Cloud Run (Recommended)

```bash
cd cv_worker

# 1. Authenticate and choose your GCP project
gcloud auth login
export GCP_PROJECT_ID="your-gcp-project-id"
export GCP_REGION="asia-southeast1"

# 2. Generate a strong shared API key
export CV_SERVICE_API_KEY="$(openssl rand -hex 32)"
echo "Save this key for ROADSHADOW secrets: ${CV_SERVICE_API_KEY}"

# 3. Build container and deploy to Cloud Run (2 vCPU, 4 GiB RAM, 300s timeout)
bash deploy-cloudrun.sh
```

The script prints your deployed `SERVICE_URL` and automatically curls `${SERVICE_URL}/health` to confirm `model_ready: true`.

---

## 4. Connect to ROADSHADOW 2.0

In **AI Studio Secrets** (or your Node deployment environment), set:
```env
CV_SERVICE_URL="https://roadshadow-cv-worker-xxxxxxxxxx.a.run.app"
CV_SERVICE_API_KEY="<the key you generated above>"
CV_SERVICE_TIMEOUT_MS="120000"
CV_MAX_RETRIES="2"
```

---

## 5. Run Locally via Docker (Optional)

```bash
cd cv_worker
docker build -t roadshadow-cv-worker .
docker run --rm -p 8080:8080 \
  -e CV_SERVICE_API_KEY="dev-local-key" \
  roadshadow-cv-worker

# Health check
curl http://localhost:8080/health

# Test with a real traffic video
curl -X POST http://localhost:8080/api/v1/analyze-upload \
  -H "Authorization: Bearer dev-local-key" \
  -F "video=@/path/to/real-traffic-clip.mp4" \
  -F "job_id=job_test_01" \
  -F "video_id=vid_test_01" \
  -F "project_id=proj_test_01" \
  -F "location_id=loc_test_01" \
  -F "owner_id=tester"
```

---

## 6. Run Unit Tests

```bash
python3 -m unittest discover -s cv_worker/tests -v
```
