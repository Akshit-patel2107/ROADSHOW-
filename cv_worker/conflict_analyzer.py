"""
ROADSHADOW 2.0 — CV Worker Conflict Detection & Provisional Risk Scoring Module
Evaluates tracked road-user trajectories for genuine motion-based potential
conflicts using closing velocity, TTC, Post-Encroachment Time (PET), spatial
separation, convergence angle, and evasive maneuver indicators.
Static bounding-box overlap without closing motion is explicitly rejected.
"""

from collections import defaultdict
from datetime import datetime, timezone
import math
from typing import Any, Dict, List, Optional, Tuple

from security import sanitize_identifier


VRU_CLASSES = {"person", "bicycle", "motorcycle", "scooter"}


def estimate_pet_sec(
    traj_a: Dict[str, Any],
    traj_b: Dict[str, Any],
    frame_width: int,
    frame_height: int,
    zone_radius_px: float = 55.0,
) -> Optional[float]:
    min_pet: Optional[float] = None
    for pa in traj_a.get("positions", []):
        ax = pa["cx"] * frame_width
        ay = pa["cy"] * frame_height
        for pb in traj_b.get("positions", []):
            bx = pb["cx"] * frame_width
            by = pb["cy"] * frame_height
            dist = math.hypot(ax - bx, ay - by)
            if dist <= zone_radius_px:
                dt = abs(float(pa["timestampSec"]) - float(pb["timestampSec"]))
                if 0.05 < dt <= 4.0 and (min_pet is None or dt < min_pet):
                    min_pet = dt
    return round(min_pet, 2) if min_pet is not None else None


def detect_evasive_maneuver(traj: Dict[str, Any]) -> Tuple[bool, bool]:
    """
    Inspect trajectory curvature and step-to-step deceleration.
    Returns (evasive_detected, sudden_braking_detected).
    """
    pts = traj.get("positions", [])
    if len(pts) < 3:
        return False, False
    evasive = False
    sudden_braking = False
    for i in range(1, len(pts) - 1):
        v1x = pts[i]["cx"] - pts[i - 1]["cx"]
        v1y = pts[i]["cy"] - pts[i - 1]["cy"]
        v2x = pts[i + 1]["cx"] - pts[i]["cx"]
        v2y = pts[i + 1]["cy"] - pts[i]["cy"]
        m1 = math.hypot(v1x, v1y)
        m2 = math.hypot(v2x, v2y)
        if m1 < 0.008 or m2 < 0.004:
            continue
        cos_theta = max(-1.0, min(1.0, (v1x * v2x + v1y * v2y) / (m1 * m2)))
        angle_deg = math.degrees(math.acos(cos_theta))
        decel_ratio = (m1 - m2) / m1
        if angle_deg >= 32.0 or decel_ratio >= 0.45:
            evasive = True
        if decel_ratio >= 0.55 and angle_deg < 25.0:
            sudden_braking = True
    return evasive, sudden_braking


def classify_conflict_type(
    cls_a: str,
    cls_b: str,
    angle_deg: float,
    sudden_braking: bool = False,
) -> str:
    pair = {cls_a, cls_b}
    if "person" in pair and len(pair) > 1:
        return "Pedestrian versus vehicle"
    if ("motorcycle" in pair or "scooter" in pair) and bool(
        {"car", "bus", "truck", "auto_rickshaw"} & pair
    ):
        return "Motorcycle versus turning car" if angle_deg >= 45.0 else "Unsafe merging"
    if angle_deg >= 145.0:
        return "Wrong-direction movement"
    if sudden_braking and angle_deg < 25.0:
        return "Sudden braking"
    if angle_deg >= 55.0:
        return "Crossing conflict"
    if angle_deg >= 20.0:
        return "Unsafe merging"
    return "Vehicle intersection conflict"


