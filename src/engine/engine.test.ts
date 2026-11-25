import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateProvisionalRiskScore, classifyRiskBand } from './riskScoring';
import { buildConflictFingerprints } from './conflictFingerprint';
import {
  analyzeDetectionsForConflicts,
  detectEvasiveManeuver,
  estimatePostEncroachmentTimeSec,
  runDevelopmentFallbackCvAdapter,
} from './cvTrajectoryAnalyzer';
import {
  JUNCTION_INTERVENTIONS,
  runJunctionImprovementSimulation,
} from './junctionSimulation';
import {
  canPerformAction,
  validateCoordinates,
  validateVideoFileMeta,
} from './validation';
import type { ConflictEvent, FrameDetection, RoadLocation, TrackedTrajectory } from '../types/roadshadow';

test('Risk scoring classifies provisional bands accurately and keeps confidence separate', () => {
  assert.equal(classifyRiskBand(12), 'Low');
  assert.equal(classifyRiskBand(38), 'Medium');
  assert.equal(classifyRiskBand(64), 'High');
  assert.equal(classifyRiskBand(82), 'Critical');

  const result = calculateProvisionalRiskScore({
    estimatedTtcSec: 0.9,
    estimatedPetSec: 0.7,
    evasiveManeuverDetected: true,
    estimatedMinSeparationPx: 24,
    relativeSpeedPxPerSec: 185,
    trajectoryConvergenceDeg: 90,
    roadUsers: ['person', 'car'],
    detectionConfidence: 0.65,
    measurementQuality: 'uncalibrated_pixel',
  });

  assert.equal(result.isProvisional, true);
  assert.equal(result.riskCategory, 'Critical');
  assert.equal(result.interactionTier, 'Near miss');
  assert.equal(result.detectionConfidence, 0.65);
  assert.ok(result.riskScore >= 75 && result.riskScore <= 100);
  assert.ok(
    result.measurementLimitations.some((m) => m.includes('not a validated accident probability'))
  );
  assert.ok(
    result.measurementLimitations.some((m) => m.includes('pixel-space estimates'))
  );
});

test('Risk scoring applies vulnerable road user weight to scooters', () => {
  const scooterScore = calculateProvisionalRiskScore({
    estimatedTtcSec: 1.5,
    estimatedMinSeparationPx: 40,
    relativeSpeedPxPerSec: 140,
    trajectoryConvergenceDeg: 75,
    roadUsers: ['scooter', 'truck'],
    detectionConfidence: 0.85,
    measurementQuality: 'uncalibrated_pixel',
  });
  const carScore = calculateProvisionalRiskScore({
    estimatedTtcSec: 1.5,
    estimatedMinSeparationPx: 40,
    relativeSpeedPxPerSec: 140,
    trajectoryConvergenceDeg: 75,
    roadUsers: ['car', 'car'],
    detectionConfidence: 0.85,
    measurementQuality: 'uncalibrated_pixel',
  });
  assert.ok(scooterScore.riskScore > carScore.riskScore);
});

test('Risk scoring gracefully handles missing TTC and separation measurements', () => {
  const result = calculateProvisionalRiskScore({
    estimatedTtcSec: null,
    estimatedMinSeparationPx: null,
    relativeSpeedPxPerSec: 110,
    trajectoryConvergenceDeg: 75,
    roadUsers: ['car', 'car'],
    detectionConfidence: 0.88,
    measurementQuality: 'partial_occlusion',
  });

  assert.equal(result.factorBreakdown.ttcComponent, null);
  assert.equal(result.factorBreakdown.separationComponent, null);
  assert.ok(result.riskScore >= 0 && result.riskScore <= 100);
  assert.ok(
    result.measurementLimitations.some((m) => m.includes('Time-to-collision could not be reliably estimated'))
  );
});

