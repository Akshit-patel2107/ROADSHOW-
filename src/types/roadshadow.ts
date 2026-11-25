export type UserRole = 'ADMINISTRATOR' | 'ANALYST' | 'VIEWER';

export type RiskCategory = 'Low' | 'Medium' | 'High' | 'Critical';

export type ConflictType =
  | 'Motorcycle versus turning car'
  | 'Pedestrian versus vehicle'
  | 'Unsafe merging'
  | 'Crossing conflict'
  | 'Wrong-direction movement'
  | 'Sudden braking'
  | 'Vehicle intersection conflict'
  | 'Other potential conflict';

export type ValidationStatus =
  | 'Pending review'
  | 'Verified'
  | 'False positive'
  | 'Uncertain'
  | 'Under investigation';

export type LocationType =
  | 'Intersection'
  | 'Highway'
  | 'School zone'
  | 'Hospital zone'
  | 'Commercial road'
  | 'Residential road'
  | 'Pedestrian crossing'
  | 'Other';

export type CameraStatus =
  | 'Active'
  | 'Inactive'
  | 'Offline'
  | 'Maintenance'
  | 'Not connected';

export type ProcessingStatus =
  | 'Draft'
  | 'Uploading'
  | 'Uploaded'
  | 'Queued'
  | 'Processing'
  | 'Completed'
  | 'Failed'
  | 'Cancelled';

export type EngineMode = 'CV_SERVICE' | 'DEVELOPMENT_FALLBACK' | 'DEMONSTRATION';

export type MeasurementQuality =
  | 'calibrated'
  | 'uncalibrated_pixel'
  | 'partial_occlusion';

export type DetectedObjectClass =
  | 'person'
  | 'bicycle'
  | 'motorcycle'
  | 'scooter'
  | 'car'
  | 'bus'
  | 'truck'
  | 'auto_rickshaw'
  | 'other_vehicle';

