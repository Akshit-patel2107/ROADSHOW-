import type {
  AnalysisQualityMode,
  GeminiDetectedObject,
  GeminiImportantMoment,
  GeminiRiskLevel,
  GeminiTimelineEvent,
  GeminiVideoAnalysis,
  SegmentProgressSummary,
} from '../types/roadshadow';
import {
  clampSecondsToDuration,
  formatSecondsToTimestamp,
  parseTimestampToSeconds,
} from './geminiVideoAnalysis';

export interface QualityModeConfig {
  mode: AnalysisQualityMode;
  label: string;
  description: string;
  fastScanModel: string;
  detailedModel: string;
  fastScanThinkingLevel: 'MINIMAL' | 'LOW';
  detailedThinkingLevel: 'LOW' | 'MEDIUM';
  targetSegmentSec: number;
  singleSegmentMaxSec: number;
  maxSegments: number;
  maxFramesPerSegment: number;
  frameWidthPx: number;
  jpegQuality: number;
  enableDetailedStage: boolean;
  maxDetailedMoments: number;
  detailedWindowHalfSec: number;
  detailedFramesPerMoment: number;
  detailedFrameWidthPx: number;
  maxConcurrency: number;
}

/**
 * Verified active Gemini model presets:
 * - Fast Scan: gemini-3.1-flash-lite (lowest latency, default MINIMAL thinking, no paid-key gate)
 * - Detailed Refinement: gemini-4-hydrogen with LOW/MEDIUM thinking (only on flagged high/critical moments)
 */
export const QUALITY_MODE_CONFIGS: Record<AnalysisQualityMode, QualityModeConfig> = {
  fast: {
    mode: 'fast',
    label: 'Fast',
    description: 'Lowest latency Fast Scan only — concise summary and major events.',
    fastScanModel: 'gemini-3.1-flash-lite',
    detailedModel: 'gemini-3.1-flash-lite',
    fastScanThinkingLevel: 'MINIMAL',
    detailedThinkingLevel: 'LOW',
    targetSegmentSec: 30,
    singleSegmentMaxSec: 40,
    maxSegments: 12,
    maxFramesPerSegment: 6,
    frameWidthPx: 512,
    jpegQuality: 7,
    enableDetailedStage: false,
    maxDetailedMoments: 0,
    detailedWindowHalfSec: 3,
    detailedFramesPerMoment: 4,
    detailedFrameWidthPx: 640,
    maxConcurrency: 2,
  },
  balanced: {
    mode: 'balanced',
    label: 'Balanced',
    description: 'Fast Scan across segments plus selective detailed refinement on flagged risks (Default).',
    fastScanModel: 'gemini-3.1-flash-lite',
    detailedModel: 'gemini-4-hydrogen',
    fastScanThinkingLevel: 'MINIMAL',
    detailedThinkingLevel: 'LOW',
    targetSegmentSec: 25,
    singleSegmentMaxSec: 32,
    maxSegments: 16,
    maxFramesPerSegment: 8,
    frameWidthPx: 640,
    jpegQuality: 6,
    enableDetailedStage: true,
    maxDetailedMoments: 2,
    detailedWindowHalfSec: 4,
    detailedFramesPerMoment: 4,
    detailedFrameWidthPx: 768,
    maxConcurrency: 2,
  },
  detailed: {
    mode: 'detailed',
    label: 'Detailed',
    description: 'Higher frame density and deeper second-stage analysis on up to 3 important moments.',
    fastScanModel: 'gemini-3.1-flash-lite',
    detailedModel: 'gemini-4-hydrogen',
    fastScanThinkingLevel: 'LOW',
    detailedThinkingLevel: 'MEDIUM',
    targetSegmentSec: 20,
    singleSegmentMaxSec: 25,
    maxSegments: 20,
    maxFramesPerSegment: 10,
    frameWidthPx: 768,
    jpegQuality: 5,
    enableDetailedStage: true,
    maxDetailedMoments: 3,
    detailedWindowHalfSec: 5,
    detailedFramesPerMoment: 5,
    detailedFrameWidthPx: 896,
    maxConcurrency: 2,
  },
};

export function normalizeQualityMode(input: unknown): AnalysisQualityMode {
  if (input === 'fast' || input === 'balanced' || input === 'detailed') {
    return input;
  }
  return 'balanced';
}

export interface PlannedVideoSegment {
  segmentIndex: number;
  startSec: number;
  endSec: number;
  sampleTimestampsSec: number[];
}

