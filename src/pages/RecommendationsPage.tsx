import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Cpu, Lightbulb, Loader2, Plus } from 'lucide-react';
import { useRoadshadow } from '../context/RoadshadowContext';
import { RiskIndicator } from '../components/RiskBadge';
import { canPerformAction } from '../engine/validation';
import { roadshadowFetch } from '../lib/apiClient';
import type { RiskCategory, SafetyRecommendation } from '../types/roadshadow';

const CATEGORIES: SafetyRecommendation['category'][] = [
  'Engineering',
  'Signal Timing',
  'Signage & Marking',
  'Enforcement',
  'Pedestrian Infrastructure',
];

const STATUSES: SafetyRecommendation['status'][] = [
  'Proposed',
  'Under review',
  'Approved',
  'Implemented',
  'Deferred',
];

export function RecommendationsPage() {
  const {
    recommendations,
    locations,
    projects,
    conflictFingerprints,
    selectedProjectId,
    currentUser,
    isDemoMode,
    createRecommendation,
    updateRecommendationStatus,
  } = useRoadshadow();

  const canCreate = currentUser ? canPerformAction(currentUser.role, 'create_reports') : false;

  const scopedLocations = useMemo(
    () =>
      locations.filter((l) =>
        selectedProjectId === 'ALL' ? true : l.projectId === selectedProjectId
      ),
    [locations, selectedProjectId]
  );

  const [title, setTitle] = useState('');
  const [locationId, setLocationId] = useState(scopedLocations[0]?.id || locations[0]?.id || '');
  const [category, setCategory] = useState<SafetyRecommendation['category']>('Engineering');
  const [priority, setPriority] = useState<RiskCategory>('High');
  const [rationale, setRationale] = useState('');
  const [evidenceSummary, setEvidenceSummary] = useState('');
  const [stepsText, setStepsText] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  useEffect(() => {
    const pool = scopedLocations.length > 0 ? scopedLocations : locations;
    if (pool.length === 0) return;
    if (!locationId || !pool.some((l) => l.id === locationId)) {
      setLocationId(pool[0].id);
    }
  }, [scopedLocations, locations, locationId]);

  const scoped = useMemo(
    () =>
      recommendations.filter((r) =>
        selectedProjectId === 'ALL' ? true : r.projectId === selectedProjectId
      ),
    [recommendations, selectedProjectId]
  );

  const handleManualAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const loc = locations.find((l) => l.id === (locationId || locations[0]?.id));
    if (!loc) {
      setFormError('Select a monitored road location.');
      return;
    }
    if (title.trim().length < 3 || rationale.trim().length < 5) {
      setFormError('Enter both a recommendation title and evidence-based rationale.');
      return;
    }
    await createRecommendation({
      projectId: loc.projectId,
      locationId: loc.id,
      title: title.trim(),
      category,
      priority,
      rationale: rationale.trim(),
      evidenceSummary: evidenceSummary.trim() || 'Analyst field assessment.',
      implementationSteps: stepsText
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
      status: 'Proposed',
      generatedByAi: false,
    });
    setTitle('');
    setRationale('');
    setEvidenceSummary('');
    setStepsText('');
  };

  const handleGenerateFromFingerprints = async () => {
    setAiError(null);
    const loc = locations.find((l) => l.id === (locationId || locations[0]?.id));
    if (!loc) return;
    const locFps = conflictFingerprints.filter((fp) => fp.locationId === loc.id);
    if (locFps.length === 0) {
      setAiError('This location does not yet have a recurring Conflict Fingerprint to ground AI recommendations.');
      return;
    }
    setAiBusy(true);
    try {
      const proj = projects.find((p) => p.id === loc.projectId);
      const resp = await roadshadowFetch('/api/ai/generate-recommendations', {
        method: 'POST',
        isDemoMode,
        demoRole: currentUser?.role,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectName: proj?.name || 'Road Safety Study',
          locationName: loc.name,
          locationType: loc.locationType,
          fingerprints: locFps.map((fp) => ({
            patternLabel: fp.patternLabel,
            conflictType: fp.conflictType,
            observedCount: fp.observedCount,
            isPreliminary: fp.isPreliminary,
            timeWindow: fp.timeWindow,
            roadUserCombo: fp.roadUserCombo,
            contributingFactors: fp.contributingFactors,
          })),
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Gemini recommendation generation failed.');

      for (const r of (data.recommendations || []).slice(0, 2)) {
        const cat = CATEGORIES.includes(r.category) ? r.category : 'Engineering';
        const prio: RiskCategory = ['Critical', 'High', 'Medium', 'Low'].includes(r.priority)
          ? r.priority
          : 'High';
        await createRecommendation({
          projectId: loc.projectId,
          locationId: loc.id,
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
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'Unable to generate recommendations.');
    } finally {
      setAiBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#F5F8FC]">Preventive Safety Recommendations</h1>
        <p className="text-sm text-[#A9B8CA] mt-1">
          Evidence-based urban road engineering, signal phasing, and pedestrian infrastructure interventions linked to observed conflict patterns.
        </p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        <div className="xl:col-span-5 space-y-4">
          <form
            onSubmit={handleManualAdd}
            className="bg-[#122943] border border-[#233B56] rounded-lg p-5 space-y-4"
          >
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-[#F5F8FC] flex items-center gap-2">
                <Plus className="w-4 h-4 text-[#45B5FF]" />
                Add Recommendation
              </h2>
              {canCreate && (
                <button
                  type="button"
                  disabled={aiBusy}
                  onClick={handleGenerateFromFingerprints}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-[#0D1F35] border border-[#2585FF]/50 text-[#45B5FF] text-xs font-medium rounded-md hover:bg-[#173252]"
                >
                  {aiBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Cpu className="w-3.5 h-3.5" />}
                  Draft with Gemini
                </button>
              )}
            </div>

            {aiError && (
              <div role="alert" className="p-3 rounded-md bg-[#E5484D]/10 border border-[#E5484D]/40 text-xs text-[#F5F8FC] flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-[#E5484D] shrink-0 mt-0.5" />
                <span>{aiError}</span>
              </div>
            )}

            <div>
              <label htmlFor="rec-loc" className="block text-xs text-[#A9B8CA] mb-1">
                Target Road Location
              </label>
              <select
                id="rec-loc"
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
                className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC]"
              >
                {(scopedLocations.length > 0 ? scopedLocations : locations).map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="rec-title" className="block text-xs text-[#A9B8CA] mb-1">
                Intervention Title *
              </label>
              <input
                id="rec-title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Install Raised Table-Top Crosswalk"
                className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC]"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="rec-cat" className="block text-xs text-[#A9B8CA] mb-1">
                  Category
                </label>
                <select
                  id="rec-cat"
                  value={category}
                  onChange={(e) => setCategory(e.target.value as SafetyRecommendation['category'])}
                  className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-1.5 text-sm text-[#F5F8FC]"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="rec-prio" className="block text-xs text-[#A9B8CA] mb-1">
                  Priority
                </label>
                <select
                  id="rec-prio"
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as RiskCategory)}
                  className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-1.5 text-sm text-[#F5F8FC]"
                >
                  {(['Critical', 'High', 'Medium', 'Low'] as const).map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label htmlFor="rec-rationale" className="block text-xs text-[#A9B8CA] mb-1">
                Engineering Rationale *
              </label>
              <textarea
                id="rec-rationale"
                rows={3}
                value={rationale}
                onChange={(e) => setRationale(e.target.value)}
                className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC]"
              />
            </div>

            <div>
              <label htmlFor="rec-evidence" className="block text-xs text-[#A9B8CA] mb-1">
                Evidence Summary
              </label>
              <input
                id="rec-evidence"
                type="text"
                value={evidenceSummary}
                onChange={(e) => setEvidenceSummary(e.target.value)}
                placeholder="e.g. 5 morning peak conflicts observed across 2 weeks"
                className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC]"
              />
            </div>

            <div>
              <label htmlFor="rec-steps" className="block text-xs text-[#A9B8CA] mb-1">
                Implementation Steps (one per line)
              </label>
              <textarea
                id="rec-steps"
                rows={3}
                value={stepsText}
                onChange={(e) => setStepsText(e.target.value)}
                className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC]"
              />
            </div>

            {formError && (
              <p role="alert" className="text-xs text-[#E5484D]">
                {formError}
              </p>
            )}

            <button
              type="submit"
              disabled={!canCreate}
              className="w-full px-4 py-2 bg-[#2585FF] hover:bg-[#1C74E8] disabled:opacity-50 text-white text-sm font-medium rounded-md"
            >
              Save Recommendation
            </button>
          </form>
        </div>

        <div className="xl:col-span-7 space-y-4">
          {scoped.length === 0 ? (
            <div className="bg-[#122943] border border-[#233B56] rounded-lg p-10 text-center text-sm text-[#A9B8CA]">
              No safety recommendations documented for this project yet.
            </div>
          ) : (
            scoped.map((rec) => {
              const loc = locations.find((l) => l.id === rec.locationId);
              return (
                <div
                  key={rec.id}
                  className="bg-[#122943] border border-[#233B56] rounded-lg p-5 space-y-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2 text-xs text-[#A9B8CA]">
                        <Lightbulb className="w-3.5 h-3.5 text-[#45B5FF]" />
                        <span>{rec.category}</span>
                        <span aria-hidden="true">·</span>
                        <span>{loc?.name || rec.locationId}</span>
                        {rec.generatedByAi && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="text-[#45B5FF]">Gemini-Assisted Draft</span>
                          </>
                        )}
                      </div>
                      <h3 className="text-base font-semibold text-[#F5F8FC] mt-1">{rec.title}</h3>
                    </div>

                    <div className="flex items-center gap-2">
                      <RiskIndicator category={rec.priority} compact />
                      {canCreate ? (
                        <select
                          aria-label={`Update status for ${rec.title}`}
                          value={rec.status}
                          onChange={(e) =>
                            void updateRecommendationStatus(
                              rec.id,
                              e.target.value as SafetyRecommendation['status']
                            )
                          }
                          className="bg-[#0D1F35] border border-[#233B56] rounded-md px-2.5 py-1 text-xs text-[#F5F8FC]"
                        >
                          {STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-xs font-mono text-[#F5F8FC]">{rec.status}</span>
                      )}
                    </div>
                  </div>

                  <p className="text-sm text-[#A9B8CA] leading-relaxed">{rec.rationale}</p>
                  <p className="text-xs text-[#F5F8FC]">
                    <span className="text-[#A9B8CA]">Supporting Evidence:</span> {rec.evidenceSummary}
                  </p>

                  {rec.implementationSteps.length > 0 && (
                    <div className="pt-2 border-t border-[#233B56] text-xs">
                      <p className="font-medium text-[#F5F8FC] mb-1">Implementation Steps</p>
                      <ol className="list-decimal list-inside space-y-1 text-[#A9B8CA]">
                        {rec.implementationSteps.map((step, i) => (
                          <li key={i}>{step}</li>
                        ))}
                      </ol>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
