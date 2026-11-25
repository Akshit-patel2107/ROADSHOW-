import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AlertCircle,
  Download,
  Fingerprint,
  Flag,
  Lightbulb,
  Loader2,
  Video,
} from 'lucide-react';
import { useRoadshadow } from '../context/RoadshadowContext';
import { RiskIndicator } from '../components/RiskBadge';
import { buildConflictFingerprints } from '../engine/conflictFingerprint';
import { canPerformAction } from '../engine/validation';
import { roadshadowFetch } from '../lib/apiClient';
import type { ConflictFingerprint } from '../types/roadshadow';

export function ConflictFingerprintsPage() {
  const {
    conflictFingerprints,
    conflictEvents,
    videos,
    locations,
    projects,
    selectedProjectId,
    currentUser,
    isDemoMode,
    updateFingerprintStatus,
    createRecommendation,
    pushToast,
  } = useRoadshadow();
  const navigate = useNavigate();

  const canModify = currentUser ? canPerformAction(currentUser.role, 'review_events') : false;
  const [verifiedOnly, setVerifiedOnly] = useState(false);

  const scopedFingerprints = useMemo(() => {
    if (verifiedOnly) {
      const scopedEvents = conflictEvents.filter((e) =>
        selectedProjectId === 'ALL' ? true : e.projectId === selectedProjectId
      );
      return buildConflictFingerprints(scopedEvents, locations, undefined, { verifiedOnly: true });
    }
    return conflictFingerprints.filter((fp) =>
      selectedProjectId === 'ALL' ? true : fp.projectId === selectedProjectId
    );
  }, [verifiedOnly, conflictEvents, locations, conflictFingerprints, selectedProjectId]);

  const [selectedId, setSelectedId] = useState<string | null>(
    scopedFingerprints[0]?.id ?? null
  );
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const selectedFp: ConflictFingerprint | null =
    scopedFingerprints.find((fp) => fp.id === selectedId) ?? scopedFingerprints[0] ?? null;

  const linkedEvents = useMemo(() => {
    if (!selectedFp) return [];
    const setIds = new Set(selectedFp.linkedEventIds);
    return conflictEvents.filter((e) => setIds.has(e.id));
  }, [selectedFp, conflictEvents]);

  const handleExportFingerprint = (fp: ConflictFingerprint) => {
    const payload = {
      exportedAt: new Date().toISOString(),
      platform: 'ROADSHADOW Conflict Fingerprint Report',
      disclaimer:
        'Observed frequency and risk distributions are computed strictly from stored candidate conflict events. Provisional risk scores are not accident probabilities.',
      fingerprint: fp,
      supportingEvents: linkedEvents.map((e) => ({
        id: e.id,
        occurredAt: e.occurredAt,
        conflictType: e.conflictType,
        riskScore: e.riskScore,
        riskCategory: e.riskCategory,
        validationStatus: e.validationStatus,
        evidenceSummary: e.evidenceSummary,
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `roadshadow_fingerprint_${fp.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
    pushToast({ type: 'success', title: 'Fingerprint Report Exported' });
  };

  const handleGenerateAiRecommendation = async (fp: ConflictFingerprint) => {
    setAiBusy(true);
    setAiError(null);
    const project = projects.find((p) => p.id === fp.projectId);
    const loc = locations.find((l) => l.id === fp.locationId);
    try {
      const resp = await roadshadowFetch('/api/ai/generate-recommendations', {
        method: 'POST',
        isDemoMode,
        demoRole: currentUser?.role,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectName: project?.name || 'Road Safety Study',
          locationName: fp.locationName,
          locationType: loc?.locationType || 'Intersection',
          fingerprints: [
            {
              patternLabel: fp.patternLabel,
              conflictType: fp.conflictType,
              observedCount: fp.observedCount,
              isPreliminary: fp.isPreliminary,
              timeWindow: fp.timeWindow,
              roadUserCombo: fp.roadUserCombo,
              contributingFactors: fp.contributingFactors,
            },
          ],
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed to generate AI recommendations.');

      const recs = data.recommendations || [];
      for (const r of recs.slice(0, 2)) {
        const validCategories = [
          'Engineering',
          'Signal Timing',
          'Signage & Marking',
          'Enforcement',
          'Pedestrian Infrastructure',
        ] as const;
        const cat = validCategories.includes(r.category) ? r.category : 'Engineering';
        const validPrio = ['Critical', 'High', 'Medium', 'Low'] as const;
        const prio = validPrio.includes(r.priority) ? r.priority : 'High';

        await createRecommendation({
          projectId: fp.projectId,
          locationId: fp.locationId,
          fingerprintId: fp.id,
          title: r.title,
          category: cat,
          priority: prio,
          rationale: r.rationale,
          evidenceSummary: r.evidenceSummary,
          implementationSteps: Array.isArray(r.implementationSteps) ? r.implementationSteps : [],
          status: 'Proposed',
          generatedByAi: true,
        });
      }
      pushToast({
        type: 'success',
        title: 'AI Recommendations Created',
        description: 'Review the newly generated engineering proposals in Recommendations.',
      });
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'Unable to generate recommendations.');
    } finally {
      setAiBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[#F5F8FC]">ROADSHADOW Conflict Fingerprint</h1>
          <p className="text-sm text-[#A9B8CA] mt-1">
            Recurring patterns of potentially dangerous road-user interactions aggregated across location, time window, conflict zone, and road-user pairing. Low-sample patterns (&lt;4 observations) are explicitly marked Preliminary.
          </p>
        </div>
        <label className="inline-flex items-center gap-2 px-3 py-2 bg-[#122943] border border-[#233B56] rounded-md text-xs text-[#F5F8FC] cursor-pointer whitespace-nowrap shrink-0">
          <input
            type="checkbox"
            checked={verifiedOnly}
            onChange={(e) => setVerifiedOnly(e.target.checked)}
            className="accent-[#2585FF]"
          />
          Verified Events Only
        </label>
      </div>

      {scopedFingerprints.length === 0 ? (
        <div className="space-y-4">
          <div className="bg-[#122943] border border-[#233B56] rounded-lg p-10 text-center max-w-2xl mx-auto">
            <Fingerprint className="w-8 h-8 text-[#45B5FF] mx-auto" />
            <h2 className="text-base font-semibold text-[#F5F8FC] mt-3">
              Insufficient Recurring Observations Yet
            </h2>
            <p className="text-sm text-[#A9B8CA] mt-2 leading-relaxed">
              ROADSHADOW only creates a Conflict Fingerprint when at least two non-false-positive conflict events share the same location, time window, road-user pairing, and conflict type.
            </p>
          </div>
          {(() => {
            const singles = conflictEvents.filter(
              (e) =>
                (selectedProjectId === 'ALL' || e.projectId === selectedProjectId) &&
                e.validationStatus !== 'False positive' &&
                (!verifiedOnly || e.validationStatus === 'Verified')
            );
            if (singles.length === 0) return null;
            return (
              <div className="bg-[#122943] border border-[#233B56] rounded-lg p-5 max-w-4xl mx-auto space-y-3">
                <h3 className="text-sm font-semibold text-[#F5F8FC]">
                  Single-Observation Events ({singles.length} — Not Yet Recurring Fingerprints)
                </h3>
                <div className="divide-y divide-[#233B56]">
                  {singles.slice(0, 8).map((ev) => (
                    <button
                      key={ev.id}
                      type="button"
                      onClick={() => navigate(`/events?eventId=${ev.id}`)}
                      className="w-full text-left py-2.5 flex items-center justify-between gap-3 hover:text-[#45B5FF]"
                    >
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-[#F5F8FC] truncate">
                          {ev.conflictType} · {locations.find((l) => l.id === ev.locationId)?.name || ev.locationId}
                        </p>
                        <p className="text-[11px] font-mono text-[#A9B8CA]">
                          {ev.occurredAt.slice(0, 16).replace('T', ' ')} · {ev.roadUsers.join(' + ')}
                        </p>
                      </div>
                      <RiskIndicator category={ev.riskCategory} score={ev.riskScore} compact />
                    </button>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
          {/* Fingerprint List */}
          <div className="xl:col-span-5 space-y-3">
            {scopedFingerprints.map((fp) => {
              const active = selectedFp?.id === fp.id;
              return (
                <button
                  key={fp.id}
                  type="button"
                  onClick={() => setSelectedId(fp.id)}
                  className={`w-full text-left p-4 rounded-lg border transition-colors ${
                    active
                      ? 'bg-[#122943] border-[#2585FF]'
                      : 'bg-[#122943]/70 border-[#233B56] hover:border-[#2585FF]/50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-mono text-[#45B5FF]">{fp.timeWindow}</span>
                    <span className="text-[#A9B8CA]">
                      {fp.isPreliminary ? 'Preliminary Pattern' : 'Established Pattern'} ·{' '}
                      <strong className="font-mono tabular-nums text-[#F5F8FC]">
                        {fp.observedCount} events
                      </strong>
                    </span>
                  </div>
                  <h2 className="text-base font-semibold text-[#F5F8FC] mt-1.5">
                    {fp.conflictType}
                  </h2>
                  <p className="text-xs text-[#A9B8CA] mt-0.5">
                    {fp.locationName} · {fp.roadUserCombo}
                  </p>
                  <div className="mt-3 pt-2.5 border-t border-[#233B56] flex items-center justify-between text-xs">
                    <span className="text-[#A9B8CA]">
                      Critical: <span className="font-mono text-[#E5484D]">{fp.riskDistribution.Critical}</span> · High:{' '}
                      <span className="font-mono text-[#F97316]">{fp.riskDistribution.High}</span>
                    </span>
                    <span className="text-[#F5F8FC] font-medium">{fp.investigationStatus}</span>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Selected Fingerprint Deep Analysis */}
          {selectedFp && (
            <div className="xl:col-span-7 bg-[#122943] border border-[#233B56] rounded-lg p-6 space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                <div>
                  <p className="text-xs text-[#45B5FF] font-medium">
                    {selectedFp.isPreliminary
                      ? 'Preliminary Pattern (Low Sample Size — Collect More Footage)'
                      : 'Established Conflict Fingerprint'}
                  </p>
                  <h2 className="text-xl font-bold text-[#F5F8FC] mt-1">
                    {selectedFp.locationName}
                  </h2>
                  <p className="text-sm text-[#A9B8CA] mt-0.5">
                    {selectedFp.conflictType} · {selectedFp.roadUserCombo} · {selectedFp.timeWindow} ·{' '}
                    {selectedFp.dayOfWeekPattern}
                  </p>
                  {selectedFp.conflictZone && (
                    <p className="text-xs font-mono text-[#45B5FF] mt-1">
                      Conflict Zone: {selectedFp.conflictZone}
                    </p>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleExportFingerprint(selectedFp)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#0D1F35] border border-[#233B56] hover:border-[#2585FF] text-xs font-medium text-[#F5F8FC] rounded-md"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Export Report
                  </button>
                  {canModify && (
                    <button
                      type="button"
                      onClick={() =>
                        updateFingerprintStatus(
                          selectedFp.id,
                          selectedFp.investigationStatus === 'Marked for investigation'
                            ? 'Mitigation planned'
                            : 'Marked for investigation'
                        )
                      }
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#2585FF] hover:bg-[#1C74E8] text-xs font-medium text-white rounded-md"
                    >
                      <Flag className="w-3.5 h-3.5" />
                      {selectedFp.investigationStatus === 'Marked for investigation'
                        ? 'Mark Mitigation Planned'
                        : 'Mark for Investigation'}
                    </button>
                  )}
                </div>
              </div>

              {/* Risk Distribution Strip */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {(['Critical', 'High', 'Medium', 'Low'] as const).map((cat) => (
                  <div
                    key={cat}
                    className="p-3 rounded-md bg-[#0D1F35] border border-[#233B56]"
                  >
                    <RiskIndicator category={cat} compact />
                    <p className="text-xl font-bold font-mono tabular-nums text-[#F5F8FC] mt-1">
                      {selectedFp.riskDistribution[cat]}
                    </p>
                  </div>
                ))}
              </div>

              {/* Period Comparison Chart */}
              <div>
                <h3 className="text-sm font-semibold text-[#F5F8FC] mb-2">
                  Period Comparison Trend
                </h3>
                <div className="h-44 w-full bg-[#0D1F35] border border-[#233B56] rounded-md p-3">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={selectedFp.periodTrend}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#233B56" />
                      <XAxis dataKey="period" stroke="#A9B8CA" fontSize={11} />
                      <YAxis allowDecimals={false} stroke="#A9B8CA" fontSize={11} />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: '#071426',
                          borderColor: '#233B56',
                          color: '#F5F8FC',
                          fontSize: '12px',
                        }}
                      />
                      <Bar dataKey="count" name="Observed Conflicts" fill="#2585FF" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Contributing Factors & Suggested Investigation */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                <div className="p-4 rounded-md bg-[#0D1F35] border border-[#233B56]">
                  <p className="font-semibold text-[#F5F8FC] mb-2">Potential Contributing Factors</p>
                  <ul className="space-y-1 text-[#A9B8CA]">
                    {selectedFp.contributingFactors.map((f, i) => (
                      <li key={i}>• {f}</li>
                    ))}
                  </ul>
                </div>
                <div className="p-4 rounded-md bg-[#0D1F35] border border-[#233B56]">
                  <p className="font-semibold text-[#F5F8FC] mb-2">Suggested Field Investigation</p>
                  <p className="text-[#A9B8CA] leading-relaxed">
                    {selectedFp.suggestedInvestigation}
                  </p>
                </div>
              </div>

              {/* Gemini AI Recommendation Action */}
              {canModify && (
                <div className="space-y-2">
                  <button
                    type="button"
                    disabled={aiBusy}
                    onClick={() => handleGenerateAiRecommendation(selectedFp)}
                    className="inline-flex items-center gap-2 px-3.5 py-2 bg-[#0D1F35] hover:bg-[#173252] border border-[#2585FF]/50 text-[#45B5FF] text-xs font-medium rounded-md"
                  >
                    {aiBusy ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Lightbulb className="w-3.5 h-3.5" />
                    )}
                    {aiBusy
                      ? 'Generating Evidence-Based Recommendations...'
                      : 'Generate Gemini Engineering Recommendations'}
                  </button>
                  {aiError && (
                    <div role="alert" className="p-3 rounded-md bg-[#E5484D]/10 border border-[#E5484D]/40 text-xs text-[#F5F8FC] flex items-start gap-2">
                      <AlertCircle className="w-4 h-4 text-[#E5484D] shrink-0 mt-0.5" />
                      <span>{aiError}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Supporting Video Clips & Event Records */}
              <div className="pt-4 border-t border-[#233B56] space-y-3">
                {selectedFp.supportingVideoIds && selectedFp.supportingVideoIds.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-[#A9B8CA]">Supporting Videos:</span>
                    {selectedFp.supportingVideoIds.map((vidId) => {
                      const vid = videos.find((v) => v.id === vidId);
                      return (
                        <button
                          key={vidId}
                          type="button"
                          onClick={() => navigate(`/video-analysis/${vidId}`)}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-[#0D1F35] hover:bg-[#173252] border border-[#233B56] hover:border-[#2585FF] rounded text-xs text-[#45B5FF] whitespace-nowrap"
                        >
                          <Video className="w-3.5 h-3.5" />
                          {vid?.title || vidId}
                        </button>
                      );
                    })}
                  </div>
                )}

                <h3 className="text-sm font-semibold text-[#F5F8FC]">
                  Linked Supporting Evidence ({linkedEvents.length})
                </h3>
                <div className="divide-y divide-[#233B56] bg-[#0D1F35] border border-[#233B56] rounded-md">
                  {linkedEvents.map((ev) => (
                    <div
                      key={ev.id}
                      className="p-3 hover:bg-[#122943] transition-colors flex items-center justify-between gap-3"
                    >
                      <button
                        type="button"
                        onClick={() => navigate(`/events?eventId=${ev.id}`)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <p className="text-xs font-medium text-[#F5F8FC] truncate">
                          {ev.evidenceSummary}
                        </p>
                        <p className="text-[11px] font-mono text-[#A9B8CA] mt-0.5">
                          {ev.occurredAt.slice(0, 16).replace('T', ' ')} · T={ev.timestampSec.toFixed(1)}s · {ev.validationStatus}
                        </p>
                      </button>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() =>
                            navigate(
                              `/video-analysis/${ev.videoId}?eventId=${encodeURIComponent(
                                ev.id
                              )}&t=${ev.timestampSec}&replay=1`
                            )
                          }
                          className="text-[11px] font-medium text-[#45B5FF] hover:underline whitespace-nowrap"
                        >
                          Replay
                        </button>
                        <RiskIndicator category={ev.riskCategory} score={ev.riskScore} compact />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