test('CV trajectory analyzer rejects static bounding-box overlap without closing motion', () => {
  const staticOverlap: FrameDetection[] = [
    {
      frameNumber: 10,
      timestampSec: 0.4,
      trackingId: 'T1',
      objectClass: 'car',
      confidence: 0.92,
      bbox: { x: 0.4, y: 0.4, w: 0.15, h: 0.15 },
      velocityPxPerSec: { vx: 2, vy: 1 },
      modelVersion: 'test',
    },
    {
      frameNumber: 10,
      timestampSec: 0.4,
      trackingId: 'T2',
      objectClass: 'motorcycle',
      confidence: 0.89,
      bbox: { x: 0.42, y: 0.41, w: 0.08, h: 0.1 },
      velocityPxPerSec: { vx: 2, vy: 1 },
      modelVersion: 'test',
    },
  ];

  const conflicts = analyzeDetectionsForConflicts(staticOverlap);
  assert.equal(conflicts.length, 0);
});

test('PET estimation and evasive maneuver detector respond to crossing paths and sharp heading shifts', () => {
  const trajA: TrackedTrajectory = {
    trackingId: 'TA',
    objectClass: 'scooter',
    firstFrame: 0,
    lastFrame: 60,
    trackingConfidence: 0.9,
    directionLabel: 'Eastbound',
    positions: [
      { frameNumber: 0, timestampSec: 0, cx: 0.2, cy: 0.5 },
      { frameNumber: 25, timestampSec: 1.0, cx: 0.5, cy: 0.5 },
      { frameNumber: 50, timestampSec: 2.0, cx: 0.65, cy: 0.25 },
    ],
  };
  const trajB: TrackedTrajectory = {
    trackingId: 'TB',
    objectClass: 'car',
    firstFrame: 0,
    lastFrame: 60,
    trackingConfidence: 0.92,
    directionLabel: 'Northbound',
    positions: [
      { frameNumber: 0, timestampSec: 0, cx: 0.5, cy: 0.8 },
      { frameNumber: 40, timestampSec: 1.6, cx: 0.5, cy: 0.5 },
      { frameNumber: 65, timestampSec: 2.6, cx: 0.5, cy: 0.2 },
    ],
  };

  const pet = estimatePostEncroachmentTimeSec(trajA, trajB, 1280, 720);
  assert.ok(pet !== null && pet >= 0.5 && pet <= 0.7);
  assert.equal(detectEvasiveManeuver(trajA), true);
  assert.equal(detectEvasiveManeuver(trajB), false);
});

test('Development CV fallback adapter produces transparent warnings and valid conflict events', () => {
  const output = runDevelopmentFallbackCvAdapter({
    videoId: 'vid_test_1',
    projectId: 'proj_1',
    locationId: 'loc_1',
    ownerId: 'user_1',
    durationSec: 20,
    occurredAtIso: '2026-11-20T09:15:00.000Z',
    roadType: 'Intersection',
  });

  assert.ok(output.detections.length > 10);
  assert.ok(output.trajectories.length >= 2);
  assert.ok(output.events.length >= 1);
  assert.ok(output.warnings.some((w) => w.includes('Development CV Fallback Adapter')));
  assert.equal(output.events[0].originalConflictType, output.events[0].conflictType);
});

