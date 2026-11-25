import React, { useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AlertCircle, Cpu, Loader2, Send } from 'lucide-react';
import { useRoadshadow } from '../context/RoadshadowContext';
import { roadshadowFetch } from '../lib/apiClient';

export function AnalyticsPage() {
  const {
    conflictEvents,
    conflictFingerprints,
    locations,
    videos,
    selectedProjectId,
    currentUser,
    isDemoMode,
  } = useRoadshadow();

  const scopedEvents = useMemo(
    () =>
      conflictEvents.filter((e) =>
        selectedProjectId === 'ALL' ? true : e.projectId === selectedProjectId
      ),
    [conflictEvents, selectedProjectId]
  );

  const scopedFingerprints = useMemo(
    () =>
      conflictFingerprints.filter((fp) =>
        selectedProjectId === 'ALL' ? true : fp.projectId === selectedProjectId
      ),
    [conflictFingerprints, selectedProjectId]
  );

  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiAnswer, setAiAnswer] = useState<{
    answer: string;
    supportingMetrics: string[];
    dataLimitations: string;
  } | null>(null);

  // Average risk score by conflict classification
  const avgRiskByType = useMemo(() => {
    const agg = new Map<string, { total: number; count: number }>();
    for (const ev of scopedEvents) {
      if (ev.validationStatus === 'False positive') continue;
      const prev = agg.get(ev.conflictType) ?? { total: 0, count: 0 };
      prev.total += ev.riskScore;
      prev.count += 1;
      agg.set(ev.conflictType, prev);
    }
    return Array.from(agg.entries()).map(([type, s]) => ({
      type: type.length > 22 ? `${type.slice(0, 20)}…` : type,
      avgScore: Math.round(s.total / s.count),
      count: s.count,
    }));
  }, [scopedEvents]);

  // Validation accuracy breakdown
  const validationBreakdown = useMemo(() => {
    const statuses = [
      'Verified',
      'Pending review',
      'Under investigation',
      'Uncertain',
      'False positive',
    ] as const;
    return statuses.map((status) => ({
      status,
      count: scopedEvents.filter((e) => e.validationStatus === status).length,
    }));
  }, [scopedEvents]);

  const handleQuery = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (question.trim().length < 3) {
      setError('Enter a specific road safety analytics question (at least 3 characters).');
      return;
    }

    setLoading(true);
    try {
      const scopedVideos = videos.filter((v) =>
        selectedProjectId === 'ALL' ? true : v.projectId === selectedProjectId
      );
      const scopedLocations = locations.filter((l) =>
        selectedProjectId === 'ALL' ? true : l.projectId === selectedProjectId
      );
      const contextSummary = {
        totalVideos: scopedVideos.length,
        totalEvents: scopedEvents.length,
        verifiedEvents: scopedEvents.filter((ev) => ev.validationStatus === 'Verified').length,
        criticalEvents: scopedEvents.filter((ev) => ev.riskCategory === 'Critical').length,
        highEvents: scopedEvents.filter((ev) => ev.riskCategory === 'High').length,
        locations: scopedLocations.map((l) => ({
          name: l.name,
          type: l.locationType,
          events: scopedEvents.filter((ev) => ev.locationId === l.id).length,
        })),
        fingerprints: scopedFingerprints.map((fp) => ({
          location: fp.locationName,
          pattern: fp.patternLabel,
          observedCount: fp.observedCount,
          isPreliminary: fp.isPreliminary,
        })),
      };

      const resp = await roadshadowFetch('/api/ai/query-analytics', {
        method: 'POST',
        isDemoMode,
        demoRole: currentUser?.role,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: question.trim(),
          contextSummary,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Analytics query failed.');
      setAiAnswer(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to complete analytics query.');
    } finally {
      setLoading(false);
    }
  };

  const quickPrompts = [
    'Which monitored location has the most critical two-wheeler conflicts?',
    'Summarize our established vs preliminary conflict fingerprints.',
    'What time-of-day windows show peak vulnerable road-user risk?',
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#F5F8FC]">Traffic Safety Analytics</h1>
        <p className="text-sm text-[#A9B8CA] mt-1">
          Comparative severity metrics, analyst validation funnel, and Gemini-powered natural-language analytics grounded strictly in stored project records.
        </p>
      </div>

      {/* Natural-Language Analytics Query Panel */}
      <div className="bg-[#122943] border border-[#233B56] rounded-lg p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Cpu className="w-5 h-5 text-[#45B5FF]" />
          <div>
            <h2 className="text-base font-semibold text-[#F5F8FC]">
              Natural-Language Safety Analytics Query
            </h2>
            <p className="text-xs text-[#A9B8CA]">
              Ask questions about observed conflict patterns, time windows, or location comparisons. Answers cite structured project records only.
            </p>
          </div>
        </div>

        <form onSubmit={handleQuery} className="flex flex-col sm:flex-row gap-2">
          <label htmlFor="nl-query-input" className="sr-only">
            Ask a safety analytics question
          </label>
          <input
            id="nl-query-input"
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="e.g. Which intersection shows recurring morning turning conflicts involving motorcycles?"
            className="flex-1 bg-[#0D1F35] border border-[#233B56] rounded-md px-3.5 py-2 text-sm text-[#F5F8FC] focus:outline-none focus:ring-2 focus:ring-[#2585FF]"
          />
          <button
            type="submit"
            disabled={loading}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 bg-[#2585FF] hover:bg-[#1C74E8] disabled:opacity-50 text-white text-sm font-medium rounded-md whitespace-nowrap"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            Run Query
          </button>
        </form>

        <div className="flex flex-wrap gap-2">
          {quickPrompts.map((prompt) => (
            <button
              key={prompt}
              type="button"
              onClick={() => setQuestion(prompt)}
              className="text-xs text-[#A9B8CA] hover:text-[#F5F8FC] bg-[#0D1F35] border border-[#233B56] hover:border-[#2585FF]/50 rounded-md px-3 py-1.5 transition-colors text-left"
            >
              {prompt}
            </button>
          ))}
        </div>

        {error && (
          <div role="alert" className="p-3 rounded-md bg-[#E5484D]/10 border border-[#E5484D]/40 text-xs text-[#F5F8FC] flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-[#E5484D] shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {aiAnswer && (
          <div className="p-4 rounded-md bg-[#0D1F35] border border-[#2585FF]/40 space-y-3">
            <p className="text-sm text-[#F5F8FC] leading-relaxed">{aiAnswer.answer}</p>
            {aiAnswer.supportingMetrics.length > 0 && (
              <div className="pt-2 border-t border-[#233B56] text-xs">
                <p className="font-semibold text-[#45B5FF] mb-1">Supporting Project Records</p>
                <ul className="space-y-1 text-[#A9B8CA]">
                  {aiAnswer.supportingMetrics.map((m, i) => (
                    <li key={i}>• {m}</li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-[11px] text-[#A9B8CA] italic">
              Limitation: {aiAnswer.dataLimitations}
            </p>
          </div>
        )}
      </div>

      {/* Comparative Analytics Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[#122943] border border-[#233B56] rounded-lg p-5">
          <h2 className="text-base font-semibold text-[#F5F8FC]">
            Mean Provisional Risk Score by Conflict Type
          </h2>
          <p className="text-xs text-[#A9B8CA] mb-4">
            Average 0–100 provisional severity score (excludes false positives)
          </p>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={avgRiskByType} layout="vertical" margin={{ left: 20, right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#233B56" horizontal={false} />
                <XAxis type="number" domain={[0, 100]} stroke="#A9B8CA" fontSize={12} />
                <YAxis type="category" dataKey="type" stroke="#A9B8CA" fontSize={11} width={150} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0D1F35',
                    borderColor: '#233B56',
                    color: '#F5F8FC',
                    fontSize: '12px',
                  }}
                />
                <Bar dataKey="avgScore" name="Mean Risk Score" fill="#F97316" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-[#122943] border border-[#233B56] rounded-lg p-5">
          <h2 className="text-base font-semibold text-[#F5F8FC]">Human Validation Pipeline</h2>
          <p className="text-xs text-[#A9B8CA] mb-4">
            Distribution of analyst review outcomes across candidate detections
          </p>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={validationBreakdown} margin={{ left: -12, right: 12 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#233B56" />
                <XAxis dataKey="status" stroke="#A9B8CA" fontSize={11} />
                <YAxis allowDecimals={false} stroke="#A9B8CA" fontSize={12} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0D1F35',
                    borderColor: '#233B56',
                    color: '#F5F8FC',
                    fontSize: '12px',
                  }}
                />
                <Bar dataKey="count" name="Events" fill="#2585FF" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}