/**
 * Plans smart, non-overlapping video segments and deterministic original-video frame timestamps.
 * Avoids creating tiny trailing segments or excessive API calls for long videos.
 */
export function planVideoSegments(
  durationSec: number,
  qualityMode: AnalysisQualityMode = 'balanced'
): PlannedVideoSegment[] {
  const cfg = QUALITY_MODE_CONFIGS[normalizeQualityMode(qualityMode)];
  const safeDuration = Number.isFinite(durationSec) && durationSec > 0 ? Number(durationSec.toFixed(2)) : 1;

  const buildTimestamps = (start: number, end: number, maxFrames: number): number[] => {
    const span = Math.max(0.2, end - start);
    // For very short clips (e.g. 4s), sample ~1 fps up to maxFrames, minimum 2 frames if duration >= 1s
    const idealCount =
      safeDuration <= 2
        ? Math.min(maxFrames, Math.max(1, Math.ceil(span * 2)))
        : Math.min(maxFrames, Math.max(2, Math.ceil(span / Math.max(1, span / maxFrames))));
    const count = Math.max(1, Math.min(maxFrames, Math.min(Math.max(2, Math.ceil(span)), idealCount)));

    if (count === 1) {
      return [Number(Math.min(safeDuration, start + span * 0.5).toFixed(2))];
    }
    const out: number[] = [];
    // Inset slightly from exact end so ffmpeg always hits a valid decodable frame
    const usableEnd = Math.max(start, end - Math.min(0.2, span * 0.05));
    for (let i = 0; i < count; i++) {
      const frac = i / (count - 1);
      const t = Number((start + (usableEnd - start) * frac).toFixed(2));
      if (out.length === 0 || t - out[out.length - 1] >= 0.25) {
        out.push(Math.min(safeDuration, Math.max(0, t)));
      }
    }
    return out.length > 0 ? out : [Number(start.toFixed(2))];
  };

  if (safeDuration <= cfg.singleSegmentMaxSec) {
    return [
      {
        segmentIndex: 0,
        startSec: 0,
        endSec: safeDuration,
        sampleTimestampsSec: buildTimestamps(0, safeDuration, cfg.maxFramesPerSegment),
      },
    ];
  }

  // Compute balanced segment count capped by maxSegments so long videos never spawn tiny segments
  const rawCount = Math.ceil(safeDuration / cfg.targetSegmentSec);
  const segCount = Math.max(2, Math.min(cfg.maxSegments, rawCount));
  const segSpan = safeDuration / segCount;

  const segments: PlannedVideoSegment[] = [];
  for (let i = 0; i < segCount; i++) {
    const startSec = Number((i * segSpan).toFixed(2));
    const endSec = i === segCount - 1 ? safeDuration : Number(((i + 1) * segSpan).toFixed(2));
    segments.push({
      segmentIndex: i,
      startSec,
      endSec,
      sampleTimestampsSec: buildTimestamps(startSec, endSec, cfg.maxFramesPerSegment),
    });
  }
  return segments;
}

export interface SampledFramePayload {
  timestampSec: number;
  timestampLabel: string;
  base64Jpeg: string;
  byteLength: number;
}

/**
 * Deduplicates consecutive visually-identical frames using fast byte-size + sampled byte fingerprint comparison.
 * Always keeps the first and last frame so segment boundaries stay accurate.
 */
export function deduplicateAdjacentFrames(frames: SampledFramePayload[]): SampledFramePayload[] {
  if (frames.length <= 2) return frames;

  const fingerprint = (b64: string): string => {
    const len = b64.length;
    if (len < 128) return b64;
    const step = Math.floor(len / 8);
    let sig = '';
    for (let i = 1; i <= 6; i++) {
      sig += b64.slice(i * step, i * step + 16);
    }
    return sig;
  };

  const kept: SampledFramePayload[] = [frames[0]];
  let prevSig = fingerprint(frames[0].base64Jpeg);
  let prevLen = frames[0].byteLength;

  for (let i = 1; i < frames.length - 1; i++) {
    const cur = frames[i];
    const curSig = fingerprint(cur.base64Jpeg);
    const sizeRatio = prevLen > 0 ? Math.abs(cur.byteLength - prevLen) / prevLen : 1;
    // Skip only if nearly identical signature and < 1.5% byte-size change
    if (curSig === prevSig && sizeRatio < 0.015) {
      continue;
    }
    kept.push(cur);
    prevSig = curSig;
    prevLen = cur.byteLength;
  }

  kept.push(frames[frames.length - 1]);
  return kept;
}

