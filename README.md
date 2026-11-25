# ROADSHADOW 2.0

**AI Road Safety Intelligence & Junction Improvement Platform**  
*See the Risk Before the Accident.*

Developed by **TEAM ADIT** (**Akshit Patel** & **Shah Darshil**) for the National Innovation Competition.

---

## 1. Overview

ROADSHADOW 2.0 transforms ordinary urban road-camera footage into preventive road-safety intelligence for Indian municipalities, traffic police departments, smart-city authorities, and transport researchers. Instead of waiting for reported accidents, ROADSHADOW detects near-miss interactions, clusters recurring **Conflict Fingerprints**, and lets engineers compare proposed junction layout upgrades inside the **Junction Improvement Lab**.

### Key Capabilities in Version 2.0

- **Project Management & Persistent Workspace (`/projects`, `/projects/:projectId`)**: Create, edit, search, filter, paginate, delete (with cascade cleanup), and resume road-safety projects across page refreshes and logins, attach or remove video footage, and retain per-project camera selections.
- **Road Camera & Source Selection Module (`/cameras`)**: Unified 4-mode source picker supporting Registered Road Cameras, Uploaded Road Footage, Server-Isolated Live RTSP Configuration (actively probed via the CV worker — never falsely claiming connected), and clearly labelled Demo Camera Mode with honest `Start Analysis` availability gating.
- **Reliable Video Upload & Job Pipeline (`/upload`)**: Format/size and `ffprobe`/`ffmpeg` integrity validation (MP4, MOV, WebM), real resolution/FPS/duration/thumbnail extraction, client-side `<video>` preview, authenticated upload progress bar, retry CV analysis without re-uploading, duplicate file checks, and disk-persisted processing job history (`GET /api/processing/jobs`).
- **Trajectory & Near-Miss Analysis Engine (`/video-analysis`)**: Synchronized frame-level bounding boxes, tracked movement trajectory polylines, pre/post-event conflict clip replay (`-2.5s` / `+2.5s`), Indian mixed-traffic classes (`person`, `bicycle`, `motorcycle`, `scooter`, `car`, `auto_rickshaw`, `bus`, `truck`), Time-to-Collision (TTC), Post-Encroachment Time (PET), sudden evasive maneuver detection, and `Potential conflict` vs `Near miss` classification.
- **ROADSHADOW Conflict Fingerprints (`/fingerprints`)**: Groups recurring conflicts by location, time window, conflict zone, movement direction, and road-user pairing (while clearly showing non-recurring single-observation events), with a **Verified Events Only** filter and direct Replay links to supporting video evidence.
- **Junction Improvement Lab (`/improvement-lab`)**: Interactive engineering sandbox with 7 IRC-aligned interventions, live SVG layout schematic, Existing vs Proposed metric comparison, SUMO microsimulation adapter status, and one-click saving to Safety Recommendations.
- **Automated Safety Reports (`/reports`)**: Multi-section municipal audit PDF export (`jsPDF`), plus CSV, JSON, Print, and optional server-side Gemini executive summaries.
- **Role-Based Access Control & Audit Trails**: Cloud Firestore security rules and server-side Firebase RS256 ID token verification separating Administrator, Analyst, and Viewer roles alongside a sandboxed Demonstration Mode (Anand Road Safety Pilot).

---

## 2. Architecture

| Layer | Technology |
| --- | --- |
| Frontend | React 19, TypeScript, Vite, Tailwind CSS, React Router, Recharts, Leaflet, jsPDF |
| Backend API | Express (`server.ts`), Multer + `ffprobe`/`ffmpeg` video inspection, Firebase RS256 auth, Zod, `@google/genai` |
| Database & Auth | Firebase Authentication + Cloud Firestore (`firestore.rules`, `firebase-blueprint.json`) |
| Modular CV Worker (`/cv_worker/`) | FastAPI + OpenCV + YOLO + ByteTrack + TTC/PET trajectory engine (`CV_SERVICE_URL`) |
| Optional Traffic Sim | External SUMO microsimulation worker via `SUMO_SERVICE_URL` |

---

## 3. Environment Configuration

Copy `.env.example` and configure the following environment variables as needed:

```bash
GEMINI_API_KEY="MY_GEMINI_API_KEY"
APP_URL="MY_APP_URL"
MAX_UPLOAD_MB="250"

# External Python FastAPI + YOLO/ByteTrack worker (see /cv_worker/README.md)
CV_SERVICE_URL=""
CV_SERVICE_API_KEY=""
CV_SERVICE_TIMEOUT_MS="180000"

# Optional external SUMO microsimulation worker
SUMO_SERVICE_URL=""
```

- When `CV_SERVICE_URL` is unset or unreachable, ROADSHADOW honestly reports `CV Worker: Not Configured / Unavailable`, preserves the uploaded video in the project for playback and later retry, and **never** silently fabricates fake detections or conflicts in Real Analysis mode. Use Demonstration Mode to inspect the curated Anand Road Safety Pilot dataset.
- When `SUMO_SERVICE_URL` is unset, the Junction Improvement Lab runs its deterministic **IRC Analytical Estimator** and labels all outputs as **Simulation Estimate Only**.
- Live RTSP credentials submitted in Camera Management are stored exclusively in per-user server-side memory (`POST /api/cameras/rtsp-config`), probed via `${CV_SERVICE_URL}/api/v1/rtsp/probe`, and never written to Firestore or returned to the browser.

---

## 4. Local Development & Testing

```bash
# Install dependencies
npm install

# Run pure engine unit tests & Firestore security rules tests
npx --yes tsx --test src/engine/engine.test.ts firestore.rules.test.ts

# Validate Firestore security rules with ESLint
npx eslint firestore.rules

# Start full-stack dev server on port 3000
npm run dev

# Build for production
npm run build
```

---

## 5. Scientific Integrity & Limitations

- **Provisional Risk Scores (0–100)** are heuristic indicators combining surrogate proximity (TTC, PET), relative speed, convergence angle, evasive movement, and road-user vulnerability. They are **not** calibrated statistical probabilities of a crash.
- **Detection Confidence** is always reported separately from Risk Score.
- **Human-in-the-Loop Verification**: Original AI classifications are preserved alongside analyst verification status (`Pending review`, `Verified`, `False positive`, `Uncertain`, `Under investigation`).
- **Simulation Caveat**: Junction Improvement Lab comparisons are analytical simulation estimates intended to prioritize municipal field audits, not guaranteed post-construction outcomes.
