import type {
  ConflictEvent,
  ConflictType,
  DetectedObjectClass,
  FrameDetection,
  RiskBandConfig,
  TrackedTrajectory,
} from '../types/roadshadow';
import { calculateProvisionalRiskScore, DEFAULT_RISK_BANDS } from './riskScoring';

export interface TrajectoryAnalysisConfig {
  frameWidthPx: number;
  frameHeightPx: number;
  maxConflictSeparationPx: number;
  minRelativeClosingSpeedPxPerSec: number;
  minConvergenceAngleDeg: number;
  riskBands?: RiskBandConfig;
}

export const DEFAULT_ANALYSIS_CONFIG: TrajectoryAnalysisConfig = {
  frameWidthPx: 1280,
  frameHeightPx: 720,
  maxConflictSeparationPx: 110,
  minRelativeClosingSpeedPxPerSec: 35,
  minConvergenceAngleDeg: 18,
  riskBands: DEFAULT_RISK_BANDS,
};

export interface CandidateConflict {
  timestampSec: number;
  frameNumber: number;
  conflictType: ConflictType;
  roadUsers: DetectedObjectClass[];
  involvedTrackIds: string[];
  estimatedTtcSec: number | null;
  estimatedPetSec: number | null;
  estimatedMinSeparationPx: number;
  relativeSpeedPxPerSec: number;
  trajectoryConvergenceDeg: number;
  detectionConfidence: number;
  movementDirection: string;
  evidenceSummary: string;
  abruptDecelerationDetected: boolean;
  evasiveManeuverDetected: boolean;
  wrongDirectionDetected: boolean;
}

export function computeAngleBetweenVectorsDeg(
  v1: { vx: number; vy: number },
  v2: { vx: number; vy: number }
): number {
  const m1 = Math.hypot(v1.vx, v1.vy);
  const m2 = Math.hypot(v2.vx, v2.vy);
  if (m1 < 1e-4 || m2 < 1e-4) return 0;
  const dot = (v1.vx * v2.vx + v1.vy * v2.vy) / (m1 * m2);
  const clamped = Math.max(-1, Math.min(1, dot));
  return (Math.acos(clamped) * 180) / Math.PI;
}

export function classifyInteraction(
  classA: DetectedObjectClass,
  classB: DetectedObjectClass,
  convergenceDeg: number,
  abruptBraking: boolean
): ConflictType {
  const pair = new Set<DetectedObjectClass>([classA, classB]);
  if (pair.has('person')) return 'Pedestrian versus vehicle';
  if (
    (pair.has('motorcycle') || pair.has('scooter')) &&
    (pair.has('car') || pair.has('auto_rickshaw')) &&
    convergenceDeg >= 45 &&
    convergenceDeg <= 135
  ) {
    return 'Motorcycle versus turning car';
  }
  if (convergenceDeg >= 145) return 'Wrong-direction movement';
  if (abruptBraking && convergenceDeg < 30) return 'Sudden braking';
  if (convergenceDeg >= 20 && convergenceDeg < 55) return 'Unsafe merging';
  if (convergenceDeg >= 55 && convergenceDeg <= 135) return 'Crossing conflict';
  return 'Vehicle intersection conflict';
}

