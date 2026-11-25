import React, { useEffect, useMemo, useState } from 'react';
import { jsPDF } from 'jspdf';
import { AlertCircle, Cpu, Download, FileText, Loader2, Printer } from 'lucide-react';
import { useRoadshadow } from '../context/RoadshadowContext';
import { canPerformAction } from '../engine/validation';
import { roadshadowFetch } from '../lib/apiClient';
import type { SafetyReport } from '../types/roadshadow';

const REPORT_TYPES: SafetyReport['reportType'][] = [
  'Location Safety Audit',
  'Conflict Fingerprint Brief',
  'Monthly Traffic Safety Review',
  'Executive Summary',
];

export function ReportsPage() {
  const {
    reports,
    projects,
    locations,
    cameras,
    videos,
    conflictEvents,
    conflictFingerprints,
    recommendations,
    selectedProjectId,
    currentUser,
    isDemoMode,
    createReport,
    pushToast,
  } = useRoadshadow();

  const canCreate = currentUser ? canPerformAction(currentUser.role, 'create_reports') : false;

  const [title, setTitle] = useState('');
  const [projectId, setProjectId] = useState(
    selectedProjectId !== 'ALL' ? selectedProjectId : projects[0]?.id || ''
  );
  const [reportType, setReportType] = useState<SafetyReport['reportType']>(
    'Monthly Traffic Safety Review'
  );
  const [dateRangeStart, setDateRangeStart] = useState('2026-11-01');
  const [dateRangeEnd, setDateRangeEnd] = useState(new Date().toISOString().slice(0, 10));
  const [summary, setSummary] = useState('');
  const [aiExecutiveSummary, setAiExecutiveSummary] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (selectedProjectId !== 'ALL' && projects.some((p) => p.id === selectedProjectId)) {
      setProjectId(selectedProjectId);
      return;
    }
    if (!projectId || !projects.some((p) => p.id === projectId)) {
      if (projects[0]) setProjectId(projects[0].id);
    }
  }, [selectedProjectId, projects, projectId]);

  const scopedReports = useMemo(
    () =>
      reports.filter((r) =>
        selectedProjectId === 'ALL' ? true : r.projectId === selectedProjectId
      ),
    [reports, selectedProjectId]
  );

  const computeSnapshot = (projId: string) => {
    const pVids = videos.filter((v) => v.projectId === projId);
    const pEvents = conflictEvents.filter(
      (e) => e.projectId === projId && e.validationStatus !== 'False positive'
    );
    const pFps = conflictFingerprints.filter((f) => f.projectId === projId);
    return {
      videosAnalyzed: pVids.filter((v) => v.status === 'Completed').length,
      totalEvents: pEvents.length,
      criticalEvents: pEvents.filter((e) => e.riskCategory === 'Critical').length,
      highEvents: pEvents.filter((e) => e.riskCategory === 'High').length,
      verifiedEvents: pEvents.filter((e) => e.validationStatus === 'Verified').length,
      fingerprintsIdentified: pFps.length,
    };
  };

  const handleGenerateAiSummary = async () => {
    setAiError(null);
    const effectiveProjId = projectId || projects[0]?.id;
    const proj = projects.find((p) => p.id === effectiveProjId);
    if (!proj) return;

    setAiBusy(true);
    try {
      const metrics = computeSnapshot(proj.id);
      const projLocs = locations.filter((l) => l.projectId === proj.id);
      const topLocations = projLocs.map((l) => {
        const evs = conflictEvents.filter((e) => e.locationId === l.id);
        return {
          name: l.name,
          eventCount: evs.length,
          dominantConflict: evs[0]?.conflictType || 'None recorded',
        };
      });

      const resp = await roadshadowFetch('/api/ai/summarize-report', {
        method: 'POST',
        isDemoMode,
        demoRole: currentUser?.role,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectName: proj.name,
          reportType,
          dateRangeStart,
          dateRangeEnd,
          metrics,
          topLocations,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Gemini report summary failed.');

      const formatted = [
        data.executiveSummary,
        '',
        'Key Findings:',
        ...(data.keyFindings || []).map((k: string) => `• ${k}`),
        '',
        'Priority Next Actions:',
        ...(data.priorityNextActions || []).map((a: string) => `• ${a}`),
      ].join('\n');

      setAiExecutiveSummary(formatted);
      if (!summary.trim()) {
        setSummary(data.executiveSummary || '');
      }
      pushToast({ type: 'success', title: 'Gemini Executive Summary Drafted' });
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'Unable to generate report summary.');
    } finally {
      setAiBusy(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const effectiveProjId = projectId || projects[0]?.id;
    if (!effectiveProjId) {
      setFormError('Create a project first.');
      return;
    }
    if (title.trim().length < 3) {
      setFormError('Enter a report title (minimum 3 characters).');
      return;
    }
    const metricsSnapshot = computeSnapshot(effectiveProjId);
    const includedLocationIds = locations
      .filter((l) => l.projectId === effectiveProjId)
      .map((l) => l.id);

    await createReport({
      projectId: effectiveProjId,
      title: title.trim(),
      reportType,
      dateRangeStart,
      dateRangeEnd,
      summary:
        summary.trim() ||
        `Automated snapshot covering ${metricsSnapshot.videosAnalyzed} analysed videos and ${metricsSnapshot.totalEvents} potential conflict events.`,
      aiExecutiveSummary: aiExecutiveSummary.trim() || undefined,
      includedLocationIds,
      metricsSnapshot,
    });
    setTitle('');
    setSummary('');
    setAiExecutiveSummary('');
  };

  const downloadJson = (rep: SafetyReport) => {
    const blob = new Blob([JSON.stringify(rep, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `roadshadow_report_${rep.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadCsv = (rep: SafetyReport) => {
    const evs = conflictEvents.filter((e) => e.projectId === rep.projectId);
    const headers = [
      'EventID',
      'OccurredAt',
      'LocationID',
      'ConflictType',
      'OriginalAIClassification',
      'ProvisionalRiskScore',
      'RiskCategory',
      'DetectionConfidence',
      'ValidationStatus',
    ];
    const rows = evs.map((e) =>
      [
        e.id,
        e.occurredAt,
        e.locationId,
        `"${e.conflictType}"`,
        `"${e.originalConflictType}"`,
        e.riskScore,
        e.riskCategory,
        e.detectionConfidence,
        `"${e.validationStatus}"`,
      ].join(',')
    );
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `roadshadow_events_${rep.id}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadPdf = (rep: SafetyReport) => {
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 44;
    const maxWidth = pageWidth - margin * 2;
    let y = 52;

    const ensureSpace = (needed: number) => {
      if (y + needed > pageHeight - 48) {
        doc.addPage();
        y = 52;
      }
    };

    const addHeading = (text: string) => {
      ensureSpace(28);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(12);
      doc.setTextColor(13, 31, 53);
      doc.text(text, margin, y);
      y += 6;
      doc.setDrawColor(37, 133, 255);
      doc.setLineWidth(1);
      doc.line(margin, y, pageWidth - margin, y);
      y += 14;
    };

    const addWrappedText = (text: string, fontSize = 9.5, isBold = false) => {
      doc.setFont('helvetica', isBold ? 'bold' : 'normal');
      doc.setFontSize(fontSize);
      doc.setTextColor(30, 41, 59);
      const lines = doc.splitTextToSize(text, maxWidth);
      for (const line of lines) {
        ensureSpace(14);
        doc.text(line, margin, y);
        y += 13;
      }
      y += 4;
    };

    const proj = projects.find((p) => p.id === rep.projectId);
    const projLocs = locations.filter((l) => l.projectId === rep.projectId);
    const projCams = cameras.filter((c) => c.projectId === rep.projectId);
    const projVideos = videos.filter((v) => v.projectId === rep.projectId);
    const projEvents = conflictEvents.filter(
      (e) => e.projectId === rep.projectId && e.validationStatus !== 'False positive'
    );
    const projFps = conflictFingerprints.filter((f) => f.projectId === rep.projectId);
    const projRecs = recommendations.filter((r) => r.projectId === rep.projectId);

    // Header banner
    doc.setFillColor(13, 31, 53);
    doc.rect(0, 0, pageWidth, 84, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.setTextColor(245, 248, 252);
    doc.text('ROADSHADOW 2.0 — Municipal Road Safety Audit Report', margin, 36);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(169, 184, 202);
    doc.text('TEAM ADIT (Akshit Patel & Shah Darshil) | AI-Powered Road Safety Intelligence', margin, 54);
    doc.text(`Generated: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, margin, 70);
    y = 108;

    addHeading('1. Project & Report Scope');
    addWrappedText(`Report Title: ${rep.title}`, 10, true);
    addWrappedText(
      `Project: ${proj?.name || rep.projectId}  |  Report Type: ${rep.reportType}  |  Analysis Period: ${rep.dateRangeStart} to ${rep.dateRangeEnd}`
    );
    if (proj?.locationSummary) {
      addWrappedText(`Corridor / Area: ${proj.locationSummary}`);
    }
    addWrappedText(
      `Monitored Locations (${projLocs.length}): ${
        projLocs.map((l) => `${l.name} (${l.city})`).join('; ') || 'None recorded'
      }`
    );
    addWrappedText(
      `Registered Cameras (${projCams.length}): ${
        projCams.map((c) => `${c.name} [${c.status}]`).join('; ') || 'None registered'
      }`
    );

    addHeading('2. Detection & Conflict Intelligence Metrics');
    const medCount = projEvents.filter((e) => e.riskCategory === 'Medium').length;
    const lowCount = projEvents.filter((e) => e.riskCategory === 'Low').length;
    addWrappedText(
      `Analysed Videos: ${rep.metricsSnapshot.videosAnalyzed}   |   Candidate Conflict Events: ${rep.metricsSnapshot.totalEvents}   |   Verified Events: ${rep.metricsSnapshot.verifiedEvents}`
    );
    addWrappedText(
      `Risk Band Distribution — Critical: ${rep.metricsSnapshot.criticalEvents}  |  High: ${rep.metricsSnapshot.highEvents}  |  Medium: ${medCount}  |  Low: ${lowCount}  |  Conflict Fingerprints: ${rep.metricsSnapshot.fingerprintsIdentified}`
    );
    addWrappedText(`Analyst Summary: ${rep.summary}`);
    if (rep.aiExecutiveSummary) {
      addWrappedText(`Executive Brief:\n${rep.aiExecutiveSummary}`);
    }

    addHeading('3. Identified Conflict Fingerprints');
    if (projFps.length === 0) {
      addWrappedText('No recurring conflict fingerprints met the minimum observation threshold.');
    } else {
      for (const fp of projFps.slice(0, 8)) {
        addWrappedText(
          `• ${fp.locationName} — ${fp.conflictType} (${fp.roadUserCombo}) | ${fp.observedCount} events [${fp.isPreliminary ? 'Preliminary' : 'Established'}] | Window: ${fp.timeWindow} | Zone: ${fp.conflictZone || 'Junction core'}`
        );
      }
    }

    addHeading('4. Supporting Video Evidence References');
    if (projVideos.length === 0) {
      addWrappedText('No analysed video clips attached to this project yet.');
    } else {
      for (const vid of projVideos.slice(0, 8)) {
        addWrappedText(
          `• ${vid.title} (${vid.fileName}) — Recorded ${vid.recordingDate} ${vid.recordingTime}, Duration ${vid.durationSec}s, Status: ${vid.status}`
        );
      }
    }

    addHeading('5. Recommended Infrastructure & Safety Interventions');
    if (projRecs.length === 0) {
      addWrappedText('No formal safety recommendations saved yet.');
    } else {
      for (const rec of projRecs.slice(0, 8)) {
        addWrappedText(`• [${rec.priority} / ${rec.category}] ${rec.title} (${rec.status})`, 9.5, true);
        addWrappedText(`  ${rec.rationale}`);
      }
    }

    addHeading('6. Scientific Methodology & Limitations Disclosure');
    addWrappedText(
      'Provisional Risk Scores (0–100) reflect uncalibrated trajectory proximity, TTC/PET surrogates, and road-user vulnerability. They are NOT calibrated statistical probabilities of collision. Detection confidence is reported separately, and any junction improvement metrics represent analytical simulation estimates requiring on-site municipal traffic engineering audit prior to civil execution.'
    );

    doc.save(`roadshadow_report_${rep.id}.pdf`);
    pushToast({
      type: 'success',
      title: 'PDF Audit Report Downloaded',
      description: `Saved roadshadow_report_${rep.id}.pdf`,
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#F5F8FC]">Automated Safety Reports</h1>
        <p className="text-sm text-[#A9B8CA] mt-1">
          Generate municipal audit briefs with verified metrics snapshots, optional Gemini executive summaries, and PDF/CSV/JSON/Print export.
        </p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        <form
          onSubmit={handleCreate}
          className="xl:col-span-5 bg-[#122943] border border-[#233B56] rounded-lg p-5 space-y-4"
        >
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-semibold text-[#F5F8FC]">Generate Report</h2>
            {canCreate && (
              <button
                type="button"
                disabled={aiBusy}
                onClick={handleGenerateAiSummary}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-[#0D1F35] border border-[#2585FF]/50 text-[#45B5FF] text-xs font-medium rounded-md hover:bg-[#173252]"
              >
                {aiBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Cpu className="w-3.5 h-3.5" />}
                Summarize with Gemini
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
            <label htmlFor="rep-title" className="block text-xs text-[#A9B8CA] mb-1">
              Report Title *
            </label>
            <input
              id="rep-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Anand Municipal Safety Review — Q4"
              className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC]"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="rep-proj" className="block text-xs text-[#A9B8CA] mb-1">
                Project
              </label>
              <select
                id="rep-proj"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-1.5 text-sm text-[#F5F8FC]"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="rep-type" className="block text-xs text-[#A9B8CA] mb-1">
                Report Type
              </label>
              <select
                id="rep-type"
                value={reportType}
                onChange={(e) => setReportType(e.target.value as SafetyReport['reportType'])}
                className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-1.5 text-sm text-[#F5F8FC]"
              >
                {REPORT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="rep-start" className="block text-xs text-[#A9B8CA] mb-1">
                Start Date
              </label>
              <input
                id="rep-start"
                type="date"
                value={dateRangeStart}
                onChange={(e) => setDateRangeStart(e.target.value)}
                className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-1.5 text-sm font-mono text-[#F5F8FC]"
              />
            </div>
            <div>
              <label htmlFor="rep-end" className="block text-xs text-[#A9B8CA] mb-1">
                End Date
              </label>
              <input
                id="rep-end"
                type="date"
                value={dateRangeEnd}
                onChange={(e) => setDateRangeEnd(e.target.value)}
                className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-1.5 text-sm font-mono text-[#F5F8FC]"
              />
            </div>
          </div>

          <div>
            <label htmlFor="rep-summary" className="block text-xs text-[#A9B8CA] mb-1">
              Analyst Summary
            </label>
            <textarea
              id="rep-summary"
              rows={4}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Document key location findings, field observations, and provisional risk caveats..."
              className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC]"
            />
          </div>

          {aiExecutiveSummary && (
            <div className="p-3 rounded-md bg-[#0D1F35] border border-[#2585FF]/40 text-xs text-[#F5F8FC] whitespace-pre-line">
              {aiExecutiveSummary}
            </div>
          )}

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
            Save Safety Report
          </button>
        </form>

        <div className="xl:col-span-7 space-y-4">
          {scopedReports.length === 0 ? (
            <div className="bg-[#122943] border border-[#233B56] rounded-lg p-10 text-center text-sm text-[#A9B8CA]">
              No road safety reports generated yet.
            </div>
          ) : (
            scopedReports.map((rep) => (
              <div
                key={rep.id}
                className="bg-[#122943] border border-[#233B56] rounded-lg p-5 space-y-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 text-xs text-[#45B5FF]">
                      <FileText className="w-3.5 h-3.5" />
                      <span>{rep.reportType}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono text-[#A9B8CA]">
                        {rep.dateRangeStart} to {rep.dateRangeEnd}
                      </span>
                    </div>
                    <h3 className="text-base font-semibold text-[#F5F8FC] mt-1">{rep.title}</h3>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => downloadPdf(rep)}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-[#2585FF] hover:bg-[#1C74E8] text-xs font-medium text-white rounded-md whitespace-nowrap"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Download PDF
                    </button>
                    <button
                      type="button"
                      onClick={() => downloadCsv(rep)}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-[#0D1F35] border border-[#233B56] hover:border-[#2585FF] text-xs text-[#F5F8FC] rounded-md whitespace-nowrap"
                    >
                      <Download className="w-3.5 h-3.5" />
                      CSV
                    </button>
                    <button
                      type="button"
                      onClick={() => downloadJson(rep)}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-[#0D1F35] border border-[#233B56] hover:border-[#2585FF] text-xs text-[#F5F8FC] rounded-md whitespace-nowrap"
                    >
                      <Download className="w-3.5 h-3.5" />
                      JSON
                    </button>
                    <button
                      type="button"
                      onClick={() => window.print()}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-[#0D1F35] border border-[#233B56] hover:border-[#2585FF] text-xs text-[#F5F8FC] rounded-md whitespace-nowrap"
                    >
                      <Printer className="w-3.5 h-3.5" />
                      Print
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 p-3 rounded-md bg-[#0D1F35] border border-[#233B56] text-xs">
                  <div>
                    <p className="text-[#A9B8CA]">Videos</p>
                    <p className="font-mono font-semibold text-[#F5F8FC]">{rep.metricsSnapshot.videosAnalyzed}</p>
                  </div>
                  <div>
                    <p className="text-[#A9B8CA]">Events</p>
                    <p className="font-mono font-semibold text-[#F5F8FC]">{rep.metricsSnapshot.totalEvents}</p>
                  </div>
                  <div>
                    <p className="text-[#E5484D]">Critical</p>
                    <p className="font-mono font-semibold text-[#F5F8FC]">{rep.metricsSnapshot.criticalEvents}</p>
                  </div>
                  <div>
                    <p className="text-[#F97316]">High</p>
                    <p className="font-mono font-semibold text-[#F5F8FC]">{rep.metricsSnapshot.highEvents}</p>
                  </div>
                  <div>
                    <p className="text-[#22C55E]">Verified</p>
                    <p className="font-mono font-semibold text-[#F5F8FC]">{rep.metricsSnapshot.verifiedEvents}</p>
                  </div>
                  <div>
                    <p className="text-[#45B5FF]">Patterns</p>
                    <p className="font-mono font-semibold text-[#F5F8FC]">{rep.metricsSnapshot.fingerprintsIdentified}</p>
                  </div>
                </div>

                <p className="text-sm text-[#A9B8CA] leading-relaxed">{rep.summary}</p>

                {rep.aiExecutiveSummary && (
                  <div className="p-3.5 rounded-md bg-[#0D1F35] border border-[#2585FF]/35 text-xs text-[#F5F8FC] whitespace-pre-line leading-relaxed">
                    <p className="font-semibold text-[#45B5FF] mb-1">Gemini Executive Brief</p>
                    {rep.aiExecutiveSummary}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