export interface UserProfile {
  uid: string;
  displayName: string;
  email: string;
  photoURL?: string;
  role: UserRole;
  notifyCriticalEvents: boolean;
  notifyJobCompletion: boolean;
  notifyWeeklySummary: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  ownerId: string;
  name: string;
  locationSummary?: string;
  selectedCameraId?: string;
  description: string;
  startDate: string;
  endDate?: string;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export interface RoadLocation {
  id: string;
  projectId: string;
  ownerId: string;
  name: string;
  address: string;
  city: string;
  state: string;
  country: string;
  latitude: number;
  longitude: number;
  locationType: LocationType;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface Camera {
  id: string;
  projectId: string;
  locationId: string;
  ownerId: string;
  name: string;
  cameraType: string;
  direction: string;
  resolution: string;
  frameRate?: number;
  installationDate?: string;
  status: CameraStatus;
  description: string;
  rtspAdapterEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BoundingBox {
  /** Normalized 0..1 coordinates relative to frame width/height */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FrameDetection {
  frameNumber: number;
  timestampSec: number;
  trackingId: string;
  objectClass: DetectedObjectClass;
  confidence: number;
  bbox: BoundingBox;
  velocityPxPerSec?: { vx: number; vy: number };
  modelVersion: string;
}

export interface TrackedTrajectory {
  trackingId: string;
  objectClass: DetectedObjectClass;
  firstFrame: number;
  lastFrame: number;
  trackingConfidence: number;
  positions: Array<{ frameNumber: number; timestampSec: number; cx: number; cy: number }>;
  directionLabel: string;
}

export interface VideoRecord {
  id: string;
  projectId: string;
  locationId: string;
  cameraId: string;
  ownerId: string;
  title: string;
  fileName: string;
  mimeType: 'video/mp4' | 'video/quicktime' | 'video/webm';
  fileSizeBytes: number;
  fileUrl: string;
  posterUrl?: string;
  width?: number;
  height?: number;
  fps?: number;
  errorMessage?: string;
  recordingDate: string;
  recordingTime: string;
  latitude?: number;
  longitude?: number;
  roadType: string;
  description: string;
  durationSec: number;
  status: ProcessingStatus;
  isDemonstration: boolean;
  detections?: FrameDetection[];
  trajectories?: TrackedTrajectory[];
  createdAt: string;
  updatedAt: string;
}

export interface ProcessingJob {
  id: string;
  videoId: string;
  projectId: string;
  ownerId: string;
  status: 'Queued' | 'Processing' | 'Completed' | 'Failed' | 'Cancelled';
  progress: number;
  engineMode: EngineMode;
  modelVersion: string;
  analyzedFrames: number;
  processingTimeMs: number;
  detectedObjectCount: number;
  trackingCount: number;
  conflictCount: number;
  warnings: string[];
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConflictEvent {
  id: string;
  videoId: string;
  projectId: string;
  locationId: string;
  ownerId: string;
  timestampSec: number;
  frameNumber: number;
  occurredAt: string;
  conflictType: ConflictType;
  originalConflictType: ConflictType;
  riskScore: number;
  riskCategory: RiskCategory;
  detectionConfidence: number;
  measurementQuality: MeasurementQuality;
  estimatedTtcSec: number | null;
  estimatedPetSec?: number | null;
  evasiveManeuverDetected?: boolean;
  interactionTier?: 'Potential conflict' | 'Near miss';
  estimatedMinSeparationPx: number | null;
  relativeSpeedPxPerSec: number | null;
  trajectoryConvergenceDeg: number | null;
  movementDirection: string;
  roadUsers: DetectedObjectClass[];
  involvedTrackIds: string[];
  contributingFactors: string[];
  measurementLimitations: string[];
  evidenceSummary: string;
  validationStatus: ValidationStatus;
  analystNotes?: string;
  reviewedBy?: string;
  aiExplanation?: string;
  isDemonstration: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConflictFingerprint {
  id: string;
  projectId: string;
  locationId: string;
  ownerId: string;
  locationName: string;
  patternLabel: string;
  conflictType: ConflictType;
  conflictZone?: string;
  roadUserCombo: string;
  timeWindow: string;
  dayOfWeekPattern: string;
  movementDirection: string;
  observedCount: number;
  isPreliminary: boolean;
  riskDistribution: Record<RiskCategory, number>;
  linkedEventIds: string[];
  supportingVideoIds?: string[];
  contributingFactors: string[];
  suggestedInvestigation: string;
  investigationStatus: 'Monitoring' | 'Marked for investigation' | 'Mitigation planned' | 'Resolved';
  periodTrend: Array<{ period: string; count: number; avgRiskScore: number }>;
  createdAt: string;
  updatedAt: string;
}

export interface SafetyRecommendation {
  id: string;
  projectId: string;
  locationId: string;
  fingerprintId?: string;
  ownerId: string;
  title: string;
  category:
    | 'Engineering'
    | 'Signal Timing'
    | 'Signage & Marking'
    | 'Enforcement'
    | 'Pedestrian Infrastructure';
  priority: RiskCategory;
  rationale: string;
  evidenceSummary: string;
  implementationSteps: string[];
  status: 'Proposed' | 'Under review' | 'Approved' | 'Implemented' | 'Deferred';
  generatedByAi: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SafetyReport {
  id: string;
  projectId: string;
  ownerId: string;
  title: string;
  reportType:
    | 'Location Safety Audit'
    | 'Conflict Fingerprint Brief'
    | 'Monthly Traffic Safety Review'
    | 'Executive Summary';
  dateRangeStart: string;
  dateRangeEnd: string;
  summary: string;
  aiExecutiveSummary?: string;
  includedLocationIds: string[];
  metricsSnapshot: {
    videosAnalyzed: number;
    totalEvents: number;
    criticalEvents: number;
    highEvents: number;
    verifiedEvents: number;
    fingerprintsIdentified: number;
  };
  createdAt: string;
  updatedAt: string;
}

export interface AppNotification {
  id: string;
  userId: string;
  title: string;
  message: string;
  severity: 'info' | 'warning' | 'critical' | 'success';
  read: boolean;
  linkPath?: string;
  createdAt: string;
}

export interface AuditLogEntry {
  id: string;
  actorId: string;
  actorName: string;
  actorRole: UserRole;
  action: string;
  targetType: string;
  targetId: string;
  details: string;
  createdAt: string;
}

export interface RiskBandConfig {
  lowMax: number;
  mediumMax: number;
  highMax: number;
}

export interface WorkspaceSettings {
  riskBands: RiskBandConfig;
  maxUploadMb: number;
}

export type CameraSourceMode =
  | 'registered_camera'
  | 'uploaded_footage'
  | 'live_rtsp'
  | 'demo_camera';

export interface ActiveCameraSource {
  projectId: string;
  sourceMode: CameraSourceMode;
  sourceId: string;
  label: string;
  locationName: string;
  status: CameraStatus | 'Ready' | 'Demo Ready';
  previewUrl?: string;
  videoId?: string;
  cameraId?: string;
  isSelectable: boolean;
  disabledReason?: string;
}

export type JunctionInterventionId =
  | 'pedestrian_crossing_relocation'
  | 'lane_markings'
  | 'signal_timing'
  | 'dedicated_turning_lanes'
  | 'pedestrian_separation'
  | 'traffic_flow_modifications'
  | 'road_signage';

export interface JunctionInterventionDefinition {
  id: JunctionInterventionId;
  label: string;
  category:
    | 'Engineering'
    | 'Signal Timing'
    | 'Signage & Marking'
    | 'Pedestrian Infrastructure';
  summary: string;
  primaryTargetConflicts: string[];
  estimatedCostBand: 'Low' | 'Medium' | 'High';
  tradeoffNote: string;
}

export interface JunctionMetricSnapshot {
  simulatedConflictRatePerHr: number;
  avgWaitTimeSec: number;
  throughputVehPerHr: number;
  pedestrianCrossingSec: number;
  estimatedRiskIndex: number;
}

export interface JunctionSimulationResult {
  locationId: string;
  locationName: string;
  selectedInterventions: JunctionInterventionId[];
  engineMode: 'ANALYTICAL_MODEL' | 'SUMO_WORKER';
  isSimulationEstimate: true;
  existing: JunctionMetricSnapshot;
  proposed: JunctionMetricSnapshot;
  deltas: {
    conflictRatePctChange: number;
    waitTimeDeltaSec: number;
    throughputPctChange: number;
    pedestrianCrossingDeltaSec: number;
    riskIndexPctChange: number;
  };
  engineeringNotes: string[];
  simulationCaveats: string[];
}
