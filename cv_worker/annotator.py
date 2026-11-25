"""
ROADSHADOW 2.0 — CV Worker Optional Video Annotator Module
Renders bounding boxes, persistent track IDs, and conflict indicators onto an
output MP4 file using OpenCV when annotated video export is requested.
"""

from collections import defaultdict
from typing import Any, Dict, List
import cv2


CLASS_COLORS_BGR = {
    "person": (68, 72, 229),
    "bicycle": (8, 179, 234),
    "motorcycle": (22, 115, 249),
    "scooter": (22, 115, 249),
    "car": (255, 133, 37),
    "bus": (246, 130, 59),
    "truck": (197, 94, 34),
    "auto_rickshaw": (94, 197, 34),
}


def render_annotated_video(
    source_path: str,
    output_path: str,
    detections: List[Dict[str, Any]],
) -> str:
    cap = cv2.VideoCapture(source_path)
    if not cap.isOpened():
        raise RuntimeError(f"Could not open source video for annotation: {source_path}")

    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 1280)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 720)
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 25.0)
    if fps <= 0 or fps > 240:
        fps = 25.0

    by_frame: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
    for det in detections:
        by_frame[int(det["frameNumber"])].append(det)

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(output_path, fourcc, fps, (width, height))
    try:
        frame_idx = 0
        last_boxes: List[Dict[str, Any]] = []
        while True:
            ok, frame = cap.read()
            if not ok or frame is None:
                break
            if frame_idx in by_frame:
                last_boxes = by_frame[frame_idx]
            for det in last_boxes:
                bbox = det["bbox"]
                x1 = int(bbox["x"] * width)
                y1 = int(bbox["y"] * height)
                x2 = int((bbox["x"] + bbox["w"]) * width)
                y2 = int((bbox["y"] + bbox["h"]) * height)
                color = CLASS_COLORS_BGR.get(det["objectClass"], (255, 181, 69))
                cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
                label = f"{det['trackingId']} {det['objectClass']} {int(det['confidence'] * 100)}%"
                cv2.putText(
                    frame,
                    label,
                    (x1, max(16, y1 - 6)),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.48,
                    color,
                    1,
                    cv2.LINE_AA,
                )
            writer.write(frame)
            frame_idx += 1
    finally:
        cap.release()
        writer.release()

    return output_path
