import type {
  ConflictEvent,
  ConflictFingerprint,
  JunctionInterventionDefinition,
  JunctionInterventionId,
  JunctionMetricSnapshot,
  JunctionSimulationResult,
  RoadLocation,
} from '../types/roadshadow';

export const JUNCTION_INTERVENTIONS: JunctionInterventionDefinition[] = [
  {
    id: 'pedestrian_crossing_relocation',
    label: 'Pedestrian Crossing Relocation',
    category: 'Pedestrian Infrastructure',
    summary:
      'Set back zebra crosswalk 6m from the turning sweep zone with curb ramps and clear sight triangles.',
    primaryTargetConflicts: ['Pedestrian versus vehicle', 'Crossing conflict'],
    estimatedCostBand: 'Low',
    tradeoffNote: 'Adds ~2–4s walking distance for pedestrians while removing turning blind-spot overlap.',
  },
  {
    id: 'lane_markings',
    label: 'Improved Lane Markings & Advance Stop Box',
    category: 'Signage & Marking',
    summary:
      'High-contrast thermoplastic lane dividers, chevron gore hatching, and a 4m two-wheeler advance stop box.',
    primaryTargetConflicts: ['Motorcycle versus turning car', 'Unsafe merging', 'Crossing conflict'],
    estimatedCostBand: 'Low',
    tradeoffNote: 'Requires periodic municipal repainting before monsoon seasons to maintain retroreflectivity.',
  },
  {
    id: 'signal_timing',
    label: 'Signal Timing Adjustments (Protected Turn & All-Red)',
    category: 'Signal Timing',
    summary:
      'Add a 10–12s protected right-turn arrow phase and +2s all-red clearance interval during peak hours.',
    primaryTargetConflicts: ['Motorcycle versus turning car', 'Crossing conflict', 'Vehicle intersection conflict'],
    estimatedCostBand: 'Low',
    tradeoffNote: 'Slightly increases average per-cycle wait time (+4 to +7s) in exchange for separated turning conflicts.',
  },
  {
    id: 'dedicated_turning_lanes',
    label: 'Dedicated Turning Lanes & Channelization',
    category: 'Engineering',
    summary:
      'Separate right-turning and straight-through queues using mountable channelizing curbs and painted storage pockets.',
    primaryTargetConflicts: ['Motorcycle versus turning car', 'Sudden braking', 'Vehicle intersection conflict'],
    estimatedCostBand: 'Medium',
    tradeoffNote: 'Requires minimum carriageway width audit; removes informal curbside auto-rickshaw parking near approach.',
  },
  {
    id: 'pedestrian_separation',
    label: 'Pedestrian Separation (Refuge Island & Exclusive Phase)',
    category: 'Pedestrian Infrastructure',
    summary:
      'Introduce a raised 1.8m median refuge island with protective bollards and dedicated pedestrian crossing interval.',
    primaryTargetConflicts: ['Pedestrian versus vehicle'],
    estimatedCostBand: 'Medium',
    tradeoffNote: 'Reduces pedestrian exposure significantly; introduces a modest cycle delay for motorised approaches.',
  },
  {
    id: 'traffic_flow_modifications',
    label: 'Traffic Flow & Merge Taper Modifications',
    category: 'Engineering',
    summary:
      'Extend slip-road merge taper by 40m with flexible spring delineators and close hazardous informal median gaps.',
    primaryTargetConflicts: ['Unsafe merging', 'Wrong-direction movement', 'Sudden braking'],
    estimatedCostBand: 'Medium',
    tradeoffNote: 'May lengthen local U-turn detour by 150–250m to eliminate counter-flow shortcuts.',
  },
  {
    id: 'road_signage',
    label: 'Improved Road Signage & Speed-Calming Strips',
    category: 'Signage & Marking',
    summary:
      'Install IRC-compliant retroreflective warning boards, solar amber beacons, and transverse rumble strips 45m upstream.',
    primaryTargetConflicts: ['Sudden braking', 'Pedestrian versus vehicle', 'Wrong-direction movement'],
    estimatedCostBand: 'Low',
    tradeoffNote: 'Low cost and quick deployment; greatest impact when combined with geometric or signal controls.',
  },
];

