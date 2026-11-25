"""
ROADSHADOW 2.0 — CV Worker Road-User Detector Module
Wraps Ultralytics YOLO + ByteTrack inference, normalizes Indian urban road-user
classes, and resets tracker state cleanly between videos to prevent track ID bleed.
"""

from typing import Any, Dict, List, Optional
import logging
import os

try:
    import numpy as np
except ImportError:  # pragma: no cover
    np = None  # type: ignore[assignment]

try:
    import torch
except ImportError:  # pragma: no cover
    torch = None  # type: ignore[assignment]

try:
    from ultralytics import YOLO
except ImportError:  # pragma: no cover - optional in non-Python-CV containers
    YOLO = None  # type: ignore[assignment]

logger = logging.getLogger("roadshadow.cv.detector")

# Standard COCO classes plus common custom Indian traffic model aliases
COCO_CLASS_MAP: Dict[int, str] = {
    0: "person",
    1: "bicycle",
    2: "car",
    3: "motorcycle",
    5: "bus",
    7: "truck",
}

NAME_ALIAS_MAP: Dict[str, str] = {
    "person": "person",
    "pedestrian": "person",
    "bicycle": "bicycle",
    "cycle": "bicycle",
    "motorcycle": "motorcycle",
    "motorbike": "motorcycle",
    "two_wheeler": "motorcycle",
    "scooter": "scooter",
    "scooty": "scooter",
    "car": "car",
    "suv": "car",
    "van": "car",
    "bus": "bus",
    "truck": "truck",
    "lorry": "truck",
    "auto": "auto_rickshaw",
    "auto_rickshaw": "auto_rickshaw",
    "autorickshaw": "auto_rickshaw",
    "rickshaw": "auto_rickshaw",
    "tuk_tuk": "auto_rickshaw",
}


class RoadUserDetector:
    def __init__(
        self,
        model_path: Optional[str] = None,
        conf_threshold: float = 0.30,
        tracker_cfg: Optional[str] = None,
        device: Optional[str] = None,
    ):
        self.model_path = model_path or os.getenv("YOLO_MODEL_PATH", "yolov8n.pt")
        self.conf_threshold = conf_threshold
        self.tracker_cfg = tracker_cfg or os.getenv("CV_TRACKER_CONFIG", "bytetrack.yaml")
        self.device = device or os.getenv("YOLO_DEVICE", "").strip() or self._detect_device()
        self.model = None
        self.model_version = f"Ultralytics-{os.path.basename(self.model_path)}"

        if YOLO is not None:
            logger.info("Loading YOLO model %s on device=%s", self.model_path, self.device)
            self.model = YOLO(self.model_path)

    @staticmethod
    def _detect_device() -> str:
        if torch is not None and torch.cuda.is_available():
            return "cuda:0"
        return "cpu"

    @property
    def is_ready(self) -> bool:
        return self.model is not None

    def reset_tracker(self) -> None:
        """
        Clear Ultralytics ByteTrack state before processing a new video so track IDs
        and Kalman filters never leak from one video job into the next.
        """
        if self.model is None:
            return
        predictor = getattr(self.model, "predictor", None)
        if predictor is not None and hasattr(predictor, "trackers"):
            for trk in predictor.trackers or []:
                if hasattr(trk, "reset"):
                    trk.reset()
            predictor.trackers = []

    def normalize_class(self, class_id: int, raw_name: Optional[str] = None) -> Optional[str]:
        if raw_name:
            key = raw_name.strip().lower().replace(" ", "_").replace("-", "_")
            if key in NAME_ALIAS_MAP:
                return NAME_ALIAS_MAP[key]
        return COCO_CLASS_MAP.get(class_id)

    def track_frame(
        self,
        frame: Any,
        tracker_cfg: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """
        Run YOLO detection + ByteTrack persistent tracking on a single BGR frame.
        Returns normalized bounding boxes in [0..1] coordinate space.
        """
        if self.model is None:
            raise RuntimeError(
                "Ultralytics YOLO model is not loaded. Install ultralytics and configure YOLO_MODEL_PATH."
            )

        height, width = frame.shape[:2]
        if width <= 0 or height <= 0:
            return []

        results = self.model.track(
            frame,
            persist=True,
            tracker=tracker_cfg or self.tracker_cfg,
            conf=self.conf_threshold,
            device=self.device,
            verbose=False,
        )
        if not results:
            return []

        res = results[0]
        boxes = getattr(res, "boxes", None)
        if boxes is None or len(boxes) == 0:
            return []

        names = getattr(res, "names", {}) or {}
        xyxy_list = boxes.xyxy.cpu().tolist()
        cls_list = boxes.cls.cpu().tolist()
        conf_list = boxes.conf.cpu().tolist()
        id_list = boxes.id.cpu().tolist() if boxes.id is not None else [None] * len(xyxy_list)

        frame_detections: List[Dict[str, Any]] = []
        for idx, (coords, cls_raw, conf_raw, track_raw) in enumerate(
            zip(xyxy_list, cls_list, conf_list, id_list)
        ):
            cls_id = int(cls_raw)
            raw_name = names.get(cls_id) if isinstance(names, dict) else None
            mapped = self.normalize_class(cls_id, raw_name)
            if not mapped:
                continue

            x1, y1, x2, y2 = coords
            x1_clamped = max(0.0, min(float(width), float(x1)))
            y1_clamped = max(0.0, min(float(height), float(y1)))
            x2_clamped = max(x1_clamped, min(float(width), float(x2)))
            y2_clamped = max(y1_clamped, min(float(height), float(y2)))

            w_norm = (x2_clamped - x1_clamped) / width
            h_norm = (y2_clamped - y1_clamped) / height
            if w_norm <= 0.002 or h_norm <= 0.002:
                continue

            track_id = f"TRK-{int(track_raw)}" if track_raw is not None else f"DET-{idx + 1}"
            frame_detections.append(
                {
                    "trackingId": track_id,
                    "objectClass": mapped,
                    "confidence": round(float(conf_raw), 3),
                    "bbox": {
                        "x": round(x1_clamped / width, 4),
                        "y": round(y1_clamped / height, 4),
                        "w": round(w_norm, 4),
                        "h": round(h_norm, 4),
                    },
                    "modelVersion": self.model_version,
                }
            )

        return frame_detections
