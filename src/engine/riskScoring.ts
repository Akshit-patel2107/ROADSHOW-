import type {
  DetectedObjectClass,
  MeasurementQuality,
  RiskBandConfig,
  RiskCategory,
} from '../types/roadshadow';

export const DEFAULT_RISK_BANDS: RiskBandConfig = {
  lowMax: 24,
  mediumMax: 49,
  highMax: 74,
};

export const RISK_FORMULA_VERSION = 'RS-PROVISIONAL-2.0';

export interface RiskScoringInput {
  estimatedTtcSec: number | null;
  estimatedPetSec?: number | null;
  estimatedMinSeparationPx: number | null;
  relativeSpeedPxPerSec: number | null;
  trajectoryConvergenceDeg: number | null;
  roadUsers: DetectedObjectClass[];
  detectionConfidence: number;
  measurementQuality: MeasurementQuality;
  abruptDecelerationDetected?: boolean;
  evasiveManeuverDetected?: boolean;
  wrongDirectionDetected?: boolean;
  bands?: RiskBandConfig;
}

export interface RiskScoringResult {
  riskScore: number;
  riskCategory: RiskCategory;
  interactionTier: 'Potential conflict' | 'Near miss';
  /** Kept strictly separate from riskScore per methodology */
  detectionConfidence: number;
  contributingFactors: string[];
  measurementLimitations: string[];
  formulaVersion: string;
  isProvisional: true;
  factorBreakdown: {
    ttcComponent: number | null;
    petComponent: number | null;
    separationComponent: number | null;
    relativeSpeedComponent: number | null;
    convergenceComponent: number | null;
    vulnerabilityComponent: number;
  };
}

const VULNERABLE_CLASSES: ReadonlySet<DetectedObjectClass> = new Set([
  'person',
  'bicycle',
  'motorcycle',
  'scooter',
]);

const HEAVY_CLASSES: ReadonlySet<DetectedObjectClass> = new Set(['bus', 'truck']);

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function classifyRiskBand(
  score: number,
  bands: RiskBandConfig = DEFAULT_RISK_BANDS
): RiskCategory {
  if (score <= bands.lowMax) return 'Low';
  if (score <= bands.mediumMax) return 'Medium';
  if (score <= bands.highMax) return 'High';
  return 'Critical';
}

/**
 * Transparent, explainable provisional risk scoring model (0-100).
 * IMPORTANT: Outputs are provisional investigative indicators, NOT validated accident probabilities.
 * Detection confidence is reported separately and is never blended into the severity score as false certainty.
 */