test('Conflict fingerprint engine requires minimum observations, marks preliminary, and supports verifiedOnly', () => {
  const locations: RoadLocation[] = [
    {
      id: 'loc_a',
      projectId: 'p1',
      ownerId: 'u1',
      name: 'Town Hall Junction',
      address: 'Station Rd',
      city: 'Anand',
      state: 'Gujarat',
      country: 'India',
      latitude: 22.5645,
      longitude: 72.9289,
      locationType: 'Intersection',
      description: '',
      createdAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-01T00:00:00Z',
    },
  ];

  const makeEvt = (id: string, status: ConflictEvent['validationStatus'] = 'Verified'): ConflictEvent => ({
    id,
    videoId: 'v1',
    projectId: 'p1',
    locationId: 'loc_a',
    ownerId: 'u1',
    timestampSec: 12,
    frameNumber: 300,
    occurredAt: '2026-11-18T08:45:00.000Z',
    conflictType: 'Motorcycle versus turning car',
    originalConflictType: 'Motorcycle versus turning car',
    riskScore: 78,
    riskCategory: 'Critical',
    detectionConfidence: 0.9,
    measurementQuality: 'uncalibrated_pixel',
    estimatedTtcSec: 1.1,
    estimatedMinSeparationPx: 30,
    relativeSpeedPxPerSec: 160,
    trajectoryConvergenceDeg: 85,
    movementDirection: 'East-West / Turning',
    roadUsers: ['motorcycle', 'car'],
    involvedTrackIds: ['T1', 'T2'],
    contributingFactors: ['Low TTC'],
    measurementLimitations: ['Uncalibrated'],
    evidenceSummary: 'Summary',
    validationStatus: status,
    isDemonstration: false,
    createdAt: '2026-11-18T08:45:00.000Z',
    updatedAt: '2026-11-18T08:45:00.000Z',
  });

  // 1 event should NOT produce a fingerprint
  assert.equal(buildConflictFingerprints([makeEvt('e1')], locations).length, 0);

  // 2 events + 1 false positive should produce 1 preliminary fingerprint with observedCount = 2
  const fps = buildConflictFingerprints(
    [makeEvt('e1'), makeEvt('e2', 'Pending review'), makeEvt('e3', 'False positive')],
    locations
  );
  assert.equal(fps.length, 1);
  assert.equal(fps[0].observedCount, 2);
  assert.equal(fps[0].isPreliminary, true);
  assert.deepEqual(fps[0].supportingVideoIds, ['v1']);

  // verifiedOnly excludes 'Pending review', leaving only 1 verified event -> 0 fingerprints
  const verifiedFps = buildConflictFingerprints(
    [makeEvt('e1', 'Verified'), makeEvt('e2', 'Pending review')],
    locations,
    undefined,
    { verifiedOnly: true }
  );
  assert.equal(verifiedFps.length, 0);
});

test('Junction Improvement Lab simulation computes diminishing-return deltas and labels estimate transparently', () => {
  assert.equal(JUNCTION_INTERVENTIONS.length, 7);

  const location: RoadLocation = {
    id: 'loc_anand_th',
    projectId: 'proj_1',
    ownerId: 'u1',
    name: 'Town Hall Junction',
    address: 'Station Road',
    city: 'Anand',
    state: 'Gujarat',
    country: 'India',
    latitude: 22.5645,
    longitude: 72.9289,
    locationType: 'Intersection',
    description: 'Four-arm municipal intersection',
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
  };

  const baselineOnly = runJunctionImprovementSimulation({
    location,
    locationEvents: [],
    locationFingerprints: [],
    selectedInterventions: [],
  });
  assert.equal(baselineOnly.isSimulationEstimate, true);
  assert.equal(baselineOnly.deltas.conflictRatePctChange, 0);

  const improved = runJunctionImprovementSimulation({
    location,
    locationEvents: [],
    locationFingerprints: [],
    selectedInterventions: ['pedestrian_crossing_relocation', 'signal_timing', 'dedicated_turning_lanes'],
  });
  assert.equal(improved.isSimulationEstimate, true);
  assert.ok(improved.proposed.simulatedConflictRatePerHr < improved.existing.simulatedConflictRatePerHr);
  assert.ok(improved.deltas.conflictRatePctChange < 0);
  assert.ok(improved.proposed.estimatedRiskIndex < improved.existing.estimatedRiskIndex);
  assert.ok(improved.simulationCaveats.some((c) => c.includes('Simulation Estimate Only')));
});

test('Validation guards reject invalid coordinates, unsupported video formats, and unauthorized RBAC actions', () => {
  assert.equal(validateCoordinates(22.56, 72.92).valid, true);
  assert.equal(validateCoordinates(95, 72.92).valid, false);
  assert.equal(validateCoordinates(0, 0).valid, false);

  assert.equal(validateVideoFileMeta('clip.mp4', 'video/mp4', 1024 * 1024, 250).valid, true);
  assert.equal(validateVideoFileMeta('clip.exe', 'application/octet-stream', 1024, 250).valid, false);
  assert.equal(validateVideoFileMeta('huge.mp4', 'video/mp4', 300 * 1024 * 1024, 250).valid, false);

  assert.equal(canPerformAction('ADMINISTRATOR', 'manage_users'), true);
  assert.equal(canPerformAction('ANALYST', 'manage_users'), false);
  assert.equal(canPerformAction('ANALYST', 'review_events'), true);
  assert.equal(canPerformAction('VIEWER', 'upload_video'), false);
});

