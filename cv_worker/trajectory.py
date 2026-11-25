"""
ROADSHADOW 2.0 — CV Worker Trajectory Builder Module
Aggregates frame-level tracked detections into structured road-user trajectories
with dominant movement direction labels and average tracking confidence.
"""

from collections import defaultdict
from typing import Any, Dict, List


def classify_direction_label(dx: float, dy: float) -> str:
    if abs(dx) < 0.02 and abs(dy) < 0.02:
        return "Stationary / Low motion"
    if abs(dx) >= abs(dy):
        return "Westbound to Eastbound" if dx > 0 else "Eastbound to Westbound"
    return "Northbound to Southbound" if dy > 0 else "Southbound to Northbound"


def build_trajectories(detections: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    by_track: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for det in detections:
        by_track[det["trackingId"]].append(det)

    trajectories: List[Dict[str, Any]] = []
    for track_id, items in by_track.items():
        items.sort(key=lambda d: d["frameNumber"])
        if len(items) < 2:
            continue

        positions = [
            {
                "frameNumber": item["frameNumber"],
                "timestampSec": item["timestampSec"],
                "cx": round(item["bbox"]["x"] + item["bbox"]["w"] / 2.0, 4),
                "cy": round(item["bbox"]["y"] + item["bbox"]["h"] / 2.0, 4),
            }
            for item in items
        ]

        first = positions[0]
        last = positions[-1]
        dx = last["cx"] - first["cx"]
        dy = last["cy"] - first["cy"]
        avg_conf = sum(float(i["confidence"]) for i in items) / len(items)

        trajectories.append(
            {
                "trackingId": track_id,
                "objectClass": items[0]["objectClass"],
                "firstFrame": items[0]["frameNumber"],
                "lastFrame": items[-1]["frameNumber"],
                "trackingConfidence": round(avg_conf, 3),
                "positions": positions,
                "directionLabel": classify_direction_label(dx, dy),
            }
        )

    trajectories.sort(key=lambda t: t["firstFrame"])
    return trajectories