export function buildTrajectoriesFromDetections(
  detections: FrameDetection[]
): TrackedTrajectory[] {
  const byTrack = new Map<string, FrameDetection[]>();
  for (const det of detections) {
    const list = byTrack.get(det.trackingId) ?? [];
    list.push(det);
    byTrack.set(det.trackingId, list);
  }

  const trajectories: TrackedTrajectory[] = [];
  for (const [trackingId, list] of byTrack.entries()) {
    const sorted = [...list].sort((a, b) => a.frameNumber - b.frameNumber);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const dx = last.bbox.x + last.bbox.w / 2 - (first.bbox.x + first.bbox.w / 2);
    const dy = last.bbox.y + last.bbox.h / 2 - (first.bbox.y + first.bbox.h / 2);

    let directionLabel = 'Stationary';
    if (Math.hypot(dx, dy) > 0.03) {
      if (Math.abs(dx) >= Math.abs(dy)) {
        directionLabel = dx > 0 ? 'Westbound to Eastbound' : 'Eastbound to Westbound';
      } else {
        directionLabel = dy > 0 ? 'Northbound to Southbound' : 'Southbound to Northbound';
      }
    }

    const avgConf =
      sorted.reduce((sum, item) => sum + item.confidence, 0) / sorted.length;

    trajectories.push({
      trackingId,
      objectClass: first.objectClass,
      firstFrame: first.frameNumber,
      lastFrame: last.frameNumber,
      trackingConfidence: Number(avgConf.toFixed(2)),
      directionLabel,
      positions: sorted.map((d) => ({
        frameNumber: d.frameNumber,
        timestampSec: d.timestampSec,
        cx: Number((d.bbox.x + d.bbox.w / 2).toFixed(4)),
        cy: Number((d.bbox.y + d.bbox.h / 2).toFixed(4)),
      })),
    });
  }

  return trajectories;
}

/**
 * Estimates Post-Encroachment Time (PET) between two trajectories by finding the smallest
 * time difference at which both trajectories occupy the same spatial conflict cell (<= 48px).
 */
export function estimatePostEncroachmentTimeSec(
  trackA: TrackedTrajectory | undefined,
  trackB: TrackedTrajectory | undefined,
  frameWidthPx = 1280,
  frameHeightPx = 720,
  encroachmentRadiusPx = 54
): number | null {
  if (!trackA || !trackB || trackA.positions.length === 0 || trackB.positions.length === 0) {
    return null;
  }
  let bestPet: number | null = null;
  for (const pa of trackA.positions) {
    const ax = pa.cx * frameWidthPx;
    const ay = pa.cy * frameHeightPx;
    for (const pb of trackB.positions) {
      const dist = Math.hypot(pb.cx * frameWidthPx - ax, pb.cy * frameHeightPx - ay);
      if (dist <= encroachmentRadiusPx) {
        const dt = Math.abs(pb.timestampSec - pa.timestampSec);
        if (bestPet === null || dt < bestPet) {
          bestPet = dt;
        }
      }
    }
  }
  return bestPet !== null ? Number(Math.max(0.15, bestPet).toFixed(2)) : null;
}

/**
 * Detects sudden evasive lateral movement (sharp heading change >= 28 deg across consecutive samples).
 */
export function detectEvasiveManeuver(track: TrackedTrajectory | undefined): boolean {
  if (!track || track.positions.length < 3) return false;
  for (let i = 1; i < track.positions.length - 1; i += 1) {
    const prev = track.positions[i - 1];
    const curr = track.positions[i];
    const next = track.positions[i + 1];
    const v1 = { vx: curr.cx - prev.cx, vy: curr.cy - prev.cy };
    const v2 = { vx: next.cx - curr.cx, vy: next.cy - curr.cy };
    if (Math.hypot(v1.vx, v1.vy) > 0.008 && Math.hypot(v2.vx, v2.vy) > 0.008) {
      const turnDeg = computeAngleBetweenVectorsDeg(v1, v2);
      if (turnDeg >= 28) return true;
    }
  }
  return false;
}

/**
 * Evaluates pairs of tracked objects frame-by-frame to identify converging trajectories,
 * low time-to-collision (TTC), Post-Encroachment Time (PET), sudden evasive movement,
 * and small spatial separation.
 * IMPORTANT: Explicitly rejects static bounding-box overlap without relative closing motion
 * so simple perspective occlusion/overlap is never treated as proof of a near-miss.
 */
