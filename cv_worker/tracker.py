"""
ROADSHADOW 2.0 — CV Worker Velocity & Track Continuity Module
Enriches ByteTrack detections with image-plane pixel velocity vectors (px/s)
so downstream trajectory and conflict analysis can compute closing speeds & TTC.
"""

from typing import Any, Dict, List, Tuple


class VelocityTracker:
    def __init__(self, frame_width: int, frame_height: int):
        self.frame_width = max(1, frame_width)
        self.frame_height = max(1, frame_height)
        # trackingId -> (timestamp_sec, cx_px, cy_px)
        self._last_state: Dict[str, Tuple[float, float, float]] = {}

    def enrich_frame_detections(
        self,
        frame_number: int,
        timestamp_sec: float,
        raw_detections: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        enriched: List[Dict[str, Any]] = []
        for det in raw_detections:
            bbox = det["bbox"]
            cx_px = (bbox["x"] + bbox["w"] / 2.0) * self.frame_width
            cy_px = (bbox["y"] + bbox["h"] / 2.0) * self.frame_height
            track_id = det["trackingId"]

            vx = 0.0
            vy = 0.0
            prev = self._last_state.get(track_id)
            if prev is not None:
                prev_t, prev_cx, prev_cy = prev
                dt = timestamp_sec - prev_t
                if dt > 0.01:
                    vx = round((cx_px - prev_cx) / dt, 2)
                    vy = round((cy_px - prev_cy) / dt, 2)

            self._last_state[track_id] = (timestamp_sec, cx_px, cy_px)
            enriched.append(
                {
                    "frameNumber": frame_number,
                    "timestampSec": timestamp_sec,
                    "trackingId": track_id,
                    "objectClass": det["objectClass"],
                    "confidence": det["confidence"],
                    "bbox": bbox,
                    "velocityPxPerSec": {"vx": vx, "vy": vy},
                    "modelVersion": det["modelVersion"],
                }
            )
        return enriched