export interface SegmentAnalysisResult {
  segmentIndex: number;
  startSec: number;
  endSec: number;
  analysis: GeminiVideoAnalysis;
}

const RISK_RANK: Record<GeminiRiskLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3)
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const token of a) {
    if (b.has(token)) inter++;
  }
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Normalizes a segment event timestamp into original-video coordinates.
 * Handles both absolute timestamps (already inside [startSec, endSec]) and segment-relative timestamps.
 */
export function resolveOriginalTimestampSec(
  rawTs: string | number | undefined,
  segmentStartSec: number,
  segmentEndSec: number,
  totalDurationSec: number
): { sec: number; wasAdjusted: boolean } {
  const parsed = parseTimestampToSeconds(rawTs);
  if (parsed === null) {
    return { sec: Number(segmentStartSec.toFixed(2)), wasAdjusted: true };
  }

  const segSpan = Math.max(0.5, segmentEndSec - segmentStartSec);
  let resolved = parsed;

  // If segment starts > 0 and model returned a segment-relative timestamp (0..segSpan), shift by segmentStartSec
  if (segmentStartSec >= 2 && parsed < segmentStartSec - 0.5 && parsed <= segSpan + 1.5) {
    resolved = segmentStartSec + parsed;
  }

  // Clamp strictly to segment bounds (with tiny 0.5s grace) and total duration
  const boundedMin = Math.max(0, segmentStartSec);
  const boundedMax = Math.min(totalDurationSec, segmentEndSec);
  if (resolved < boundedMin) {
    return { sec: Number(boundedMin.toFixed(2)), wasAdjusted: true };
  }
  if (resolved > boundedMax) {
    return { sec: Number(boundedMax.toFixed(2)), wasAdjusted: true };
  }
  const clamped = clampSecondsToDuration(resolved, totalDurationSec);
  return { sec: clamped.sec, wasAdjusted: clamped.wasClamped || clamped.wasMissing };
}

/**
 * Merges independent segment analyses into a single unified, chronologically sorted,
 * boundary-deduplicated GeminiVideoAnalysis with accurate original-video timestamps.
 */