def compute_provisional_risk(
    ttc_sec: Optional[float],
    pet_sec: Optional[float],
    min_sep_px: float,
    rel_speed_px: float,
    angle_deg: float,
    evasive: bool,
    road_users: List[str],
) -> Tuple[int, str, str, List[str], List[str]]:
    score = 0.0
    factors: List[str] = []

    if ttc_sec is not None:
        if ttc_sec <= 1.2:
            score += 32
            factors.append(f"Low estimated time-to-collision (~{ttc_sec:.2f}s projected path intersection)")
        elif ttc_sec <= 2.2:
            score += 22
            factors.append(f"Moderate closing time-to-collision (~{ttc_sec:.2f}s)")
        else:
            score += 10

    if pet_sec is not None:
        if pet_sec <= 1.0:
            score += 14
            factors.append(f"Short Post-Encroachment Time (~{pet_sec:.2f}s shared zone occupancy)")
        elif pet_sec <= 2.0:
            score += 8
            factors.append(f"Elevated Post-Encroachment Time (~{pet_sec:.2f}s)")

    if min_sep_px <= 40:
        score += 22
        factors.append(f"Small estimated spatial clearance ({round(min_sep_px)} px in image plane)")
    elif min_sep_px <= 85:
        score += 14
        factors.append(f"Reduced spatial clearance ({round(min_sep_px)} px in image plane)")
    else:
        score += 6

    if rel_speed_px >= 140:
        score += 12
        factors.append(f"Elevated relative image-plane approach speed ({round(rel_speed_px)} px/s)")
    elif rel_speed_px >= 75:
        score += 7

    if angle_deg >= 50:
        score += 10
        factors.append(f"Intersecting trajectory convergence ({round(angle_deg)} deg crossing angle)")

    if evasive:
        score += 10
        factors.append("Evasive lateral shift or rapid deceleration observed in tracked trajectory")

    if any(u in VRU_CLASSES for u in road_users):
        score += 12
        factors.append("Vulnerable road user (pedestrian / cyclist / two-wheeler) involved in interaction")

    final_score = int(max(5, min(100, round(score))))
    if final_score >= 75:
        category = "Critical"
    elif final_score >= 55:
        category = "High"
    elif final_score >= 30:
        category = "Medium"
    else:
        category = "Low"

    is_near_miss = (
        (ttc_sec is not None and ttc_sec <= 1.8)
        or (pet_sec is not None and pet_sec <= 1.5)
        or (evasive and min_sep_px <= 65)
    )
    tier = "Near miss" if is_near_miss else "Potential conflict"

    limitations = [
        "Camera homography calibration not configured: clearances and speeds are pixel-space estimates, not physical meters or km/h.",
        "Risk score (0-100) uses provisional engineering triage bands and is not a validated accident probability.",
    ]
    return final_score, category, tier, factors, limitations


