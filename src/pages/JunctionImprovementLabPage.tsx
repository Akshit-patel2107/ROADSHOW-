import { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AlertTriangle,
  CheckCircle2,
  FlaskConical,
  Info,
  RotateCcw,
  Save,
  Sparkles,
} from 'lucide-react';
import { useRoadshadow } from '../context/RoadshadowContext';
import {
  JUNCTION_INTERVENTIONS,
  runJunctionImprovementSimulation,
} from '../engine/junctionSimulation';
import { buildConflictFingerprints } from '../engine/conflictFingerprint';
import { canPerformAction } from '../engine/validation';
import type { JunctionInterventionId } from '../types/roadshadow';

export function JunctionImprovementLabPage() {
  const {
    currentUser,
    locations,
    conflictEvents,
    selectedProjectId,
    serverHealth,
    createRecommendation,
    pushToast,
  } = useRoadshadow();

  const canSaveRec = currentUser ? canPerformAction(currentUser.role, 'review_events') : false;

  const scopedLocations = useMemo(
    () =>
      locations.filter((l) =>
        selectedProjectId === 'ALL' ? true : l.projectId === selectedProjectId
      ),
    [locations, selectedProjectId]
  );

  const [selectedLocationId, setSelectedLocationId] = useState(scopedLocations[0]?.id || '');
  const [selectedInterventions, setSelectedInterventions] = useState<JunctionInterventionId[]>([
    'pedestrian_crossing_relocation',
    'signal_timing',
  ]);
  const [savingProposals, setSavingProposals] = useState(false);

  useEffect(() => {
    if (scopedLocations.length === 0) {
      setSelectedLocationId('');
      return;
    }
    if (!selectedLocationId || !scopedLocations.some((l) => l.id === selectedLocationId)) {
      setSelectedLocationId(scopedLocations[0].id);
    }
  }, [scopedLocations, selectedLocationId]);

  const activeLocation =
    scopedLocations.find((l) => l.id === selectedLocationId) ?? scopedLocations[0] ?? null;

  const locationEvents = useMemo(
    () => (activeLocation ? conflictEvents.filter((e) => e.locationId === activeLocation.id) : []),
    [conflictEvents, activeLocation]
  );

  const locationFingerprints = useMemo(
    () => (activeLocation ? buildConflictFingerprints(locationEvents, [activeLocation]) : []),
    [locationEvents, activeLocation]
  );

  const simulation = useMemo(() => {
    if (!activeLocation) return null;
    return runJunctionImprovementSimulation({
      location: activeLocation,
      locationEvents,
      locationFingerprints,
      selectedInterventions,
    });
  }, [activeLocation, locationEvents, locationFingerprints, selectedInterventions]);

  const toggleIntervention = (id: JunctionInterventionId) => {
    setSelectedInterventions((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const applyRecommendedPackage = () => {
    const types = new Set(locationEvents.map((e) => e.conflictType));
    const recommended: JunctionInterventionId[] = [];
    if (types.has('Pedestrian versus vehicle') || types.has('Crossing conflict')) {
      recommended.push('pedestrian_crossing_relocation', 'pedestrian_separation');
    }
    if (types.has('Motorcycle versus turning car') || types.has('Vehicle intersection conflict')) {
      recommended.push('lane_markings', 'signal_timing', 'dedicated_turning_lanes');
    }
    if (types.has('Unsafe merging') || types.has('Wrong-direction movement') || types.has('Sudden braking')) {
      recommended.push('traffic_flow_modifications', 'road_signage');
    }
    if (recommended.length === 0) {
      recommended.push('pedestrian_crossing_relocation', 'signal_timing', 'road_signage');
    }
    setSelectedInterventions(Array.from(new Set(recommended)));
  };

  const handleSaveToRecommendations = async () => {
    if (!activeLocation || !simulation || selectedInterventions.length === 0 || !canSaveRec) return;
    setSavingProposals(true);
    try {
      const selectedDefs = selectedInterventions
        .map((id) => JUNCTION_INTERVENTIONS.find((i) => i.id === id))
        .filter((d): d is NonNullable<typeof d> => Boolean(d));
      const names = selectedDefs.map((d) => d.label).join(', ');

      await createRecommendation({
        projectId: activeLocation.projectId,
        locationId: activeLocation.id,
        title: `Junction Improvement Package — ${activeLocation.name}`,
        category: 'Engineering',
        priority: simulation.existing.estimatedRiskIndex >= 65 ? 'High' : 'Medium',
        rationale: `Selected in ROADSHADOW Junction Improvement Lab (${names}). Analytical simulation estimates ${Math.abs(simulation.deltas.conflictRatePctChange)}% reduction in simulated conflict rate (${simulation.existing.simulatedConflictRatePerHr}/hr -> ${simulation.proposed.simulatedConflictRatePerHr}/hr) and ${Math.abs(simulation.deltas.riskIndexPctChange)}% risk index reduction. Subject to field engineering validation and IRC geometric audit.`,
        evidenceSummary: `Calibrated against ${locationEvents.length} observed interaction event(s) and ${locationFingerprints.length} conflict fingerprint(s) at ${activeLocation.name}.`,
        implementationSteps: selectedDefs.map((d) => `${d.label}: ${d.summary}`),
        status: 'Proposed',
        generatedByAi: false,
      });
      pushToast({
        type: 'success',
        title: 'Improvement Proposal Saved',
        description: 'Added to Safety Recommendations for municipal engineering review.',
      });
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Failed to Save Proposal',
        description: err instanceof Error ? err.message : 'Database save failed.',
      });
    } finally {
      setSavingProposals(false);
    }
  };

  const comparisonChartData = useMemo(() => {
    if (!simulation) return [];
    return [
      {
        metric: 'Conflicts / hr',
        Existing: simulation.existing.simulatedConflictRatePerHr,
        Proposed: simulation.proposed.simulatedConflictRatePerHr,
      },
      {
        metric: 'Avg Wait (s)',
        Existing: simulation.existing.avgWaitTimeSec,
        Proposed: simulation.proposed.avgWaitTimeSec,
      },
      {
        metric: 'Ped Cross (s)',
        Existing: simulation.existing.pedestrianCrossingSec,
        Proposed: simulation.proposed.pedestrianCrossingSec,
      },
      {
        metric: 'Risk Index',
        Existing: simulation.existing.estimatedRiskIndex,
        Proposed: simulation.proposed.estimatedRiskIndex,
      },
    ];
  }, [simulation]);

  const has = (id: JunctionInterventionId) => selectedInterventions.includes(id);

  if (!activeLocation || !simulation) {
    return (
      <div className="bg-[#122943] border border-[#233B56] rounded-lg p-10 text-center max-w-xl mx-auto">
        <FlaskConical className="w-8 h-8 text-[#45B5FF] mx-auto" />
        <h1 className="text-lg font-semibold text-[#F5F8FC] mt-3">No Monitored Junctions Available</h1>
        <p className="text-sm text-[#A9B8CA] mt-2">
          Register at least one road location under your selected project to run interactive junction improvement simulations.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page Header & Junction Selector */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[#F5F8FC]">Junction Improvement Lab</h1>
          <p className="text-sm text-[#A9B8CA] mt-1">
            Interactive engineering sandbox comparing existing junction layouts against proposed IRC-aligned safety interventions.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="lab-junction-select" className="text-xs text-[#A9B8CA]">
            Target Junction:
          </label>
          <select
            id="lab-junction-select"
            value={activeLocation.id}
            onChange={(e) => setSelectedLocationId(e.target.value)}
            className="bg-[#122943] border border-[#233B56] text-[#F5F8FC] text-sm rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[#2585FF]"
          >
            {scopedLocations.map((loc) => (
              <option key={loc.id} value={loc.id}>
                {loc.name} ({loc.city})
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={applyRecommendedPackage}
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-[#122943] hover:bg-[#1B3A5E] border border-[#2585FF]/40 text-xs font-medium text-[#45B5FF] rounded-md whitespace-nowrap transition-colors"
          >
            <Sparkles className="w-3.5 h-3.5" />
            Apply Conflict-Matched Package
          </button>

          <button
            type="button"
            onClick={() => setSelectedInterventions([])}
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-[#0D1F35] hover:bg-[#1B3A5E] border border-[#233B56] text-xs font-medium text-[#A9B8CA] hover:text-[#F5F8FC] rounded-md whitespace-nowrap transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset
          </button>
        </div>
      </div>

      {/* Transparent Simulation Disclaimer & SUMO Adapter Status */}
      <div className="p-4 rounded-lg bg-[#122943] border border-[#EAB308]/35 flex items-start gap-3">
        <Info className="w-5 h-5 text-[#EAB308] mt-0.5 shrink-0" />
        <div className="text-xs text-[#A9B8CA] leading-relaxed">
          <p className="text-sm font-medium text-[#F5F8FC]">
            Simulation Estimate Only —{' '}
            {simulation.engineMode === 'SUMO_WORKER'
              ? 'External SUMO Microsimulation Engine'
              : 'Deterministic IRC Analytical Estimator'}
          </p>
          <p className="mt-1">
            {simulation.simulationCaveats[0]} External SUMO Microsimulation Worker:{' '}
            <strong className="text-[#F5F8FC]">
              {serverHealth.sumoConfigured
                ? 'Connected via SUMO_SERVICE_URL'
                : 'Not configured (running analytical estimator)'}
            </strong>
            .
          </p>
        </div>
      </div>

      {/* Main Split: Left Interventions + Observed Fingerprints, Right Comparative Layout & Metrics */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        {/* Left Column: Selectable Engineering Interventions */}
        <div className="xl:col-span-5 space-y-4">
          <div className="bg-[#122943] border border-[#233B56] rounded-lg p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-[#F5F8FC]">
                Proposed Interventions ({selectedInterventions.length})
              </h2>
              <span className="text-xs font-mono text-[#A9B8CA]">
                {locationEvents.length} observed events
              </span>
            </div>

            <div className="space-y-2.5">
              {JUNCTION_INTERVENTIONS.map((item) => {
                const checked = has(item.id);
                return (
                  <label
                    key={item.id}
                    className={`flex items-start gap-3 p-3 rounded-md border cursor-pointer transition-colors ${
                      checked
                        ? 'bg-[#0D1F35] border-[#2585FF]'
                        : 'bg-[#0D1F35]/60 border-[#233B56] hover:border-[#2585FF]/50'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleIntervention(item.id)}
                      className="mt-1 accent-[#2585FF]"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-[#F5F8FC]">{item.label}</span>
                        <span className="text-[11px] font-mono text-[#45B5FF] shrink-0">
                          {item.estimatedCostBand} Cost
                        </span>
                      </div>
                      <p className="text-xs text-[#A9B8CA] mt-1 leading-relaxed">
                        {item.summary}
                      </p>
                      <p className="text-[11px] text-[#A9B8CA]/80 mt-1">
                        Trade-off: {item.tradeoffNote}
                      </p>
                    </div>
                  </label>
                );
              })}
            </div>

            <button
              type="button"
              disabled={!canSaveRec || selectedInterventions.length === 0 || savingProposals}
              onClick={() => void handleSaveToRecommendations()}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-[#2585FF] hover:bg-[#1C74E8] disabled:opacity-50 text-white text-sm font-medium rounded-md transition-colors whitespace-nowrap"
            >
              <Save className="w-4 h-4" />
              {savingProposals ? 'Saving Proposal...' : 'Save Selected Proposals to Recommendations'}
            </button>
          </div>

          {/* Observed Recurring Conflict Fingerprints at this Junction */}
          <div className="bg-[#122943] border border-[#233B56] rounded-lg p-5 space-y-3">
            <h2 className="text-sm font-semibold text-[#F5F8FC]">
              Observed Conflict Fingerprints at {activeLocation.name}
            </h2>
            {locationFingerprints.length === 0 ? (
              <p className="text-xs text-[#A9B8CA]">
                No recurring fingerprints clustered at this site yet; baseline metrics use default intersection traffic assumptions.
              </p>
            ) : (
              <div className="space-y-2">
                {locationFingerprints.slice(0, 4).map((fp) => (
                  <div
                    key={fp.id}
                    className="p-3 rounded-md bg-[#0D1F35] border border-[#233B56] text-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-[#F5F8FC]">{fp.conflictType}</span>
                      <span className="font-mono text-[#45B5FF]">
                        {fp.observedCount} events · {fp.timeWindow}
                      </span>
                    </div>
                    <p className="text-[#A9B8CA] mt-1">
                      {fp.conflictZone || 'Junction conflict zone'} · {fp.roadUserCombo}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Existing vs Proposed Metrics, Interactive Layout Schematic & Comparison Chart */}
        <div className="xl:col-span-7 space-y-6">
          {/* Existing vs Proposed KPI Comparison Grid */}
          <div className="bg-[#122943] border border-[#233B56] rounded-lg p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-[#F5F8FC]">
                Existing vs Proposed Simulation Estimates
              </h2>
              <span className="text-xs font-mono text-[#22C55E]">
                Est. Conflict Rate Change: {simulation.deltas.conflictRatePctChange}%
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
              {[
                {
                  label: 'Conflicts / hr',
                  existing: `${simulation.existing.simulatedConflictRatePerHr}`,
                  proposed: `${simulation.proposed.simulatedConflictRatePerHr}`,
                  delta: `${simulation.deltas.conflictRatePctChange}%`,
                  positive: simulation.deltas.conflictRatePctChange <= 0,
                },
                {
                  label: 'Avg Wait (s)',
                  existing: `${simulation.existing.avgWaitTimeSec}s`,
                  proposed: `${simulation.proposed.avgWaitTimeSec}s`,
                  delta: `${simulation.deltas.waitTimeDeltaSec > 0 ? '+' : ''}${simulation.deltas.waitTimeDeltaSec}s`,
                  positive: simulation.deltas.waitTimeDeltaSec <= 0,
                },
                {
                  label: 'Throughput',
                  existing: `${simulation.existing.throughputVehPerHr}`,
                  proposed: `${simulation.proposed.throughputVehPerHr}`,
                  delta: `${simulation.deltas.throughputPctChange > 0 ? '+' : ''}${simulation.deltas.throughputPctChange}%`,
                  positive: simulation.deltas.throughputPctChange >= 0,
                },
                {
                  label: 'Ped Cross (s)',
                  existing: `${simulation.existing.pedestrianCrossingSec}s`,
                  proposed: `${simulation.proposed.pedestrianCrossingSec}s`,
                  delta: `${simulation.deltas.pedestrianCrossingDeltaSec > 0 ? '+' : ''}${simulation.deltas.pedestrianCrossingDeltaSec}s`,
                  positive: simulation.deltas.pedestrianCrossingDeltaSec <= 0,
                },
                {
                  label: 'Risk Index',
                  existing: `${simulation.existing.estimatedRiskIndex}`,
                  proposed: `${simulation.proposed.estimatedRiskIndex}`,
                  delta: `${simulation.deltas.riskIndexPctChange}%`,
                  positive: simulation.deltas.riskIndexPctChange <= 0,
                },
              ].map((card) => (
                <div
                  key={card.label}
                  className="bg-[#0D1F35] border border-[#233B56] rounded-md p-3 space-y-1.5"
                >
                  <p className="text-[11px] text-[#A9B8CA]">{card.label}</p>
                  <div className="flex items-baseline justify-between gap-1">
                    <span className="text-xs font-mono text-[#A9B8CA] line-through">
                      {card.existing}
                    </span>
                    <span className="text-lg font-bold font-mono tabular-nums text-[#F5F8FC]">
                      {card.proposed}
                    </span>
                  </div>
                  <p
                    className={`text-[11px] font-mono tabular-nums ${
                      card.positive ? 'text-[#22C55E]' : 'text-[#F97316]'
                    }`}
                  >
                    {card.delta}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* Interactive Junction Layout Schematic (SVG) */}
          <div className="bg-[#122943] border border-[#233B56] rounded-lg p-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-base font-semibold text-[#F5F8FC]">
                  Proposed Junction Layout Schematic
                </h2>
                <p className="text-xs text-[#A9B8CA]">
                  Toggle engineering interventions on the left to inspect spatial geometry updates
                </p>
              </div>
              <span className="text-xs font-mono text-[#45B5FF]">
                {activeLocation.locationType}
              </span>
            </div>

            <div className="rounded-md bg-[#071426] border border-[#233B56] p-3 overflow-x-auto">
              <svg
                viewBox="0 0 640 300"
                className="w-full h-64 min-w-[460px]"
                role="img"
                aria-label={`Interactive junction schematic for ${activeLocation.name}`}
              >
                {/* Road Asphalt Arms */}
                <rect x="0" y="105" width="640" height="90" fill="#132238" />
                <rect x="265" y="0" width="110" height="300" fill="#132238" />

                {/* Lane Dividers */}
                <line x1="0" y1="150" x2="255" y2="150" stroke="#64748B" strokeDasharray="8 6" strokeWidth="2" />
                <line x1="385" y1="150" x2="640" y2="150" stroke="#64748B" strokeDasharray="8 6" strokeWidth="2" />
                <line x1="320" y1="0" x2="320" y2="95" stroke="#64748B" strokeDasharray="8 6" strokeWidth="2" />
                <line x1="320" y1="205" x2="320" y2="300" stroke="#64748B" strokeDasharray="8 6" strokeWidth="2" />

                {/* Conflict Hotspot Core */}
                <circle
                  cx="320"
                  cy="150"
                  r={selectedInterventions.length >= 3 ? 20 : 34}
                  fill={selectedInterventions.length >= 3 ? 'rgba(34,197,94,0.18)' : 'rgba(229,72,77,0.22)'}
                  stroke={selectedInterventions.length >= 3 ? '#22C55E' : '#E5484D'}
                  strokeDasharray="4 4"
                  strokeWidth="2"
                />
                <text x="320" y="154" textAnchor="middle" fill="#F5F8FC" fontSize="10" fontFamily="monospace">
                  {selectedInterventions.length >= 3 ? 'MITIGATED CORE' : 'CONFLICT ZONE'}
                </text>

                {/* Pedestrian Crossing Relocation */}
                {has('pedestrian_crossing_relocation') ? (
                  <g>
                    <rect x="215" y="108" width="16" height="84" fill="none" stroke="#22C55E" strokeWidth="2" />
                    {[112, 124, 136, 148, 160, 172, 184].map((y) => (
                      <rect key={y} x="217" y={y} width="12" height="6" fill="#22C55E" />
                    ))}
                    <text x="148" y="96" fill="#22C55E" fontSize="10" fontFamily="monospace">
                      SET-BACK CROSSWALK (6m)
                    </text>
                  </g>
                ) : (
                  <g opacity="0.65">
                    {[112, 126, 140, 154, 168, 182].map((y) => (
                      <rect key={y} x="255" y={y} width="10" height="6" fill="#EAB308" />
                    ))}
                  </g>
                )}

                {/* Pedestrian Separation (Refuge Island) */}
                {has('pedestrian_separation') && (
                  <g>
                    <rect x="208" y="144" width="32" height="12" rx="4" fill="#38BDF8" />
                    <text x="148" y="214" fill="#38BDF8" fontSize="10" fontFamily="monospace">
                      REFUGE ISLAND
                    </text>
                  </g>
                )}

                {/* Dedicated Turning Lanes */}
                {has('dedicated_turning_lanes') && (
                  <g>
                    <path d="M 385 105 L 485 105 L 485 88 L 385 88 Z" fill="rgba(37,133,255,0.28)" stroke="#45B5FF" strokeWidth="1.5" />
                    <text x="392" y="80" fill="#45B5FF" fontSize="10" fontFamily="monospace">
                      TURN POCKET BAY
                    </text>
                  </g>
                )}

                {/* Improved Lane Markings & 2W Advance Stop Box */}
                {has('lane_markings') && (
                  <g>
                    <rect x="268" y="205" width="50" height="22" fill="rgba(249,115,22,0.28)" stroke="#F97316" strokeWidth="1.5" />
                    <text x="273" y="219" fill="#F97316" fontSize="9" fontFamily="monospace">
                      2W ASB
                    </text>
                  </g>
                )}

                {/* Traffic Flow & Merge Taper Modifications */}
                {has('traffic_flow_modifications') && (
                  <g>
                    <polygon points="375,195 450,195 375,235" fill="rgba(168,85,247,0.3)" stroke="#A855F7" strokeWidth="1.5" />
                    <text x="390" y="246" fill="#A855F7" fontSize="10" fontFamily="monospace">
                      CHANNELIZED MERGE
                    </text>
                  </g>
                )}

                {/* Signal Timing Adjustments */}
                {has('signal_timing') && (
                  <g>
                    <rect x="382" y="12" width="138" height="24" rx="4" fill="#0D1F35" stroke="#22C55E" />
                    <circle cx="394" cy="24" r="4" fill="#22C55E" />
                    <text x="404" y="27" fill="#F5F8FC" fontSize="9" fontFamily="monospace">
                      PROTECTED PHASE +2s
                    </text>
                  </g>
                )}

                {/* Improved Road Signage & Rumble Strips */}
                {has('road_signage') && (
                  <g>
                    <line x1="70" y1="112" x2="70" y2="188" stroke="#EAB308" strokeWidth="3" strokeDasharray="4 3" />
                    <line x1="82" y1="112" x2="82" y2="188" stroke="#EAB308" strokeWidth="3" strokeDasharray="4 3" />
                    <text x="24" y="96" fill="#EAB308" fontSize="10" fontFamily="monospace">
                      RUMBLE STRIPS
                    </text>
                  </g>
                )}
              </svg>
            </div>
          </div>

          {/* Comparative Bar Chart + Engineering Notes & Caveats */}
          <div className="bg-[#122943] border border-[#233B56] rounded-lg p-5 space-y-4">
            <h2 className="text-base font-semibold text-[#F5F8FC]">
              Before vs After Metric Comparison
            </h2>
            <div className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={comparisonChartData} margin={{ top: 8, right: 16, left: -12, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#233B56" />
                  <XAxis dataKey="metric" stroke="#A9B8CA" fontSize={12} />
                  <YAxis stroke="#A9B8CA" fontSize={12} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#0D1F35',
                      borderColor: '#233B56',
                      color: '#F5F8FC',
                      fontSize: '12px',
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: '12px' }} />
                  <Bar dataKey="Existing" fill="#E5484D" radius={[4, 4, 0, 0]} isAnimationActive={false} />
                  <Bar dataKey="Proposed" fill="#22C55E" radius={[4, 4, 0, 0]} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {simulation.engineeringNotes.length > 0 && (
              <div className="pt-3 border-t border-[#233B56] space-y-1.5">
                <p className="text-xs font-medium text-[#F5F8FC] flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 text-[#EAB308]" />
                  Engineering Assessment &amp; Field Validation Notes
                </p>
                {simulation.engineeringNotes.map((note, idx) => (
                  <p key={idx} className="text-xs text-[#A9B8CA] flex items-start gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-[#45B5FF] shrink-0 mt-0.5" />
                    <span>{note}</span>
                  </p>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
