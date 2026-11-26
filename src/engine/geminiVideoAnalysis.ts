import { z } from 'zod';
import type {
  ConflictEvent,
  ConflictType,
  CvDetectionsSummary,
  DetectedObjectClass,
  RiskCategory,
} from '../types/roadshadow';

export type GeminiConfidence = 'low' | 'medium' | 'high';
export type GeminiRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface GeminiTimelineEvent {
  timestamp_start: string;
  timestamp_end: string;
  timestamp_start_sec: number;
  timestamp_end_sec: number;
  is_approximate: boolean;
  event: string;
  objects_detected: string[];
  activity: string;
  confidence: GeminiConfidence;
  risk_level: GeminiRiskLevel;
  reason: string;
}

export interface GeminiDetectedObject {
  label: string;
  count_estimate: number;
  notes: string;
}

export interface GeminiImportantMoment {
  timestamp: string;
  timestamp_sec: number;
  is_approximate: boolean;
  description: string;
}

export interface GeminiVideoAnalysis {
  video_summary: string;
  duration_seconds: number;
  events: GeminiTimelineEvent[];
  detected_objects: GeminiDetectedObject[];
  important_moments: GeminiImportantMoment[];
  safety_observations: string[];
  overall_assessment: string;
  model_version: string;
  analyzed_at: string;
}

/**
 * Parses HH:MM:SS, MM:SS, MM:SS.s, or numeric seconds into non-negative seconds.
 * Returns null if the input cannot be parsed cleanly.
 */
export function parseTimestampToSeconds(input: string | number | null | undefined): number | null {
  if (typeof input === 'number') {
    return Number.isFinite(input) && input >= 0 ? Number(input.toFixed(2)) : null;
  }
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Plain numeric seconds (e.g. "12", "12.5", "12s")
  const plainMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*s?$/i);
  if (plainMatch) {
    const val = Number(plainMatch[1]);
    return Number.isFinite(val) && val >= 0 ? Number(val.toFixed(2)) : null;
  }

  // Colon-separated HH:MM:SS(.ms) or MM:SS(.ms)
  const parts = trimmed.split(':');
  if (parts.length === 2 || parts.length === 3) {
    const nums = parts.map((p) => Number(p));
    if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
    if (parts.length === 2) {
      const [m, s] = nums;
      return Number((m * 60 + s).toFixed(2));
    }
    const [h, m, s] = nums;
    return Number((h * 3600 + m * 60 + s).toFixed(2));
  }

  return null;
}

/**
 * Formats non-negative seconds into HH:MM:SS.
 */
export function formatSecondsToTimestamp(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds) : 0;
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  return [hrs, mins, secs].map((v) => String(v).padStart(2, '0')).join(':');
}

export function clampSecondsToDuration(
  sec: number | null,
  durationSec: number
): { sec: number; wasClamped: boolean; wasMissing: boolean } {
  const maxDur = Number.isFinite(durationSec) && durationSec > 0 ? Number(durationSec.toFixed(2)) : 0;
  if (sec === null || !Number.isFinite(sec) || sec < 0) {
    return { sec: 0, wasClamped: false, wasMissing: true };
  }
  if (maxDur > 0 && sec > maxDur) {
    return { sec: maxDur, wasClamped: true, wasMissing: false };
  }
  return { sec: Number(sec.toFixed(2)), wasClamped: false, wasMissing: false };
}

function normalizeConfidence(val: unknown): GeminiConfidence {
  const lower = String(val ?? '').trim().toLowerCase();
  if (lower === 'high' || lower === 'medium' || lower === 'low') return lower;
  return 'medium';
}

function normalizeRiskLevel(val: unknown): GeminiRiskLevel {
  const lower = String(val ?? '').trim().toLowerCase();
  if (lower === 'critical' || lower === 'high' || lower === 'medium' || lower === 'low') {
    return lower;
  }
  return 'low';
}

const rawEventSchema = z.object({
  timestamp_start: z.union([z.string(), z.number()]).optional(),
  timestamp_end: z.union([z.string(), z.number()]).optional(),
  is_approximate: z.boolean().optional(),
  event: z.string().min(1).max(600),
  objects_detected: z.array(z.string().max(80)).max(20).optional().default([]),
  activity: z.string().max(400).optional().default('Observed scene activity'),
  confidence: z.string().optional().default('medium'),
  risk_level: z.string().optional().default('low'),
  reason: z.string().max(600).optional().default(''),
});

