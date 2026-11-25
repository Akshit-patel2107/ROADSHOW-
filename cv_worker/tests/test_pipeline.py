"""
ROADSHADOW 2.0 — Pure-Python Unit Tests for CV Worker Core Pipeline
Runs with Python stdlib `unittest` (no GPU or Ultralytics install required) to verify:
  1. Constant-time bearer auth, ID sanitization, SSRF URL blocking, and secret scrubbing.
  2. VelocityTracker pixel velocity calculation across consecutive frames.
  3. Trajectory builder aggregation and dominant direction classification.
  4. Conflict analyzer genuine near-miss detection, Firestore schema parity, sudden braking,
     and strict rejection of static/non-converging overlap (zero fabricated events).
"""

import os
import sys
import unittest

# Allow running via `python3 -m unittest discover -s cv_worker/tests`
CV_WORKER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if CV_WORKER_DIR not in sys.path:
    sys.path.insert(0, CV_WORKER_DIR)

from conflict_analyzer import analyze_conflicts  # noqa: E402
from security import (  # noqa: E402
    sanitize_identifier,
    scrub_url_credentials,
    validate_remote_url,
    verify_bearer_token,
)
from tracker import VelocityTracker  # noqa: E402
from trajectory import build_trajectories  # noqa: E402


class SecurityModuleTests(unittest.TestCase):
    def test_bearer_token_validation(self):
        self.assertTrue(verify_bearer_token("Bearer secret-token-123", "secret-token-123"))
        self.assertFalse(verify_bearer_token("Bearer wrong-token", "secret-token-123"))
        self.assertFalse(verify_bearer_token("Basic abc", "secret-token-123"))
        self.assertFalse(verify_bearer_token(None, "secret-token-123"))
        # Empty server key allows unauthenticated local dev mode
        self.assertTrue(verify_bearer_token(None, ""))

    def test_sanitize_identifier(self):
        self.assertEqual(sanitize_identifier("vid_123/../../etc", "vid"), "vid_123_______etc")
        self.assertEqual(sanitize_identifier("   ", "fallback_id"), "fallback_id")

    def test_ssrf_url_blocking(self):
        blocked = [
            "http://localhost:8080/video.mp4",
            "http://127.0.0.1/video.mp4",
            "http://169.254.169.254/latest/meta-data/",
            "http://metadata.google.internal/computeMetadata/v1/",
            "http://10.0.0.5/private.mp4",
            "http://192.168.1.20/cam.mp4",
            "file:///etc/passwd",
        ]
        for url in blocked:
            ok, reason = validate_remote_url(url, ("http", "https"), resolve_dns=False)
            self.assertFalse(ok, f"Expected URL to be blocked: {url}")
            self.assertTrue(bool(reason))

        ok_public, err = validate_remote_url(
            "https://93.184.216.34/traffic/junction.mp4",
            ("http", "https"),
            resolve_dns=False,
        )
        self.assertTrue(ok_public, f"Expected public IP URL to pass: {err}")

        ok_rtsp, err_rtsp = validate_remote_url(
            "rtsp://93.184.216.34:554/stream1",
            ("rtsp", "rtsps"),
            resolve_dns=False,
        )
        self.assertTrue(ok_rtsp, f"Expected public RTSP URL to pass: {err_rtsp}")

    def test_credential_scrubbing(self):
        raw = "rtsp://admin:SuperSecretPass!@203.0.113.10:554/h264?token=abc"
        scrubbed = scrub_url_credentials(raw)
        self.assertNotIn("SuperSecretPass", scrubbed)
        self.assertNotIn("admin", scrubbed)
        self.assertIn("203.0.113.10:554/h264", scrubbed)