export function analyzeDetectionsForConflicts(
  detections: FrameDetection[],
  config: TrajectoryAnalysisConfig = DEFAULT_ANALYSIS_CONFIG
): CandidateConflict[] {
  const byFrame = new Map<number, FrameDetection[]>();
  for (const det of detections) {
    const list = byFrame.get(det.frameNumber) ?? [];
    list.push(det);
    byFrame.set(det.frameNumber, list);
  }

  const trajectories = buildTrajectoriesFromDetections(detections);
  const trackMap = new Map(trajectories.map((t) => [t.trackingId, t]));

  const pairBest = new Map<string, CandidateConflict>();

  for (const [frameNumber, frameDets] of byFrame.entries()) {
    for (let i = 0; i < frameDets.length; i += 1) {
      for (let j = i + 1; j < frameDets.length; j += 1) {
        const a = frameDets[i];
        const b = frameDets[j];
        if (a.trackingId === b.trackingId) continue;

        const ax = (a.bbox.x + a.bbox.w / 2) * config.frameWidthPx;
        const ay = (a.bbox.y + a.bbox.h / 2) * config.frameHeightPx;
        const bx = (b.bbox.x + b.bbox.w / 2) * config.frameWidthPx;
        const by = (b.bbox.y + b.bbox.h / 2) * config.frameHeightPx;

        const dx = bx - ax;
        const dy = by - ay;
        const separationPx = Math.hypot(dx, dy);

        if (separationPx > config.maxConflictSeparationPx) continue;

        const va = a.velocityPxPerSec ?? { vx: 0, vy: 0 };
        const vb = b.velocityPxPerSec ?? { vx: 0, vy: 0 };

        // Relative velocity of B with respect to A
        const rvx = vb.vx - va.vx;
        const rvy = vb.vy - va.vy;
        const relSpeed = Math.hypot(rvx, rvy);

        // Guard: simple bounding-box overlap without meaningful relative closing speed is ignored!
        if (relSpeed < config.minRelativeClosingSpeedPxPerSec) continue;

        // Closing rate along separation vector (negative dot product means approaching)
        const closingRate =
          separationPx > 1 ? -((dx * rvx + dy * rvy) / separationPx) : relSpeed;
        if (closingRate <= 10) continue;

        const convergenceDeg = computeAngleBetweenVectorsDeg(va, vb);
        const abruptDecelerationDetected =
          Math.hypot(va.vx, va.vy) < 25 && Math.hypot(vb.vx, vb.vy) > 95;
        const wrongDirectionDetected = convergenceDeg >= 150;

        if (
          convergenceDeg < config.minConvergenceAngleDeg &&
          !abruptDecelerationDetected
        ) {
          continue;
        }

        const estimatedTtcSec = Number(
          Math.max(0.25, separationPx / Math.max(closingRate, 1)).toFixed(2)
        );
        if (estimatedTtcSec > 4.5) continue;

        const trackA = trackMap.get(a.trackingId);
        const trackB = trackMap.get(b.trackingId);
        const estimatedPetSec = estimatePostEncroachmentTimeSec(
          trackA,
          trackB,
          config.frameWidthPx,
          config.frameHeightPx
        );
        const evasiveManeuverDetected =
          detectEvasiveManeuver(trackA) || detectEvasiveManeuver(trackB);

        const conflictType = classifyInteraction(
          a.objectClass,
          b.objectClass,
          convergenceDeg,
          abruptDecelerationDetected
        );

        const pairKey = [a.trackingId, b.trackingId].sort().join('__');
        const existingBest = pairBest.get(pairKey);

        if (!existingBest || estimatedTtcSec < (existingBest.estimatedTtcSec ?? 99)) {
          const avgConf = Number(((a.confidence + b.confidence) / 2).toFixed(2));
          pairBest.set(pairKey, {
            timestampSec: a.timestampSec,
            frameNumber,
            conflictType,
            roadUsers: [a.objectClass, b.objectClass],
            involvedTrackIds: [a.trackingId, b.trackingId],
            estimatedTtcSec,
            estimatedPetSec,
            estimatedMinSeparationPx: Math.round(separationPx),
            relativeSpeedPxPerSec: Math.round(relSpeed),
            trajectoryConvergenceDeg: Math.round(convergenceDeg),
            detectionConfidence: avgConf,
            movementDirection:
              Math.abs(va.vx) >= Math.abs(va.vy)
                ? 'East-West / Turning'
                : 'North-South / Crossing',
            evidenceSummary: `Tracked ${a.objectClass} (${a.trackingId}) and ${b.objectClass} (${b.trackingId}) converged at ${Math.round(convergenceDeg)}° with ~${Math.round(separationPx)} px clearance, TTC ${estimatedTtcSec.toFixed(1)}s${estimatedPetSec !== null ? `, and PET ${estimatedPetSec.toFixed(1)}s` : ''} (uncalibrated pixel space).`,
            abruptDecelerationDetected,
            evasiveManeuverDetected,
            wrongDirectionDetected,
          });
        }
      }
    }
  }

  return Array.from(pairBest.values()).sort((a, b) => a.timestampSec - b.timestampSec);
}