const rawDetectedObjectSchema = z.object({
  label: z.string().min(1).max(80),
  count_estimate: z.number().min(0).max(10000).optional().default(1),
  notes: z.string().max(300).optional().default(''),
});

const rawImportantMomentSchema = z.object({
  timestamp: z.union([z.string(), z.number()]).optional(),
  is_approximate: z.boolean().optional(),
  description: z.string().min(1).max(500),
});

const rawGeminiAnalysisSchema = z.object({
  video_summary: z.string().min(3).max(2000),
  duration_seconds: z.number().min(0).max(86400).optional(),
  events: z.array(rawEventSchema).max(60).optional().default([]),
  detected_objects: z.array(rawDetectedObjectSchema).max(40).optional().default([]),
  important_moments: z.array(rawImportantMomentSchema).max(40).optional().default([]),
  safety_observations: z.array(z.string().min(1).max(500)).max(30).optional().default([]),
  overall_assessment: z.string().min(3).max(2000),
});

function extractJsonPayload(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Gemini returned an empty response for video analysis.');
  }
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    // Fallback: find outermost JSON object
    const firstBrace = candidate.indexOf('{');
    const lastBrace = candidate.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
      } catch {
        // Fall through to error
      }
    }
    throw new Error('Gemini returned malformed JSON that could not be parsed.');
  }
}

/**
 * Strictly validates, sanitizes, and clamps timestamps on Gemini's structured video analysis output.
 * Never fabricates events, objects, or metrics when the model reports none.
 */
export function validateAndNormalizeGeminiAnalysis(
  raw: unknown,
  opts: {
    durationSec: number;
    modelVersion: string;
    analyzedAtIso?: string;
  }
): GeminiVideoAnalysis {
  const parsedObj = extractJsonPayload(raw);
  const checked = rawGeminiAnalysisSchema.safeParse(parsedObj);
  if (!checked.success) {
    throw new Error(
      `Gemini video analysis failed schema validation: ${checked.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
        .join('; ')}`
    );
  }

  const data = checked.data;
  const authoritativeDuration =
    Number.isFinite(opts.durationSec) && opts.durationSec > 0
      ? Number(opts.durationSec.toFixed(2))
      : Number((data.duration_seconds ?? 0).toFixed(2));

  const normalizedEvents: GeminiTimelineEvent[] = data.events.slice(0, 40).map((ev) => {
    const startParsed = parseTimestampToSeconds(ev.timestamp_start);
    const endParsed = parseTimestampToSeconds(ev.timestamp_end);
    const startClamped = clampSecondsToDuration(startParsed, authoritativeDuration);
    const endRaw = endParsed !== null ? endParsed : startClamped.sec;
    const endClamped = clampSecondsToDuration(endRaw, authoritativeDuration);

    const finalStart = startClamped.sec;
    const finalEnd = Math.max(finalStart, endClamped.sec);
    const isApprox =
      Boolean(ev.is_approximate) ||
      startClamped.wasClamped ||
      startClamped.wasMissing ||
      endClamped.wasClamped ||
      endParsed === null;

    const cleanObjects = Array.from(
      new Set(
        (ev.objects_detected || [])
          .map((o) => o.trim().toLowerCase())
          .filter((o) => o.length > 0)
      )
    ).slice(0, 12);

    return {
      timestamp_start: formatSecondsToTimestamp(finalStart),
      timestamp_end: formatSecondsToTimestamp(finalEnd),
      timestamp_start_sec: finalStart,
      timestamp_end_sec: finalEnd,
      is_approximate: isApprox,
      event: ev.event.trim().slice(0, 500),
      objects_detected: cleanObjects,
      activity: (ev.activity || 'Observed scene activity').trim().slice(0, 300),
      confidence: normalizeConfidence(ev.confidence),
      risk_level: normalizeRiskLevel(ev.risk_level),
      reason: (ev.reason || 'Observed directly in video frames.').trim().slice(0, 500),
    };
  });

  // Sort timeline chronologically
  normalizedEvents.sort((a, b) => a.timestamp_start_sec - b.timestamp_start_sec);

  // Deduplicate and sanitize detected objects
  const objectMap = new Map<string, GeminiDetectedObject>();
  for (const obj of data.detected_objects) {
    const label = obj.label.trim().toLowerCase().slice(0, 64);
    if (!label) continue;
    const count = Math.max(0, Math.round(obj.count_estimate));
    const existing = objectMap.get(label);
    if (existing) {
      existing.count_estimate = Math.max(existing.count_estimate, count);
      if (!existing.notes && obj.notes.trim()) {
        existing.notes = obj.notes.trim().slice(0, 240);
      }
    } else {
      objectMap.set(label, {
        label,
        count_estimate: count,
        notes: obj.notes.trim().slice(0, 240),
      });
    }
  }
  const normalizedObjects = Array.from(objectMap.values()).slice(0, 30);

  const normalizedMoments: GeminiImportantMoment[] = data.important_moments
    .slice(0, 30)
    .map((m) => {
      const parsedTs = parseTimestampToSeconds(m.timestamp);
      const clamped = clampSecondsToDuration(parsedTs, authoritativeDuration);
      return {
        timestamp: formatSecondsToTimestamp(clamped.sec),
        timestamp_sec: clamped.sec,
        is_approximate: Boolean(m.is_approximate) || clamped.wasClamped || clamped.wasMissing,
        description: m.description.trim().slice(0, 400),
      };
    })
    .sort((a, b) => a.timestamp_sec - b.timestamp_sec);

  const normalizedSafetyObs = data.safety_observations
    .map((s) => s.trim().slice(0, 400))
    .filter((s) => s.length > 0)
    .slice(0, 20);

  return {
    video_summary: data.video_summary.trim().slice(0, 1500),
    duration_seconds: authoritativeDuration,
    events: normalizedEvents,
    detected_objects: normalizedObjects,
    important_moments: normalizedMoments,
    safety_observations: normalizedSafetyObs,
    overall_assessment: data.overall_assessment.trim().slice(0, 1500),
    model_version: opts.modelVersion,
    analyzed_at: opts.analyzedAtIso || new Date().toISOString(),
  };
}