interface InterventionEffectProfile {
  conflictReductionRatio: number;
  riskIndexReductionRatio: number;
  waitTimeDeltaSec: number;
  throughputDeltaPct: number;
  pedCrossingDeltaSec: number;
  strongConflictTypes: string[];
}

const EFFECT_PROFILES: Record<JunctionInterventionId, InterventionEffectProfile> = {
  pedestrian_crossing_relocation: {
    conflictReductionRatio: 0.14,
    riskIndexReductionRatio: 0.13,
    waitTimeDeltaSec: -1.5,
    throughputDeltaPct: 0.02,
    pedCrossingDeltaSec: -2.2,
    strongConflictTypes: ['Pedestrian versus vehicle', 'Crossing conflict'],
  },
  lane_markings: {
    conflictReductionRatio: 0.16,
    riskIndexReductionRatio: 0.14,
    waitTimeDeltaSec: -2.5,
    throughputDeltaPct: 0.05,
    pedCrossingDeltaSec: -0.8,
    strongConflictTypes: ['Motorcycle versus turning car', 'Unsafe merging', 'Crossing conflict'],
  },
  signal_timing: {
    conflictReductionRatio: 0.24,
    riskIndexReductionRatio: 0.22,
    waitTimeDeltaSec: 5.2,
    throughputDeltaPct: -0.02,
    pedCrossingDeltaSec: -3.5,
    strongConflictTypes: ['Motorcycle versus turning car', 'Crossing conflict', 'Vehicle intersection conflict'],
  },
  dedicated_turning_lanes: {
    conflictReductionRatio: 0.22,
    riskIndexReductionRatio: 0.2,
    waitTimeDeltaSec: -6.4,
    throughputDeltaPct: 0.11,
    pedCrossingDeltaSec: -0.5,
    strongConflictTypes: ['Motorcycle versus turning car', 'Sudden braking', 'Vehicle intersection conflict'],
  },
  pedestrian_separation: {
    conflictReductionRatio: 0.2,
    riskIndexReductionRatio: 0.23,
    waitTimeDeltaSec: 3.4,
    throughputDeltaPct: -0.01,
    pedCrossingDeltaSec: -5.4,
    strongConflictTypes: ['Pedestrian versus vehicle'],
  },
  traffic_flow_modifications: {
    conflictReductionRatio: 0.19,
    riskIndexReductionRatio: 0.18,
    waitTimeDeltaSec: -4.1,
    throughputDeltaPct: 0.08,
    pedCrossingDeltaSec: -0.6,
    strongConflictTypes: ['Unsafe merging', 'Wrong-direction movement', 'Sudden braking'],
  },
  road_signage: {
    conflictReductionRatio: 0.1,
    riskIndexReductionRatio: 0.11,
    waitTimeDeltaSec: 0.4,
    throughputDeltaPct: 0.01,
    pedCrossingDeltaSec: -1.2,
    strongConflictTypes: ['Sudden braking', 'Pedestrian versus vehicle', 'Wrong-direction movement'],
  },
};

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function round1(val: number): number {
  return Math.round(val * 10) / 10;
}

/**
 * Pure deterministic analytical junction micro-simulation estimator.
 * Derives baseline indicators from observed ROADSHADOW conflict records at a junction
 * and projects comparative Existing vs Proposed metrics using diminishing-return safety
 * modification factors (aligned with Crash Modification Factor compounding principles).
 *
 * IMPORTANT: Outputs are clearly marked as simulation estimates, NOT measured real-world outcomes.
 */