export function mergeSegmentAnalyses(
  segmentResults: SegmentAnalysisResult[],
  opts: {
    totalDurationSec: number;
    modelVersion: string;
    analyzedAtIso?: string;
    partialWarning?: string;
  }
): GeminiVideoAnalysis {
  const sorted = [...segmentResults].sort((a, b) => a.segmentIndex - b.segmentIndex);
  const safeDuration = Number(Math.max(0, opts.totalDurationSec).toFixed(2));

  if (sorted.length === 0) {
    return {
      video_summary: 'No completed video segments were available to summarize.',
      duration_seconds: safeDuration,
      events: [],
      detected_objects: [],
      important_moments: [],
      safety_observations: opts.partialWarning ? [opts.partialWarning] : [],
      overall_assessment: 'Analysis could not produce segment results.',
      model_version: opts.modelVersion,
      analyzed_at: opts.analyzedAtIso || new Date().toISOString(),
    };
  }

  // 1. Re-anchor timestamps to original video timeline & collect all events
  const rawEvents: GeminiTimelineEvent[] = [];
  for (const seg of sorted) {
    for (const ev of seg.analysis.events) {
      const startRes = resolveOriginalTimestampSec(
        ev.timestamp_start,
        seg.startSec,
        seg.endSec,
        safeDuration
      );
      const endRes = resolveOriginalTimestampSec(
        ev.timestamp_end,
        seg.startSec,
        seg.endSec,
        safeDuration
      );
      const finalStart = startRes.sec;
      const finalEnd = Math.max(finalStart, endRes.sec);
      rawEvents.push({
        ...ev,
        timestamp_start: formatSecondsToTimestamp(finalStart),
        timestamp_end: formatSecondsToTimestamp(finalEnd),
        timestamp_start_sec: finalStart,
        timestamp_end_sec: finalEnd,
        is_approximate: Boolean(ev.is_approximate || startRes.wasAdjusted || endRes.wasAdjusted),
      });
    }
  }
  rawEvents.sort((a, b) => a.timestamp_start_sec - b.timestamp_start_sec);

  // 2. Deduplicate overlapping / boundary events
  const mergedEvents: GeminiTimelineEvent[] = [];
  for (const ev of rawEvents) {
    const prev = mergedEvents[mergedEvents.length - 1];
    if (prev) {
      const timeGap = ev.timestamp_start_sec - prev.timestamp_end_sec;
      const textSim = jaccardSimilarity(
        tokenize(`${prev.event} ${prev.activity}`),
        tokenize(`${ev.event} ${ev.activity}`)
      );
      const objSim = jaccardSimilarity(
        new Set(prev.objects_detected),
        new Set(ev.objects_detected)
      );
      if (timeGap <= 2.5 && (textSim >= 0.45 || (textSim >= 0.25 && objSim >= 0.5))) {
        prev.timestamp_end_sec = Math.max(prev.timestamp_end_sec, ev.timestamp_end_sec);
        prev.timestamp_end = formatSecondsToTimestamp(prev.timestamp_end_sec);
        prev.objects_detected = Array.from(
          new Set([...prev.objects_detected, ...ev.objects_detected])
        ).slice(0, 12);
        if (RISK_RANK[ev.risk_level] > RISK_RANK[prev.risk_level]) {
          prev.risk_level = ev.risk_level;
          prev.reason = ev.reason || prev.reason;
        }
        continue;
      }
    }
    mergedEvents.push({ ...ev });
  }

  // 3. Merge detected objects without wildly overcounting persistent objects across segments
  const objMap = new Map<string, GeminiDetectedObject>();
  for (const seg of sorted) {
    for (const obj of seg.analysis.detected_objects) {
      const key = obj.label.trim().toLowerCase();
      if (!key) continue;
      const existing = objMap.get(key);
      if (!existing) {
        objMap.set(key, {
          label: key,
          count_estimate: Math.max(0, Math.round(obj.count_estimate)),
          notes: obj.notes,
        });
      } else {
        // Use peak count across segments so a parked car seen in 3 segments is not triple-counted
        existing.count_estimate = Math.max(
          existing.count_estimate,
          Math.max(0, Math.round(obj.count_estimate))
        );
        if (!existing.notes && obj.notes) {
          existing.notes = obj.notes;
        }
      }
    }
  }

  // 4. Merge & deduplicate important moments within 2s
  const rawMoments: GeminiImportantMoment[] = [];
  for (const seg of sorted) {
    for (const m of seg.analysis.important_moments) {
      const res = resolveOriginalTimestampSec(
        m.timestamp,
        seg.startSec,
        seg.endSec,
        safeDuration
      );
      rawMoments.push({
        timestamp: formatSecondsToTimestamp(res.sec),
        timestamp_sec: res.sec,
        is_approximate: Boolean(m.is_approximate || res.wasAdjusted),
        description: m.description,
      });
    }
  }
  rawMoments.sort((a, b) => a.timestamp_sec - b.timestamp_sec);
  const mergedMoments: GeminiImportantMoment[] = [];
  for (const m of rawMoments) {
    const prev = mergedMoments[mergedMoments.length - 1];
    if (
      prev &&
      Math.abs(m.timestamp_sec - prev.timestamp_sec) <= 2.0 &&
      jaccardSimilarity(tokenize(prev.description), tokenize(m.description)) >= 0.4
    ) {
      continue;
    }
    mergedMoments.push(m);
  }

  // 5. Deduplicate safety observations
  const safetySet = new Set<string>();
  const safetyObs: string[] = [];
  for (const seg of sorted) {
    for (const obs of seg.analysis.safety_observations) {
      const trimmed = obs.trim();
      const norm = trimmed.toLowerCase();
      if (trimmed && !safetySet.has(norm)) {
        safetySet.add(norm);
        safetyObs.push(trimmed);
      }
    }
  }
  if (opts.partialWarning && !safetySet.has(opts.partialWarning.toLowerCase())) {
    safetyObs.push(opts.partialWarning);
  }

  // 6. Synthesize unified summary and assessment
  const videoSummary =
    sorted.length === 1
      ? sorted[0].analysis.video_summary
      : sorted
          .map(
            (s) =>
              `[${formatSecondsToTimestamp(s.startSec)}–${formatSecondsToTimestamp(s.endSec)}] ${s.analysis.video_summary}`
          )
          .join(' ')
          .slice(0, 1500);

  const overallAssessment =
    sorted.length === 1
      ? sorted[0].analysis.overall_assessment
      : Array.from(new Set(sorted.map((s) => s.analysis.overall_assessment.trim()).filter(Boolean)))
          .join(' ')
          .slice(0, 1500);

  return {
    video_summary: videoSummary,
    duration_seconds: safeDuration,
    events: mergedEvents.slice(0, 50),
    detected_objects: Array.from(objMap.values()).slice(0, 30),
    important_moments: mergedMoments.slice(0, 30),
    safety_observations: safetyObs.slice(0, 20),
    overall_assessment: overallAssessment,
    model_version: opts.modelVersion,
    analyzed_at: opts.analyzedAtIso || new Date().toISOString(),
  };
}