/**
 * Builds ROADSHADOW's detectionsSummary strictly from Gemini's reported detected_objects.
 */
export function buildDetectionsSummaryFromGemini(
  analysis: GeminiVideoAnalysis
): CvDetectionsSummary {
  const byClass: Record<string, number> = {};
  let total = 0;
  for (const obj of analysis.detected_objects) {
    const key = obj.label.trim().toLowerCase().replace(/\s+/g, '_');
    const count = Math.max(0, Math.round(obj.count_estimate));
    if (!key) continue;
    byClass[key] = (byClass[key] || 0) + count;
    total += count;
  }
  return {
    total_detections: total,
    by_class: byClass,
  };
}

export function mapLabelToRoadUserClass(label: string): DetectedObjectClass {
  const lower = label.toLowerCase();
  if (/(pedestrian|person|people|walker|human|child|man|woman)/.test(lower)) return 'person';
  if (/(bicycle|bike|cyclist)/.test(lower)) return 'bicycle';
  if (/(motorcycle|motorbike|two[- ]?wheeler)/.test(lower)) return 'motorcycle';
  if (/(scooter|moped)/.test(lower)) return 'scooter';
  if (/(auto|rickshaw|tuk)/.test(lower)) return 'auto_rickshaw';
  if (/(bus|coach)/.test(lower)) return 'bus';
  if (/(truck|lorry|van|tractor|pickup|suv)/.test(lower)) return 'truck';
  if (/(car|sedan|taxi|cab|vehicle)/.test(lower)) return 'car';
  return 'other_vehicle';
}