export function runJunctionImprovementSimulation(params: {
  location: RoadLocation;
  locationEvents: ConflictEvent[];
  locationFingerprints: ConflictFingerprint[];
  selectedInterventions: JunctionInterventionId[];
}): JunctionSimulationResult {
  const { location, locationEvents, locationFingerprints, selectedInterventions } = params;
  const nonFalse = locationEvents.filter((e) => e.validationStatus !== 'False positive');
  const uniqueInterventions = Array.from(new Set(selectedInterventions));

  // Derive realistic baseline metrics anchored to location type + actual observed conflicts
  const baseByType: Record<
    RoadLocation['locationType'],
    { waitSec: number; throughput: number; pedSec: number; baseConflictsPerHr: number }
  > = {
    Intersection: { waitSec: 46, throughput: 1620, pedSec: 26, baseConflictsPerHr: 6.5 },
    Highway: { waitSec: 18, throughput: 2450, pedSec: 32, baseConflictsPerHr: 5.2 },
    'School zone': { waitSec: 28, throughput: 890, pedSec: 22, baseConflictsPerHr: 5.8 },
    'Hospital zone': { waitSec: 34, throughput: 1120, pedSec: 24, baseConflictsPerHr: 4.9 },
    'Commercial road': { waitSec: 39, throughput: 1380, pedSec: 25, baseConflictsPerHr: 5.6 },
    'Residential road': { waitSec: 19, throughput: 640, pedSec: 16, baseConflictsPerHr: 3.1 },
    'Pedestrian crossing': { waitSec: 26, throughput: 980, pedSec: 23, baseConflictsPerHr: 5.4 },
    Other: { waitSec: 30, throughput: 1050, pedSec: 21, baseConflictsPerHr: 4.4 },
  };

  const anchor = baseByType[location.locationType] ?? baseByType.Intersection;
  const avgObservedRisk =
    nonFalse.length > 0
      ? nonFalse.reduce((acc, ev) => acc + ev.riskScore, 0) / nonFalse.length
      : 42;
  const criticalCount = nonFalse.filter((e) => e.riskCategory === 'Critical').length;

  const existing: JunctionMetricSnapshot = {
    simulatedConflictRatePerHr: round1(
      anchor.baseConflictsPerHr + nonFalse.length * 1.15 + criticalCount * 0.65
    ),
    avgWaitTimeSec: round1(anchor.waitSec + Math.min(18, nonFalse.length * 0.9)),
    throughputVehPerHr: Math.round(anchor.throughput - Math.min(180, nonFalse.length * 14)),
    pedestrianCrossingSec: round1(
      anchor.pedSec +
        nonFalse.filter((e) => e.conflictType === 'Pedestrian versus vehicle').length * 1.4
    ),
    estimatedRiskIndex: Math.round(clamp(avgObservedRisk, 15, 96)),
  };

  // Determine dominant observed conflict types at this junction so matching interventions get realistic relevance bonus
  const observedTypeCounts = new Map<string, number>();
  for (const ev of nonFalse) {
    observedTypeCounts.set(ev.conflictType, (observedTypeCounts.get(ev.conflictType) ?? 0) + 1);
  }
  const totalObserved = Math.max(1, nonFalse.length);

  // Multiplicative CMF compounding prevents unrealistic >100% reduction
  let remainingConflictFactor = 1.0;
  let remainingRiskFactor = 1.0;
  let waitDelta = 0;
  let throughputDeltaPct = 0;
  let pedDelta = 0;
  const engineeringNotes: string[] = [];

  for (const id of uniqueInterventions) {
    const prof = EFFECT_PROFILES[id];
    const def = JUNCTION_INTERVENTIONS.find((item) => item.id === id);
    if (!prof || !def) continue;

    // Relevance multiplier (0.75 to 1.25) based on how closely this intervention targets observed conflicts
    const matchedEvents = prof.strongConflictTypes.reduce(
      (sum, ct) => sum + (observedTypeCounts.get(ct) ?? 0),
      0
    );
    const matchShare = matchedEvents / totalObserved;
    const relevanceMultiplier = nonFalse.length > 0 ? 0.75 + matchShare * 0.5 : 1.0;

    const effConflictRed = clamp(prof.conflictReductionRatio * relevanceMultiplier, 0.05, 0.34);
    const effRiskRed = clamp(prof.riskIndexReductionRatio * relevanceMultiplier, 0.05, 0.32);

    remainingConflictFactor *= 1 - effConflictRed;
    remainingRiskFactor *= 1 - effRiskRed;
    waitDelta += prof.waitTimeDeltaSec;
    throughputDeltaPct += prof.throughputDeltaPct;
    pedDelta += prof.pedCrossingDeltaSec;

    if (matchedEvents > 0) {
      engineeringNotes.push(
        `${def.label} directly addresses ${matchedEvents} observed conflict event(s) at ${location.name} (${Math.round(matchShare * 100)}% of site detections).`
      );
    } else {
      engineeringNotes.push(
        `${def.label} provides general preventive geometry/guidance improvement (baseline factor applied).`
      );
    }
  }

  // Cap compounded reductions conservatively (engineering reality: physical interventions cannot eliminate 100% of human-error conflicts)
  const effectiveConflictFactor = Math.max(0.28, remainingConflictFactor);
  const effectiveRiskFactor = Math.max(0.32, remainingRiskFactor);

  const proposed: JunctionMetricSnapshot = {
    simulatedConflictRatePerHr: round1(existing.simulatedConflictRatePerHr * effectiveConflictFactor),
    avgWaitTimeSec: round1(clamp(existing.avgWaitTimeSec + waitDelta, 10, 120)),
    throughputVehPerHr: Math.round(
      existing.throughputVehPerHr * clamp(1 + throughputDeltaPct, 0.85, 1.32)
    ),
    pedestrianCrossingSec: round1(clamp(existing.pedestrianCrossingSec + pedDelta, 8, 60)),
    estimatedRiskIndex: Math.round(clamp(existing.estimatedRiskIndex * effectiveRiskFactor, 8, 96)),
  };

  const deltas = {
    conflictRatePctChange:
      existing.simulatedConflictRatePerHr > 0
        ? round1(
            ((proposed.simulatedConflictRatePerHr - existing.simulatedConflictRatePerHr) /
              existing.simulatedConflictRatePerHr) *
              100
          )
        : 0,
    waitTimeDeltaSec: round1(proposed.avgWaitTimeSec - existing.avgWaitTimeSec),
    throughputPctChange:
      existing.throughputVehPerHr > 0
        ? round1(
            ((proposed.throughputVehPerHr - existing.throughputVehPerHr) /
              existing.throughputVehPerHr) *
              100
          )
        : 0,
    pedestrianCrossingDeltaSec: round1(
      proposed.pedestrianCrossingSec - existing.pedestrianCrossingSec
    ),
    riskIndexPctChange:
      existing.estimatedRiskIndex > 0
        ? round1(
            ((proposed.estimatedRiskIndex - existing.estimatedRiskIndex) /
              existing.estimatedRiskIndex) *
              100
          )
        : 0,
  };

  const simulationCaveats = [
    'Simulation Estimate Only: Projected figures are derived from ROADSHADOW analytical modification factors and observed conflict baselines, not measured post-construction traffic outcomes.',
    locationFingerprints.length === 0
      ? 'No established Conflict Fingerprints recorded at this junction yet; gather additional multi-day footage before committing capital civil works.'
      : `Baseline calibrated against ${nonFalse.length} stored interaction event(s) and ${locationFingerprints.length} conflict fingerprint(s) at ${location.name}.`,
    'For full lane-by-lane vehicle micro-simulation, connect an external SUMO (Simulation of Urban MObility) worker via SUMO_SERVICE_URL.',
  ];

  return {
    locationId: location.id,
    locationName: location.name,
    selectedInterventions: uniqueInterventions,
    engineMode: 'ANALYTICAL_MODEL',
    isSimulationEstimate: true,
    existing,
    proposed,
    deltas,
    engineeringNotes,
    simulationCaveats,
  };
}