export interface DetailedTargetWindow {
  eventIndex: number;
  centerSec: number;
  windowStartSec: number;
  windowEndSec: number;
  eventTitle: string;
  riskLevel: GeminiRiskLevel;
}

/**
 * Selects only the highest-priority flagged events from Fast Scan for Stage B Detailed Analysis.
 * Skips Stage B entirely in 'fast' mode or when no medium/high/critical events exist.
 */
export function selectDetailedTargetWindows(
  fastScan: GeminiVideoAnalysis,
  qualityMode: AnalysisQualityMode,
  totalDurationSec: number
): DetailedTargetWindow[] {
  const cfg = QUALITY_MODE_CONFIGS[normalizeQualityMode(qualityMode)];
  if (!cfg.enableDetailedStage || cfg.maxDetailedMoments <= 0) return [];

  const candidates = fastScan.events
    .map((ev, idx) => ({ ev, idx }))
    .filter(({ ev }) => {
      if (qualityMode === 'balanced') {
        return ev.risk_level === 'critical' || ev.risk_level === 'high' || ev.risk_level === 'medium';
      }
      return true; // detailed mode can inspect any notable event
    })
    .sort((a, b) => {
      const rankDiff = RISK_RANK[b.ev.risk_level] - RISK_RANK[a.ev.risk_level];
      if (rankDiff !== 0) return rankDiff;
      return a.ev.timestamp_start_sec - b.ev.timestamp_start_sec;
    });

  const selected: DetailedTargetWindow[] = [];
  for (const { ev, idx } of candidates) {
    if (selected.length >= cfg.maxDetailedMoments) break;
    const centerSec = Number(((ev.timestamp_start_sec + ev.timestamp_end_sec) / 2).toFixed(2));
    // Avoid picking two windows overlapping the same moment
    if (selected.some((s) => Math.abs(s.centerSec - centerSec) < cfg.detailedWindowHalfSec * 1.2)) {
      continue;
    }
    const windowStartSec = Number(Math.max(0, centerSec - cfg.detailedWindowHalfSec).toFixed(2));
    const windowEndSec = Number(
      Math.min(Math.max(totalDurationSec, 1), centerSec + cfg.detailedWindowHalfSec).toFixed(2)
    );
    selected.push({
      eventIndex: idx,
      centerSec,
      windowStartSec,
      windowEndSec,
      eventTitle: ev.event,
      riskLevel: ev.risk_level,
    });
  }
  return selected;
}

/**
 * Given previous job segments and newly planned segments, identifies which completed
 * segments can be preserved and which failed/pending segments must be executed on retry.
 */
export function partitionSegmentsForRetry(
  previousSegments: SegmentProgressSummary[] | undefined,
  planned: PlannedVideoSegment[]
): { reusedIndices: number[]; pendingIndices: number[] } {
  if (!previousSegments || previousSegments.length !== planned.length) {
    return {
      reusedIndices: [],
      pendingIndices: planned.map((s) => s.segmentIndex),
    };
  }
  const reusedIndices: number[] = [];
  const pendingIndices: number[] = [];
  for (let i = 0; i < planned.length; i++) {
    const prev = previousSegments[i];
    if (
      prev &&
      prev.status === 'completed' &&
      Math.abs(prev.startSec - planned[i].startSec) < 0.5 &&
      Math.abs(prev.endSec - planned[i].endSec) < 0.5
    ) {
      reusedIndices.push(i);
    } else {
      pendingIndices.push(i);
    }
  }
  // If all segments previously completed, retry all cleanly (full re-run)
  if (pendingIndices.length === 0) {
    return {
      reusedIndices: [],
      pendingIndices: planned.map((s) => s.segmentIndex),
    };
  }
  return { reusedIndices, pendingIndices };
}

/**
 * Runs an async worker across items with strict bounded concurrency.
 */
export async function runWithBoundedConcurrency<T, R>(
  items: T[],
  maxConcurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const limit = Math.max(1, Math.min(maxConcurrency, items.length || 1));
  const results = new Array<R>(items.length);
  let nextIdx = 0;

  const runner = async () => {
    while (true) {
      const current = nextIdx++;
      if (current >= items.length) return;
      results[current] = await worker(items[current], current);
    }
  };

  await Promise.all(Array.from({ length: limit }, () => runner()));
  return results;
}