def analyze_conflicts(
    detections: List[Dict[str, Any]],
    trajectories: List[Dict[str, Any]],
    video_id: str,
    project_id: str,
    location_id: str,
    owner_id: str,
    frame_width: int,
    frame_height: int,
    occurred_at_iso: Optional[str] = None,
) -> List[Dict[str, Any]]:
    safe_video_id = sanitize_identifier(video_id, "vid")
    safe_project_id = sanitize_identifier(project_id, "proj")
    safe_location_id = sanitize_identifier(location_id, "loc")
    safe_owner_id = sanitize_identifier(owner_id, "owner")

    traj_map = {t["trackingId"]: t for t in trajectories}
    by_frame: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
    for det in detections:
        by_frame[int(det["frameNumber"])].append(det)

    best_by_pair: Dict[str, Dict[str, Any]] = {}
    now_iso = datetime.now(timezone.utc).isoformat()
    occurred_at = (occurred_at_iso or now_iso)[:64]

    for frame_num in sorted(by_frame.keys()):
        items = by_frame[frame_num]
        if len(items) < 2:
            continue

        for i in range(len(items)):
            for j in range(i + 1, len(items)):
                a = items[i]
                b = items[j]
                if a["trackingId"] == b["trackingId"]:
                    continue

                va = a.get("velocityPxPerSec") or {"vx": 0.0, "vy": 0.0}
                vb = b.get("velocityPxPerSec") or {"vx": 0.0, "vy": 0.0}

                ax = (a["bbox"]["x"] + a["bbox"]["w"] / 2.0) * frame_width
                ay = (a["bbox"]["y"] + a["bbox"]["h"] / 2.0) * frame_height
                bx = (b["bbox"]["x"] + b["bbox"]["w"] / 2.0) * frame_width
                by = (b["bbox"]["y"] + b["bbox"]["h"] / 2.0) * frame_height

                dx = bx - ax
                dy = by - ay
                dist_px = math.hypot(dx, dy)
                if dist_px > 165.0:
                    continue

                rvx = float(vb["vx"]) - float(va["vx"])
                rvy = float(vb["vy"]) - float(va["vy"])
                rel_speed = math.hypot(rvx, rvy)
                # Reject static overlap with no meaningful relative motion
                if rel_speed < 28.0:
                    continue

                closing_rate = -(dx * rvx + dy * rvy) / max(dist_px, 1.0)
                if closing_rate <= 12.0:
                    continue

                ttc_sec = round(dist_px / closing_rate, 2) if closing_rate > 0 else None
                if ttc_sec is not None and ttc_sec > 3.5:
                    continue

                mag_a = math.hypot(float(va["vx"]), float(va["vy"]))
                mag_b = math.hypot(float(vb["vx"]), float(vb["vy"]))
                if mag_a > 5.0 and mag_b > 5.0:
                    cos_ang = max(
                        -1.0,
                        min(
                            1.0,
                            (float(va["vx"]) * float(vb["vx"]) + float(va["vy"]) * float(vb["vy"]))
                            / (mag_a * mag_b),
                        ),
                    )
                    angle_deg = round(math.degrees(math.acos(cos_ang)), 1)
                else:
                    angle_deg = 60.0

                pair_key = "::".join(sorted([a["trackingId"], b["trackingId"]]))
                prev = best_by_pair.get(pair_key)
                if prev is not None and prev["estimatedMinSeparationPx"] <= dist_px:
                    continue

                traj_a = traj_map.get(a["trackingId"])
                traj_b = traj_map.get(b["trackingId"])
                pet_sec = (
                    estimate_pet_sec(traj_a, traj_b, frame_width, frame_height)
                    if traj_a and traj_b
                    else None
                )
                ev_a, brake_a = detect_evasive_maneuver(traj_a) if traj_a else (False, False)
                ev_b, brake_b = detect_evasive_maneuver(traj_b) if traj_b else (False, False)
                evasive = ev_a or ev_b
                sudden_braking = brake_a or brake_b

                road_users = [a["objectClass"], b["objectClass"]]
                conflict_type = classify_conflict_type(
                    a["objectClass"],
                    b["objectClass"],
                    angle_deg,
                    sudden_braking=sudden_braking,
                )
                risk_score, risk_cat, tier, factors, limitations = compute_provisional_risk(
                    ttc_sec=ttc_sec,
                    pet_sec=pet_sec,
                    min_sep_px=dist_px,
                    rel_speed_px=rel_speed,
                    angle_deg=angle_deg,
                    evasive=evasive,
                    road_users=road_users,
                )

                conf = round((float(a["confidence"]) + float(b["confidence"])) / 2.0, 3)
                direction = (
                    f"{traj_a['directionLabel']} vs {traj_b['directionLabel']}"
                    if traj_a and traj_b
                    else "Intersecting movement"
                )
                best_by_pair[pair_key] = {
                    "id": sanitize_identifier(f"evt_{safe_video_id}_{len(best_by_pair) + 1}"),
                    "videoId": safe_video_id,
                    "projectId": safe_project_id,
                    "locationId": safe_location_id,
                    "ownerId": safe_owner_id,
                    "timestampSec": round(float(a["timestampSec"]), 2),
                    "frameNumber": frame_num,
                    "occurredAt": occurred_at,
                    "conflictType": conflict_type,
                    "originalConflictType": conflict_type,
                    "riskScore": risk_score,
                    "riskCategory": risk_cat,
                    "interactionTier": tier,
                    "detectionConfidence": conf,
                    "measurementQuality": "uncalibrated_pixel",
                    "estimatedTtcSec": ttc_sec,
                    "estimatedPetSec": pet_sec,
                    "evasiveManeuverDetected": evasive,
                    "estimatedMinSeparationPx": round(dist_px, 1),
                    "relativeSpeedPxPerSec": round(rel_speed, 1),
                    "trajectoryConvergenceDeg": angle_deg,
                    "movementDirection": direction[:80],
                    "roadUsers": road_users,
                    "involvedTrackIds": [a["trackingId"], b["trackingId"]],
                    "contributingFactors": factors[:10],
                    "measurementLimitations": limitations,
                    "evidenceSummary": (
                        f"Tracked {a['objectClass']} ({a['trackingId']}) and {b['objectClass']} "
                        f"({b['trackingId']}) converged at {round(angle_deg)} deg with ~{round(dist_px)} px "
                        f"clearance and estimated TTC {ttc_sec if ttc_sec is not None else 'N/A'}s."
                    ),
                    "validationStatus": "Pending review",
                    "isDemonstration": False,
                    "createdAt": now_iso,
                    "updatedAt": now_iso,
                }

    events = list(best_by_pair.values())
    events.sort(key=lambda e: e["timestampSec"])
    for idx, ev in enumerate(events):
        ev["id"] = sanitize_identifier(f"evt_{safe_video_id}_{idx + 1}")
    return events