export function calculateProvisionalRiskScore(input: RiskScoringInput): RiskScoringResult {
  const bands = input.bands ?? DEFAULT_RISK_BANDS;
  const contributingFactors: string[] = [];
  const measurementLimitations: string[] = [];

  const weightedComponents: Array<{ weight: number; score: number }> = [];

  // 1. Estimated Time-to-Collision (weight 0.30)
  let ttcComponent: number | null = null;
  if (input.estimatedTtcSec !== null && Number.isFinite(input.estimatedTtcSec)) {
    const ttc = Math.max(0.1, input.estimatedTtcSec);
    if (ttc <= 1.0) ttcComponent = 95;
    else if (ttc <= 1.8) ttcComponent = 80;
    else if (ttc <= 2.8) ttcComponent = 60;
    else if (ttc <= 4.0) ttcComponent = 38;
    else ttcComponent = 15;

    weightedComponents.push({ weight: 0.3, score: ttcComponent });
    if (ttc <= 1.8) {
      contributingFactors.push(
        `Low estimated time-to-collision (~${ttc.toFixed(1)}s projected path intersection)`
      );
    } else if (ttc <= 3.0) {
      contributingFactors.push(
        `Moderate time-to-collision margin (~${ttc.toFixed(1)}s)`
      );
    }
  } else {
    measurementLimitations.push(
      'Time-to-collision could not be reliably estimated; remaining spatial factors reweighted.'
    );
  }

  // 2. Post-Encroachment Time (PET) estimate (weight 0.14 when available)
  let petComponent: number | null = null;
  if (
    input.estimatedPetSec !== undefined &&
    input.estimatedPetSec !== null &&
    Number.isFinite(input.estimatedPetSec)
  ) {
    const pet = Math.max(0.1, input.estimatedPetSec);
    if (pet <= 1.0) petComponent = 94;
    else if (pet <= 1.8) petComponent = 78;
    else if (pet <= 3.0) petComponent = 54;
    else if (pet <= 4.5) petComponent = 30;
    else petComponent = 12;

    weightedComponents.push({ weight: 0.14, score: petComponent });
    if (pet <= 1.8) {
      contributingFactors.push(
        `Short Post-Encroachment Time (~${pet.toFixed(1)}s between shared conflict-zone occupancy)`
      );
    }
  }

  // 3. Estimated Minimum Separation in image space (weight 0.22)
  let separationComponent: number | null = null;
  if (
    input.estimatedMinSeparationPx !== null &&
    Number.isFinite(input.estimatedMinSeparationPx)
  ) {
    const px = Math.max(0, input.estimatedMinSeparationPx);
    if (px <= 28) separationComponent = 92;
    else if (px <= 55) separationComponent = 74;
    else if (px <= 95) separationComponent = 48;
    else if (px <= 150) separationComponent = 26;
    else separationComponent = 10;

    weightedComponents.push({ weight: 0.22, score: separationComponent });
    if (px <= 55) {
      contributingFactors.push(
        `Small estimated spatial clearance (${Math.round(px)} px in image plane)`
      );
    }
  } else {
    measurementLimitations.push(
      'Minimum inter-object separation unavailable due to partial frame framing.'
    );
  }

  // 4. Relative Pixel Velocity (weight 0.14)
  let relativeSpeedComponent: number | null = null;
  if (
    input.relativeSpeedPxPerSec !== null &&
    Number.isFinite(input.relativeSpeedPxPerSec)
  ) {
    const spd = Math.max(0, input.relativeSpeedPxPerSec);
    if (spd >= 220) relativeSpeedComponent = 90;
    else if (spd >= 150) relativeSpeedComponent = 70;
    else if (spd >= 90) relativeSpeedComponent = 48;
    else relativeSpeedComponent = 22;

    weightedComponents.push({ weight: 0.14, score: relativeSpeedComponent });
    if (spd >= 150) {
      contributingFactors.push(
        `High relative pixel-plane closing motion (~${Math.round(spd)} px/s)`
      );
    }
  } else {
    measurementLimitations.push(
      'Relative speed magnitude unavailable for this interaction.'
    );
  }

  // 5. Trajectory Convergence Angle (weight 0.12)
  let convergenceComponent: number | null = null;
  if (
    input.trajectoryConvergenceDeg !== null &&
    Number.isFinite(input.trajectoryConvergenceDeg)
  ) {
    const angle = clamp(Math.abs(input.trajectoryConvergenceDeg), 0, 180);
    if (angle >= 55 && angle <= 135) convergenceComponent = 88; // crossing / turning conflict
    else if (angle > 135) convergenceComponent = 94; // opposing / wrong-way
    else if (angle >= 25) convergenceComponent = 62; // merging
    else convergenceComponent = 28; // near-parallel

    weightedComponents.push({ weight: 0.12, score: convergenceComponent });
    if (angle >= 55 && angle <= 135) {
      contributingFactors.push(
        `Intersecting trajectory convergence (${Math.round(angle)}° crossing angle)`
      );
    } else if (angle > 135) {
      contributingFactors.push(
        `Opposing movement vector (${Math.round(angle)}° head-on/wrong-direction vector)`
      );
    } else if (angle >= 25) {
      contributingFactors.push(
        `Converging merge vector (${Math.round(angle)}° merge angle)`
      );
    }
  } else {
    measurementLimitations.push(
      'Trajectory convergence angle could not be computed across sufficient consecutive frames.'
    );
  }

  // 6. Road-User Vulnerability & Mass Differential (weight 0.12)
  const hasVulnerable = input.roadUsers.some((u) => VULNERABLE_CLASSES.has(u));
  const hasPedestrian = input.roadUsers.includes('person');
  const hasHeavy = input.roadUsers.some((u) => HEAVY_CLASSES.has(u));
  let vulnerabilityComponent = 35;
  if (
    hasPedestrian &&
    (hasHeavy ||
      input.roadUsers.includes('car') ||
      input.roadUsers.includes('motorcycle') ||
      input.roadUsers.includes('scooter'))
  ) {
    vulnerabilityComponent = 95;
    contributingFactors.push('Vulnerable pedestrian interacting directly with motorized traffic');
  } else if (hasVulnerable && hasHeavy) {
    vulnerabilityComponent = 90;
    contributingFactors.push('Mass differential between vulnerable two-wheeler and heavy vehicle');
  } else if (hasVulnerable && input.roadUsers.length >= 2) {
    vulnerabilityComponent = 76;
    contributingFactors.push('Vulnerable two-wheeler, scooter, or cyclist exposed in conflict zone');
  } else if (hasHeavy) {
    vulnerabilityComponent = 65;
    contributingFactors.push('Heavy commercial vehicle involved with longer stopping distance');
  }
  weightedComponents.push({ weight: 0.12, score: vulnerabilityComponent });

  // Behavioral modifiers
  let modifier = 0;
  if (input.abruptDecelerationDetected) {
    modifier += 8;
    contributingFactors.push('Abrupt braking or sudden velocity drop observed');
  }
  if (input.evasiveManeuverDetected) {
    modifier += 6;
    contributingFactors.push('Sudden evasive lateral movement or swerve vector detected');
  }
  if (input.wrongDirectionDetected) {
    modifier += 12;
    contributingFactors.push('Counter-flow / wrong-direction movement relative to lane stream');
  }

  // Normalize across available weights so missing inputs never distort scale
  const totalWeight = weightedComponents.reduce((acc, item) => acc + item.weight, 0);
  const baseScore =
    totalWeight > 0
      ? weightedComponents.reduce((acc, item) => acc + item.score * item.weight, 0) / totalWeight
      : 20;

  const finalScore = Math.round(clamp(baseScore + modifier, 0, 100));
  const riskCategory = classifyRiskBand(finalScore, bands);
  const interactionTier: 'Potential conflict' | 'Near miss' =
    finalScore >= 65 ||
    (input.estimatedTtcSec !== null && input.estimatedTtcSec <= 1.5) ||
    (input.estimatedPetSec !== undefined &&
      input.estimatedPetSec !== null &&
      input.estimatedPetSec <= 1.2)
      ? 'Near miss'
      : 'Potential conflict';

  // Explicit measurement quality disclosures
  if (input.measurementQuality === 'uncalibrated_pixel') {
    measurementLimitations.push(
      'Camera homography calibration not configured: distances and speeds are pixel-space estimates, not physical meters or km/h.'
    );
  } else if (input.measurementQuality === 'partial_occlusion') {
    measurementLimitations.push(
      'Partial visual occlusion detected near interaction peak; bounding-box centroid trajectory may have higher variance.'
    );
  }

  if (input.detectionConfidence < 0.72) {
    measurementLimitations.push(
      `Moderate object detection confidence (${Math.round(input.detectionConfidence * 100)}%); analyst video review strongly advised.`
    );
  }

  measurementLimitations.push(
    'Risk score (0–100) uses provisional configuration bands for safety triage and is not a validated accident probability.'
  );

  return {
    riskScore: finalScore,
    riskCategory,
    interactionTier,
    detectionConfidence: Number(clamp(input.detectionConfidence, 0, 1).toFixed(2)),
    contributingFactors,
    measurementLimitations,
    formulaVersion: RISK_FORMULA_VERSION,
    isProvisional: true,
    factorBreakdown: {
      ttcComponent,
      petComponent,
      separationComponent,
      relativeSpeedComponent,
      convergenceComponent,
      vulnerabilityComponent,
    },
  };
}
