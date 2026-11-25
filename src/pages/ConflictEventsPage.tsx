import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Cpu,
  Loader2,
  Play,
  Video,
} from 'lucide-react';
import { useRoadshadow } from '../context/RoadshadowContext';
import { RiskIndicator } from '../components/RiskBadge';
import { canPerformAction } from '../engine/validation';
import { roadshadowFetch } from '../lib/apiClient';
import type { ConflictType, RiskCategory, ValidationStatus } from '../types/roadshadow';

const CONFLICT_TYPES: ConflictType[] = [
  'Motorcycle versus turning car',
  'Pedestrian versus vehicle',
  'Unsafe merging',
  'Crossing conflict',
  'Wrong-direction movement',
  'Sudden braking',
  'Vehicle intersection conflict',
  'Other potential conflict',
];

const VALIDATION_STATUSES: ValidationStatus[] = [
  'Pending review',
  'Verified',
  'False positive',
  'Uncertain',
  'Under investigation',
];

export function ConflictEventsPage() {
  const {
    conflictEvents,
    locations,
    selectedProjectId,
    globalSearch,
    currentUser,
    isDemoMode,
    reviewConflictEvent,
    saveEventAiExplanation,
    pushToast,
  } = useRoadshadow();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const canReview = currentUser ? canPerformAction(currentUser.role, 'review_events') : false;

  const [riskFilter, setRiskFilter] = useState<'ALL' | RiskCategory>('ALL');
  const [statusFilter, setStatusFilter] = useState<'ALL' | ValidationStatus>('ALL');
  const [typeFilter, setTypeFilter] = useState<'ALL' | ConflictType>('ALL');
  const [sortBy, setSortBy] = useState<'riskDesc' | 'dateDesc'>('riskDesc');
  const [page, setPage] = useState(1);
  const pageSize = 8;

  const filtered = useMemo(() => {
    const q = globalSearch.trim().toLowerCase();
    return conflictEvents
      .filter((ev) => {
        if (selectedProjectId !== 'ALL' && ev.projectId !== selectedProjectId) return false;
        if (riskFilter !== 'ALL' && ev.riskCategory !== riskFilter) return false;
        if (statusFilter !== 'ALL' && ev.validationStatus !== statusFilter) return false;
        if (typeFilter !== 'ALL' && ev.conflictType !== typeFilter) return false;
        if (q) {
          const locName = locations.find((l) => l.id === ev.locationId)?.name.toLowerCase() ?? '';
          if (
            !ev.conflictType.toLowerCase().includes(q) &&
            !ev.evidenceSummary.toLowerCase().includes(q) &&
            !locName.includes(q)
          ) {
            return false;
          }
        }
        return true;
      })
      .sort((a, b) =>
        sortBy === 'riskDesc'
          ? b.riskScore - a.riskScore
          : b.occurredAt.localeCompare(a.occurredAt)
      );
  }, [conflictEvents, selectedProjectId, riskFilter, statusFilter, typeFilter, globalSearch, locations, sortBy]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const paginated = filtered.slice((page - 1) * pageSize, page * pageSize);

  const selectedId = searchParams.get('eventId') || paginated[0]?.id || null;
  const selectedEvent = conflictEvents.find((e) => e.id === selectedId) ?? null;

  const [reviewStatus, setReviewStatus] = useState<ValidationStatus>('Pending review');
  const [reviewType, setReviewType] = useState<ConflictType>('Other potential conflict');
  const [reviewNotes, setReviewNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  useEffect(() => {
    if (selectedEvent) {
      setReviewStatus(selectedEvent.validationStatus);
      setReviewType(selectedEvent.conflictType);
      setReviewNotes(selectedEvent.analystNotes || '');
      setAiError(null);
    }
  }, [selectedEvent?.id]);

  const handleSaveReview = async () => {
    if (!selectedEvent || !canReview) return;
    setSaving(true);
    try {
      await reviewConflictEvent(selectedEvent.id, {
        validationStatus: reviewStatus,
        conflictType: reviewType,
        analystNotes: reviewNotes.trim(),
      });
    } finally {
      setSaving(false);
    }
  };

  const handleAiExplain = async () => {
    if (!selectedEvent) return;
    setAiLoading(true);
    setAiError(null);
    const loc = locations.find((l) => l.id === selectedEvent.locationId);
    try {
      const resp = await roadshadowFetch('/api/ai/explain-event', {
        method: 'POST',
        isDemoMode,
        demoRole: currentUser?.role,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conflictType: selectedEvent.conflictType,
          riskScore: selectedEvent.riskScore,
          riskCategory: selectedEvent.riskCategory,
          detectionConfidence: selectedEvent.detectionConfidence,
          estimatedTtcSec: selectedEvent.estimatedTtcSec,
          estimatedMinSeparationPx: selectedEvent.estimatedMinSeparationPx,
          trajectoryConvergenceDeg: selectedEvent.trajectoryConvergenceDeg,
          roadUsers: selectedEvent.roadUsers,
          locationName: loc?.name || selectedEvent.locationId,
          locationType: loc?.locationType || 'Intersection',
          contributingFactors: selectedEvent.contributingFactors,
          measurementLimitations: selectedEvent.measurementLimitations,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.error || 'Failed to generate AI explanation.');
      }
      const exp = data.explanation;
      const formatted = `${exp.plainLanguageSummary}\n\nSafety Significance: ${exp.safetySignificance}\n\nRecommended Field Checks:\n${(exp.recommendedFieldChecks || []).map((s: string) => `• ${s}`).join('\n')}\n\nCaveat: ${exp.caveatNote}`;
      saveEventAiExplanation(selectedEvent.id, formatted);
      pushToast({ type: 'success', title: 'Gemini Safety Interpretation Generated' });
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'Unable to reach Gemini explanation API.');
    } finally {
      setAiLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[#F5F8FC]">Conflict Events &amp; Validation</h1>
          <p className="text-sm text-[#A9B8CA] mt-1">
            Inspect provisional risk breakdowns, measurement caveats, and verify candidate near-miss events without overwriting original AI outputs.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setSortBy((s) => (s === 'riskDesc' ? 'dateDesc' : 'riskDesc'))}
          className="inline-flex items-center gap-2 px-3 py-2 bg-[#122943] border border-[#233B56] text-xs font-medium text-[#F5F8FC] rounded-md hover:border-[#2585FF] whitespace-nowrap"
        >
          <ArrowUpDown className="w-3.5 h-3.5" />
          Sort: {sortBy === 'riskDesc' ? 'Highest Risk Score' : 'Most Recent'}
        </button>
      </div>

      {/* Filters Row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 bg-[#122943] border border-[#233B56] rounded-lg p-4">
        <div>
          <label htmlFor="ev-risk-filter" className="block text-xs text-[#A9B8CA] mb-1">
            Risk Category
          </label>
          <select
            id="ev-risk-filter"
            value={riskFilter}
            onChange={(e) => {
              setRiskFilter(e.target.value as 'ALL' | RiskCategory);
              setPage(1);
            }}
            className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-1.5 text-sm text-[#F5F8FC]"
          >
            <option value="ALL">All Risk Levels</option>
            <option value="Critical">Critical (75–100)</option>
            <option value="High">High (50–74)</option>
            <option value="Medium">Medium (25–49)</option>
            <option value="Low">Low (0–24)</option>
          </select>
        </div>

        <div>
          <label htmlFor="ev-status-filter" className="block text-xs text-[#A9B8CA] mb-1">
            Validation Status
          </label>
          <select
            id="ev-status-filter"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value as 'ALL' | ValidationStatus);
              setPage(1);
            }}
            className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-1.5 text-sm text-[#F5F8FC]"
          >
            <option value="ALL">All Validation States</option>
            {VALIDATION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="ev-type-filter" className="block text-xs text-[#A9B8CA] mb-1">
            Conflict Classification
          </label>
          <select
            id="ev-type-filter"
            value={typeFilter}
            onChange={(e) => {
              setTypeFilter(e.target.value as 'ALL' | ConflictType);
              setPage(1);
            }}
            className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-1.5 text-sm text-[#F5F8FC]"
          >
            <option value="ALL">All Conflict Types</option>
            {CONFLICT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Split Table + Inspection & Validation Panel */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        <div className="xl:col-span-7 bg-[#122943] border border-[#233B56] rounded-lg overflow-hidden flex flex-col">
          <div className="overflow-x-auto flex-1">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#233B56] bg-[#0D1F35] text-xs text-[#A9B8CA]">
                  <th className="py-3 px-4 font-medium">Conflict &amp; Location</th>
                  <th className="py-3 px-4 font-medium">Provisional Risk</th>
                  <th className="py-3 px-4 font-medium">Confidence</th>
                  <th className="py-3 px-4 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#233B56] text-sm">
                {paginated.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-10 text-center text-sm text-[#A9B8CA]">
                      No conflict events match the active filters.
                    </td>
                  </tr>
                ) : (
                  paginated.map((ev) => {
                    const loc = locations.find((l) => l.id === ev.locationId);
                    const isSelected = selectedEvent?.id === ev.id;
                    return (
                      <tr
                        key={ev.id}
                        className={`transition-colors ${
                          isSelected ? 'bg-[#2585FF]/15' : 'hover:bg-[#0D1F35]/60'
                        }`}
                      >
                        <td className="py-3 px-4">
                          <button
                            type="button"
                            onClick={() => setSearchParams({ eventId: ev.id })}
                            className="text-left font-medium text-[#F5F8FC] hover:text-[#45B5FF]"
                          >
                            {ev.conflictType}
                          </button>
                          <p className="text-xs text-[#A9B8CA] mt-0.5">
                            {loc?.name || ev.locationId} · {ev.occurredAt.slice(0, 10)}
                          </p>
                        </td>
                        <td className="py-3 px-4">
                          <RiskIndicator category={ev.riskCategory} score={ev.riskScore} compact />
                        </td>
                        <td className="py-3 px-4 font-mono tabular-nums text-xs text-[#A9B8CA]">
                          {Math.round(ev.detectionConfidence * 100)}%
                        </td>
                        <td className="py-3 px-4 text-xs text-[#F5F8FC] whitespace-nowrap">
                          {ev.validationStatus}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="px-4 py-3 border-t border-[#233B56] bg-[#0D1F35] flex items-center justify-between text-xs text-[#A9B8CA]">
            <span className="font-mono tabular-nums">
              Showing {paginated.length} of {filtered.length} events
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                aria-label="Previous page"
                className="p-1.5 rounded border border-[#233B56] disabled:opacity-40 text-[#F5F8FC]"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="font-mono tabular-nums">
                {page} / {totalPages}
              </span>
              <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                aria-label="Next page"
                className="p-1.5 rounded border border-[#233B56] disabled:opacity-40 text-[#F5F8FC]"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        {/* Right: Transparent Risk Scoring Breakdown & Human Validation */}
        <div className="xl:col-span-5">
          {selectedEvent ? (
            <div className="bg-[#122943] border border-[#233B56] rounded-lg p-5 space-y-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <RiskIndicator
                    category={selectedEvent.riskCategory}
                    score={selectedEvent.riskScore}
                  />
                  <h2 className="text-lg font-semibold text-[#F5F8FC] mt-1">
                    {selectedEvent.conflictType}
                  </h2>
                  <p className="text-xs text-[#A9B8CA] mt-0.5">
                    Original AI Classification:{' '}
                    <span className="text-[#F5F8FC] font-medium">
                      {selectedEvent.originalConflictType}
                    </span>
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    data-testid="replay-event-clip-btn"
                    onClick={() =>
                      navigate(
                        `/video-analysis/${selectedEvent.videoId}?eventId=${encodeURIComponent(
                          selectedEvent.id
                        )}&t=${selectedEvent.timestampSec}&replay=1`
                      )
                    }
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#2585FF] hover:bg-[#1C74E8] rounded-md text-xs font-medium text-white whitespace-nowrap"
                  >
                    <Play className="w-3.5 h-3.5" />
                    Replay Clip
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      navigate(
                        `/video-analysis/${selectedEvent.videoId}?eventId=${encodeURIComponent(
                          selectedEvent.id
                        )}&t=${selectedEvent.timestampSec}`
                      )
                    }
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#0D1F35] border border-[#233B56] hover:border-[#2585FF] rounded-md text-xs font-medium text-[#45B5FF] whitespace-nowrap"
                  >
                    <Video className="w-3.5 h-3.5" />
                    Inspect Frame
                  </button>
                </div>
              </div>

              <p className="text-sm text-[#F5F8FC] leading-relaxed">
                {selectedEvent.evidenceSummary}
              </p>
              {selectedEvent.involvedTrackIds && selectedEvent.involvedTrackIds.length > 0 && (
                <p className="text-xs font-mono text-[#45B5FF]">
                  Involved Track IDs: {selectedEvent.involvedTrackIds.join(' ↔ ')} · At T=
                  {selectedEvent.timestampSec.toFixed(1)}s
                </p>
              )}

              {/* Separate Confidence vs Provisional Risk Metrics */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 p-3.5 rounded-md bg-[#0D1F35] border border-[#233B56] text-xs">
                <div>
                  <p className="text-[#A9B8CA]">Provisional Risk</p>
                  <p className="text-sm font-mono tabular-nums font-semibold text-[#F5F8FC] mt-0.5">
                    {selectedEvent.riskScore} / 100
                  </p>
                </div>
                <div>
                  <p className="text-[#A9B8CA]">Detection Confidence</p>
                  <p className="text-sm font-mono tabular-nums font-semibold text-[#45B5FF] mt-0.5">
                    {Math.round(selectedEvent.detectionConfidence * 100)}%
                  </p>
                </div>
                <div>
                  <p className="text-[#A9B8CA]">Estimated TTC</p>
                  <p className="text-sm font-mono tabular-nums font-semibold text-[#F5F8FC] mt-0.5">
                    {selectedEvent.estimatedTtcSec !== null
                      ? `${selectedEvent.estimatedTtcSec}s`
                      : 'Unavailable'}
                  </p>
                </div>
                <div>
                  <p className="text-[#A9B8CA]">Estimated PET</p>
                  <p className="text-sm font-mono tabular-nums font-semibold text-[#F5F8FC] mt-0.5">
                    {selectedEvent.estimatedPetSec !== undefined && selectedEvent.estimatedPetSec !== null
                      ? `${selectedEvent.estimatedPetSec}s`
                      : 'Unavailable'}
                  </p>
                </div>
                <div>
                  <p className="text-[#A9B8CA]">Min Separation</p>
                  <p className="text-sm font-mono tabular-nums font-semibold text-[#F5F8FC] mt-0.5">
                    {selectedEvent.estimatedMinSeparationPx !== null
                      ? `${selectedEvent.estimatedMinSeparationPx} px`
                      : 'Unavailable'}
                  </p>
                </div>
                <div>
                  <p className="text-[#A9B8CA]">Evasive Action</p>
                  <p
                    className={`text-xs font-mono mt-1 ${
                      selectedEvent.evasiveManeuverDetected ? 'text-[#F97316]' : 'text-[#A9B8CA]'
                    }`}
                  >
                    {selectedEvent.evasiveManeuverDetected ? 'Detected' : 'Not detected'}
                  </p>
                </div>
                <div>
                  <p className="text-[#A9B8CA]">Measurement Quality</p>
                  <p className="text-xs font-mono text-[#EAB308] mt-1">
                    {selectedEvent.measurementQuality.replace('_', ' ')}
                  </p>
                </div>
              </div>

              <div className="space-y-2 text-xs">
                <p className="font-semibold text-[#F5F8FC]">Contributing Factors</p>
                <ul className="space-y-1 text-[#A9B8CA]">
                  {selectedEvent.contributingFactors.map((f, idx) => (
                    <li key={idx}>• {f}</li>
                  ))}
                </ul>
              </div>

              <div className="space-y-2 text-xs p-3 rounded-md bg-[#071426] border border-[#233B56]">
                <p className="font-semibold text-[#EAB308]">Measurement Limitations</p>
                <ul className="space-y-1 text-[#A9B8CA]">
                  {selectedEvent.measurementLimitations.map((m, idx) => (
                    <li key={idx}>• {m}</li>
                  ))}
                </ul>
              </div>

              {/* Gemini Explanation Trigger */}
              <div className="pt-2 border-t border-[#233B56] space-y-2">
                <button
                  type="button"
                  disabled={aiLoading}
                  onClick={handleAiExplain}
                  className="inline-flex items-center gap-2 px-3.5 py-2 bg-[#0D1F35] hover:bg-[#173252] border border-[#2585FF]/50 text-[#45B5FF] text-xs font-medium rounded-md transition-colors"
                >
                  {aiLoading ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Cpu className="w-3.5 h-3.5" />
                  )}
                  {aiLoading ? 'Interpreting with Gemini...' : 'Generate Plain-Language Interpretation'}
                </button>

                {aiError && (
                  <div role="alert" className="p-3 rounded-md bg-[#E5484D]/10 border border-[#E5484D]/40 text-xs text-[#F5F8FC] flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 text-[#E5484D] shrink-0 mt-0.5" />
                    <span>{aiError}</span>
                  </div>
                )}

                {selectedEvent.aiExplanation && (
                  <div className="p-3.5 rounded-md bg-[#0D1F35] border border-[#2585FF]/35 text-xs text-[#F5F8FC] whitespace-pre-line leading-relaxed">
                    {selectedEvent.aiExplanation}
                  </div>
                )}
              </div>

              {/* Human Validation Workflow */}
              <div className="pt-4 border-t border-[#233B56] space-y-3">
                <h3 className="text-sm font-semibold text-[#F5F8FC]">Human Analyst Validation</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="review-status" className="block text-xs text-[#A9B8CA] mb-1">
                      Validation Status
                    </label>
                    <select
                      id="review-status"
                      disabled={!canReview}
                      value={reviewStatus}
                      onChange={(e) => setReviewStatus(e.target.value as ValidationStatus)}
                      className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-1.5 text-sm text-[#F5F8FC]"
                    >
                      {VALIDATION_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label htmlFor="review-type" className="block text-xs text-[#A9B8CA] mb-1">
                      Analyst Classification
                    </label>
                    <select
                      id="review-type"
                      disabled={!canReview}
                      value={reviewType}
                      onChange={(e) => setReviewType(e.target.value as ConflictType)}
                      className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-1.5 text-sm text-[#F5F8FC]"
                    >
                      {CONFLICT_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label htmlFor="review-notes" className="block text-xs text-[#A9B8CA] mb-1">
                    Analyst Notes
                  </label>
                  <textarea
                    id="review-notes"
                    rows={2}
                    disabled={!canReview}
                    value={reviewNotes}
                    onChange={(e) => setReviewNotes(e.target.value)}
                    placeholder="Document visibility obstructions, signal timing observations, or false-positive reasoning..."
                    className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC]"
                  />
                </div>

                <button
                  type="button"
                  disabled={!canReview || saving}
                  onClick={handleSaveReview}
                  className="w-full px-4 py-2 bg-[#2585FF] hover:bg-[#1C74E8] disabled:opacity-50 text-white text-sm font-medium rounded-md transition-colors"
                >
                  {canReview
                    ? saving
                      ? 'Saving Validation...'
                      : 'Save Analyst Validation'
                    : 'Viewers Cannot Modify Event Validations'}
                </button>
              </div>
            </div>
          ) : (
            <div className="bg-[#122943] border border-[#233B56] rounded-lg p-8 text-center text-sm text-[#A9B8CA]">
              Select a conflict event from the table to inspect its scoring breakdown and review controls.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