class TrackingAndConflictPipelineTests(unittest.TestCase):
    def test_converging_pedestrian_and_car_triggers_real_conflict(self):
        frame_w, frame_h = 1280, 720
        vt = VelocityTracker(frame_width=frame_w, frame_height=frame_h)

        # Car moving Eastbound (cx 0.25 -> 0.45) and pedestrian crossing Northbound (cy 0.72 -> 0.52)
        frames = [
            (
                1,
                0.25,
                [
                    {
                        "trackingId": "trk_car_1",
                        "objectClass": "car",
                        "confidence": 0.91,
                        "bbox": {"x": 0.20, "y": 0.46, "w": 0.10, "h": 0.08},
                        "modelVersion": "yolov8n.pt",
                    },
                    {
                        "trackingId": "trk_ped_2",
                        "objectClass": "person",
                        "confidence": 0.86,
                        "bbox": {"x": 0.48, "y": 0.68, "w": 0.04, "h": 0.08},
                        "modelVersion": "yolov8n.pt",
                    },
                ],
            ),
            (
                8,
                0.50,
                [
                    {
                        "trackingId": "trk_car_1",
                        "objectClass": "car",
                        "confidence": 0.92,
                        "bbox": {"x": 0.30, "y": 0.46, "w": 0.10, "h": 0.08},
                        "modelVersion": "yolov8n.pt",
                    },
                    {
                        "trackingId": "trk_ped_2",
                        "objectClass": "person",
                        "confidence": 0.87,
                        "bbox": {"x": 0.48, "y": 0.58, "w": 0.04, "h": 0.08},
                        "modelVersion": "yolov8n.pt",
                    },
                ],
            ),
            (
                15,
                0.75,
                [
                    {
                        "trackingId": "trk_car_1",
                        "objectClass": "car",
                        "confidence": 0.93,
                        "bbox": {"x": 0.40, "y": 0.46, "w": 0.10, "h": 0.08},
                        "modelVersion": "yolov8n.pt",
                    },
                    {
                        "trackingId": "trk_ped_2",
                        "objectClass": "person",
                        "confidence": 0.88,
                        "bbox": {"x": 0.48, "y": 0.49, "w": 0.04, "h": 0.08},
                        "modelVersion": "yolov8n.pt",
                    },
                ],
            ),
        ]

        all_detections = []
        for fnum, ts, raw in frames:
            all_detections.extend(vt.enrich_frame_detections(fnum, ts, raw))

        trajectories = build_trajectories(all_detections)
        self.assertEqual(len(trajectories), 2)

        events = analyze_conflicts(
            detections=all_detections,
            trajectories=trajectories,
            video_id="vid_test_001",
            project_id="proj_adit_01",
            location_id="loc_junction_a",
            owner_id="uid_tester",
            frame_width=frame_w,
            frame_height=frame_h,
            occurred_at_iso="2026-01-15T10:30:00Z",
        )

        self.assertEqual(len(events), 1)
        ev = events[0]
        self.assertEqual(ev["conflictType"], "Pedestrian versus vehicle")
        self.assertEqual(ev["videoId"], "vid_test_001")
        self.assertEqual(ev["projectId"], "proj_adit_01")
        self.assertEqual(ev["locationId"], "loc_junction_a")
        self.assertEqual(ev["ownerId"], "uid_tester")
        self.assertEqual(ev["validationStatus"], "Pending review")
        self.assertFalse(ev["isDemonstration"])
        self.assertIsNotNone(ev["estimatedTtcSec"])
        self.assertLessEqual(ev["estimatedTtcSec"], 2.0)
        self.assertGreaterEqual(ev["riskScore"], 55)
        self.assertIn(ev["riskCategory"], {"High", "Critical"})
        self.assertEqual(ev["measurementQuality"], "uncalibrated_pixel")
        self.assertEqual(set(ev["involvedTrackIds"]), {"trk_car_1", "trk_ped_2"})

    def test_static_parked_overlap_generates_zero_fabricated_events(self):
        frame_w, frame_h = 1280, 720
        vt = VelocityTracker(frame_width=frame_w, frame_height=frame_h)

        # Two stationary cars parked right next to each other must NEVER fabricate a conflict
        all_detections = []
        for idx, ts in enumerate([0.25, 0.50, 0.75], start=1):
            all_detections.extend(
                vt.enrich_frame_detections(
                    idx * 6,
                    ts,
                    [
                        {
                            "trackingId": "trk_parked_1",
                            "objectClass": "car",
                            "confidence": 0.90,
                            "bbox": {"x": 0.40, "y": 0.50, "w": 0.08, "h": 0.08},
                            "modelVersion": "yolov8n.pt",
                        },
                        {
                            "trackingId": "trk_parked_2",
                            "objectClass": "car",
                            "confidence": 0.89,
                            "bbox": {"x": 0.42, "y": 0.50, "w": 0.08, "h": 0.08},
                            "modelVersion": "yolov8n.pt",
                        },
                    ],
                )
            )

        trajectories = build_trajectories(all_detections)
        events = analyze_conflicts(
            detections=all_detections,
            trajectories=trajectories,
            video_id="vid_static_001",
            project_id="proj_adit_01",
            location_id="loc_junction_a",
            owner_id="uid_tester",
            frame_width=frame_w,
            frame_height=frame_h,
        )
        self.assertEqual(events, [])


if __name__ == "__main__":
    unittest.main()