function inferConflictType(ev: GeminiTimelineEvent, roadUsers: DetectedObjectClass[]): ConflictType {
  const text = `${ev.event} ${ev.activity} ${ev.reason}`.toLowerCase();
  if (/(wrong[- ]?way|wrong[- ]?direction|contraflow|opposite lane)/.test(text)) {
    return 'Wrong-direction movement';
  }
  if (/(sudden brak|hard brak|abrupt stop|emergency stop|rear[- ]?end)/.test(text)) {
    return 'Sudden braking';
  }
  if (/(merg|lane change|cut[- ]?in|weaving|overtak)/.test(text)) {
    return 'Unsafe merging';
  }
  if (
    roadUsers.includes('person') ||
    /(pedestrian|jaywalk|crosswalk|person crossing)/.test(text)
  ) {
    return 'Pedestrian versus vehicle';
  }
  if (
    (roadUsers.includes('motorcycle') || roadUsers.includes('scooter')) &&
    (roadUsers.includes('car') || roadUsers.includes('bus') || roadUsers.includes('truck'))
  ) {
    return 'Motorcycle versus turning car';
  }
  if (/(cross|jaywalk|intersection|junction|turn)/.test(text)) {
    return /(intersection|junction)/.test(text)
      ? 'Vehicle intersection conflict'
      : 'Crossing conflict';
  }
  return 'Other potential conflict';
}

function isSafetyRelevantEvent(ev: GeminiTimelineEvent): boolean {
  if (ev.risk_level === 'medium' || ev.risk_level === 'high' || ev.risk_level === 'critical') {
    return true;
  }
  const text = `${ev.event} ${ev.activity} ${ev.reason}`.toLowerCase();
  return /(near[- ]?miss|conflict|hazard|collision|close pass|sudden brak|unsafe|jaywalk|wrong[- ]?way|swerv|evasive|red light|unusual|suspicious)/.test(
    text
  );
}

/**
 * Maps safety-relevant Gemini timeline events into ROADSHADOW ConflictEvent records.
 * Returns [] if Gemini observed no safety-relevant events (never fabricates incidents).
 */