/**
 * Generates deterministic, structured trajectory frame detections for the
 * clearly-labelled Development CV Adapter Fallback when no external Python FastAPI
 * YOLO/ByteTrack service is connected.
 */
export function runDevelopmentFallbackCvAdapter(params: {
  videoId: string;
  projectId: string;
  locationId: string;
  ownerId: string;
  durationSec: number;
  occurredAtIso: string;
  roadType: string;
  riskBands?: RiskBandConfig;
}): {
  detections: FrameDetection[];
  trajectories: TrackedTrajectory[];
  events: ConflictEvent[];
  modelVersion: string;
  warnings: string[];
} {
  const duration = Math.max(12, Math.min(params.durationSec || 24, 120));
  const modelVersion = 'Dev-Fallback-Trajectory-Adapter-v1.0 (Not Live YOLO)';
  const detections: FrameDetection[] = [];

  // Create deterministic 2fps sampled tracks over the clip duration
  const totalSteps = Math.min(48, Math.floor(duration * 2));
  for (let step = 0; step < totalSteps; step += 1) {
    const t = Number((step * 0.5).toFixed(2));
    const frameNumber = Math.round(t * 25);

    // Track 1: Motorcycle moving straight Eastbound across intersection
    const motoX = 0.14 + (step / totalSteps) * 0.68;
    const motoY = 0.54 - (step / totalSteps) * 0.05;
    detections.push({
      frameNumber,
      timestampSec: t,
      trackingId: 'TRK-M01',
      objectClass: 'motorcycle',
      confidence: 0.89,
      bbox: { x: motoX, y: motoY, w: 0.07, h: 0.11 },
      velocityPxPerSec: { vx: 135, vy: -12 },
      modelVersion,
    });

    // Track 2: Car turning across motorcycle path around step 14-18
    const carProgress = Math.max(0, Math.min(1, (step - 4) / (totalSteps * 0.65)));
    const carX = 0.62 - carProgress * 0.24;
    const carY = 0.28 + carProgress * 0.34;
    detections.push({
      frameNumber,
      timestampSec: t,
      trackingId: 'TRK-C04',
      objectClass: 'car',
      confidence: 0.93,
      bbox: { x: carX, y: carY, w: 0.14, h: 0.13 },
      velocityPxPerSec: { vx: -62, vy: 118 },
      modelVersion,
    });

    // Track 3: Pedestrian crossing zebra crosswalk in lower frame
    if (step >= Math.floor(totalSteps * 0.45)) {
      const pedProgress = (step - Math.floor(totalSteps * 0.45)) / (totalSteps * 0.45);
      detections.push({
        frameNumber,
        timestampSec: t,
        trackingId: 'TRK-P09',
        objectClass: 'person',
        confidence: 0.84,
        bbox: {
          x: 0.28 + pedProgress * 0.36,
          y: 0.72,
          w: 0.045,
          h: 0.14,
        },
        velocityPxPerSec: { vx: 42, vy: 0 },
        modelVersion,
      });

      // Track 4: Auto-rickshaw approaching crosswalk
      detections.push({
        frameNumber,
        timestampSec: t,
        trackingId: 'TRK-A12',
        objectClass: 'auto_rickshaw',
        confidence: 0.86,
        bbox: {
          x: 0.56 - pedProgress * 0.12,
          y: 0.56 + pedProgress * 0.19,
          w: 0.09,
          h: 0.12,
        },
        velocityPxPerSec: { vx: -28, vy: 105 },
        modelVersion,
      });
    }
  }

  const trajectories = buildTrajectoriesFromDetections(detections);
  const candidates = analyzeDetectionsForConflicts(detections, {
    ...DEFAULT_ANALYSIS_CONFIG,
    riskBands: params.riskBands ?? DEFAULT_RISK_BANDS,
  });

  const nowIso = new Date().toISOString();
  const events: ConflictEvent[] = candidates.map((c, idx) => {
    const scored = calculateProvisionalRiskScore({
      estimatedTtcSec: c.estimatedTtcSec,
      estimatedPetSec: c.estimatedPetSec,
      estimatedMinSeparationPx: c.estimatedMinSeparationPx,
      relativeSpeedPxPerSec: c.relativeSpeedPxPerSec,
      trajectoryConvergenceDeg: c.trajectoryConvergenceDeg,
      roadUsers: c.roadUsers,
      detectionConfidence: c.detectionConfidence,
      measurementQuality: 'uncalibrated_pixel',
      abruptDecelerationDetected: c.abruptDecelerationDetected,
      evasiveManeuverDetected: c.evasiveManeuverDetected,
      wrongDirectionDetected: c.wrongDirectionDetected,
      bands: params.riskBands ?? DEFAULT_RISK_BANDS,
    });

    return {
      id: `evt_${params.videoId}_${idx + 1}`,
      videoId: params.videoId,
      projectId: params.projectId,
      locationId: params.locationId,
      ownerId: params.ownerId,
      timestampSec: c.timestampSec,
      frameNumber: c.frameNumber,
      occurredAt: params.occurredAtIso,
      conflictType: c.conflictType,
      originalConflictType: c.conflictType,
      riskScore: scored.riskScore,
      riskCategory: scored.riskCategory,
      interactionTier: scored.interactionTier,
      detectionConfidence: scored.detectionConfidence,
      measurementQuality: 'uncalibrated_pixel',
      estimatedTtcSec: c.estimatedTtcSec,
      estimatedPetSec: c.estimatedPetSec,
      evasiveManeuverDetected: c.evasiveManeuverDetected,
      estimatedMinSeparationPx: c.estimatedMinSeparationPx,
      relativeSpeedPxPerSec: c.relativeSpeedPxPerSec,
      trajectoryConvergenceDeg: c.trajectoryConvergenceDeg,
      movementDirection: c.movementDirection,
      roadUsers: c.roadUsers,
      involvedTrackIds: c.involvedTrackIds,
      contributingFactors: scored.contributingFactors,
      measurementLimitations: [
        'Generated via Development CV Fallback Adapter because external Python FastAPI YOLO worker (CV_SERVICE_URL) is not configured.',
        ...scored.measurementLimitations,
      ],
      evidenceSummary: c.evidenceSummary,
      validationStatus: 'Pending review',
      isDemonstration: false,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
  });

  return {
    detections,
    trajectories,
    events,
    modelVersion,
    warnings: [
      'External Python FastAPI + YOLO/ByteTrack service (CV_SERVICE_URL) is not configured. Structured sample trajectories were analyzed using the Development CV Fallback Adapter.',
      'Camera homography calibration unavailable: clearances and velocities are reported in pixel space, not calibrated physical meters or km/h.',
    ],
  };
}