export function mapGeminiAnalysisToConflictEvents(
  analysis: GeminiVideoAnalysis,
  ctx: {
    videoId: string;
    projectId: string;
    locationId: string;
    ownerId: string;
    fps?: number;
    occurredAtIso?: string;
    jobId: string;
  }
): ConflictEvent[] {
  const nowIso = new Date().toISOString();
  const fps = ctx.fps && ctx.fps > 0 ? ctx.fps : 25;
  const cleanJobSuffix = ctx.jobId.replace(/[^a-zA-Z0-9_]/g, '').slice(-10) || 'gemini';

  const safetyEvents = analysis.events.filter(isSafetyRelevantEvent);

  return safetyEvents.map((ev, idx) => {
    const mappedUsers = Array.from(
      new Set(ev.objects_detected.map(mapLabelToRoadUserClass))
    ).slice(0, 6);
    const roadUsers: DetectedObjectClass[] =
      mappedUsers.length > 0 ? mappedUsers : ['other_vehicle'];

    const conflictType = inferConflictType(ev, roadUsers);

    const riskCategory: RiskCategory =
      ev.risk_level === 'critical'
        ? 'Critical'
        : ev.risk_level === 'high'
          ? 'High'
          : ev.risk_level === 'medium'
            ? 'Medium'
            : 'Low';

    const severity: 'low' | 'medium' | 'high' =
      ev.risk_level === 'critical' || ev.risk_level === 'high'
        ? 'high'
        : ev.risk_level === 'medium'
          ? 'medium'
          : 'low';

    const riskScore =
      ev.risk_level === 'critical'
        ? 90
        : ev.risk_level === 'high'
          ? 76
          : ev.risk_level === 'medium'
            ? 52
            : 25;

    const detectionConfidence =
      ev.confidence === 'high' ? 0.88 : ev.confidence === 'medium' ? 0.68 : 0.45;

    const timeRangeLabel = `${ev.timestamp_start}–${ev.timestamp_end}${
      ev.is_approximate ? ' (approx.)' : ''
    }`;

    return {
      id: `ev_${cleanJobSuffix}_${idx + 1}`,
      videoId: ctx.videoId,
      projectId: ctx.projectId,
      locationId: ctx.locationId,
      ownerId: ctx.ownerId,
      timestampSec: ev.timestamp_start_sec,
      frameNumber: Math.max(0, Math.round(ev.timestamp_start_sec * fps)),
      occurredAt: ctx.occurredAtIso || nowIso,
      conflictType,
      originalConflictType: conflictType,
      severity,
      locationXy: null,
      detectionMethod: 'gemini_multimodal_video',
      riskScore,
      riskCategory,
      interactionTier:
        ev.risk_level === 'critical' || ev.risk_level === 'high'
          ? 'Near miss'
          : 'Potential conflict',
      detectionConfidence,
      measurementQuality: 'uncalibrated_pixel',
      estimatedTtcSec: null,
      estimatedPetSec: null,
      evasiveManeuverDetected: /(swerv|sudden brak|hard brak|abrupt|evasive)/i.test(
        `${ev.event} ${ev.activity}`
      ),
      estimatedMinSeparationPx: null,
      relativeSpeedPxPerSec: null,
      trajectoryConvergenceDeg: null,
      movementDirection: ev.activity.slice(0, 120) || 'Observed scene interaction',
      roadUsers,
      involvedTrackIds: [],
      contributingFactors: [
        `Activity: ${ev.activity.slice(0, 120)}`,
        `Time window: ${timeRangeLabel}`,
        `AI confidence: ${ev.confidence}`,
      ],
      measurementLimitations: [
        'Generated from multimodal video understanding (Gemini); calibrated physical distance, speed, TTC, and PET require camera homography and are reported as N/A.',
        ...(ev.is_approximate
          ? ['Event timestamps are approximate estimates aligned to the video duration.']
          : []),
      ],
      evidenceSummary: `Observed [${timeRangeLabel}]: ${ev.event} AI Assessment: ${ev.reason}`.slice(
        0,
        1000
      ),
      validationStatus: 'Pending review',
      isDemonstration: false,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
  });
}

/**
 * Converts low-level Gemini SDK / HTTP errors into safe, actionable user-facing messages
 * without exposing API keys, secrets, or internal stack traces.
 */
export function classifyGeminiApiError(err: unknown): {
  userMessage: string;
  statusCode: number;
  retryable: boolean;
} {
  const raw = err instanceof Error ? err.message : String(err ?? 'Unknown error');
  const lower = raw.toLowerCase();

  if (lower.includes('api_key_invalid') || lower.includes('api key not valid') || lower.includes('permission_denied') || lower.includes('403') || lower.includes('401')) {
    return {
      userMessage:
        'Gemini API authentication failed. Verify that GEMINI_API_KEY is valid and enabled on the server.',
      statusCode: 503,
      retryable: false,
    };
  }
  if (lower.includes('429') || lower.includes('resource_exhausted') || lower.includes('quota') || lower.includes('rate limit')) {
    return {
      userMessage:
        'Gemini API rate limit or quota was reached. Wait a moment and click Retry AI Analysis.',
      statusCode: 429,
      retryable: true,
    };
  }
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('aborted') || lower.includes('deadline')) {
    return {
      userMessage:
        'Gemini video analysis timed out while processing the footage. Your uploaded video is preserved — click Retry AI Analysis or try a shorter clip.',
      statusCode: 504,
      retryable: true,
    };
  }
  if (lower.includes('malformed json') || lower.includes('schema validation') || lower.includes('empty response')) {
    return {
      userMessage:
        'Gemini returned an incomplete or improperly structured analysis payload. Click Retry AI Analysis to re-run.',
      statusCode: 502,
      retryable: true,
    };
  }
  if (lower.includes('file processing failed') || lower.includes('state: failed') || lower.includes('unsupported mime')) {
    return {
      userMessage:
        'Gemini could not decode this video file. Ensure the file is a valid H.264 MP4, MOV, or WebM recording and retry.',
      statusCode: 422,
      retryable: false,
    };
  }
  if (lower.includes('fetch failed') || lower.includes('econnreset') || lower.includes('enotfound') || lower.includes('network')) {
    return {
      userMessage:
        'Network interruption occurred while communicating with the Gemini API. Click Retry AI Analysis to try again.',
      statusCode: 503,
      retryable: true,
    };
  }
  return {
    userMessage:
      'Video analysis could not be completed by Gemini right now. Your uploaded video remains safely stored and you can retry.',
    statusCode: 500,
    retryable: true,
  };
}
