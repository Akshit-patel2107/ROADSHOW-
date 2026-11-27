import 'dotenv/config';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import { z } from 'zod';
import { createServer as createViteServer } from 'vite';
import {
  buildDetectionsSummaryFromGemini,
  classifyGeminiApiError,
  formatSecondsToTimestamp,
  mapGeminiAnalysisToConflictEvents,
  validateAndNormalizeGeminiAnalysis,
  type GeminiVideoAnalysis,
} from './src/engine/geminiVideoAnalysis';
import {
  deduplicateAdjacentFrames,
  mergeSegmentAnalyses,
  normalizeQualityMode,
  partitionSegmentsForRetry,
  planVideoSegments,
  QUALITY_MODE_CONFIGS,
  runWithBoundedConcurrency,
  selectDetailedTargetWindows,
  type SampledFramePayload,
  type SegmentAnalysisResult,
} from './src/engine/videoPipelinePlanner';
import type {
  AnalysisQualityMode,
  ProcessingTimings,
  SegmentProgressSummary,
} from './src/types/roadshadow';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD_MB = Math.max(10, Math.min(1024, Number(process.env.MAX_UPLOAD_MB || 250)));
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const GEMINI_FAST_SCAN_MODEL = 'gemini-3.1-flash-lite';
const GEMINI_DETAILED_MODEL = 'gemini-4-hydrogen';
const GEMINI_VIDEO_MODEL = `${GEMINI_FAST_SCAN_MODEL} (Fast Scan) + ${GEMINI_DETAILED_MODEL} (Detailed)`;
const GEMINI_SEGMENT_TIMEOUT_MS = Math.max(
  15000,
  Math.min(90000, Number(process.env.GEMINI_SEGMENT_TIMEOUT_MS || 45000))
);
const ANALYSIS_RATE_LIMIT_MAX = 15;
const ANALYSIS_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const UPLOADS_DIR = path.resolve(__dirname, 'uploads');
const THUMBNAILS_DIR = path.resolve(UPLOADS_DIR, 'thumbnails');
const BOOTSTRAPPED_ADMIN_EMAIL = 'akshitpatel2107@gmail.com';

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
if (!fs.existsSync(THUMBNAILS_DIR)) {
  fs.mkdirSync(THUMBNAILS_DIR, { recursive: true });
}

function loadFirebaseProjectId(): string {
  if (process.env.FIREBASE_PROJECT_ID) return process.env.FIREBASE_PROJECT_ID.trim();
  try {
    const cfgPath = path.resolve(__dirname, 'firebase-applet-config.json');
    if (fs.existsSync(cfgPath)) {
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as { projectId?: string };
      if (parsed.projectId) return parsed.projectId;
    }
  } catch {
    // Fallback below
  }
  return '';
}

const FIREBASE_PROJECT_ID = loadFirebaseProjectId();

function structuredLog(
  level: 'INFO' | 'WARN' | 'ERROR',
  event: string,
  meta: Record<string, unknown> = {}
) {
  const entry = {
    timestamp: new Date().toISOString(),
    service: 'roadshadow-api',
    level,
    event,
    ...meta,
  };
  if (level === 'ERROR') console.error(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

// --- Real Server-Side Firebase ID Token Verification (RS256 via Google Public x509 Certs) ---
type Role = 'ADMINISTRATOR' | 'ANALYST' | 'VIEWER';

interface AuthContext {
  authenticated: boolean;
  isDemoSession: boolean;
  uid: string;
  email: string | null;
  emailVerified: boolean;
  role: Role;
  isAdmin: boolean;
}

declare global {
  namespace Express {
    interface Request {
      authContext?: AuthContext;
    }
  }
}

let cachedCerts: Record<string, string> | null = null;
let certCacheExpiresAt = 0;

async function getFirebasePublicCerts(): Promise<Record<string, string>> {
  const now = Date.now();
  if (cachedCerts && now < certCacheExpiresAt) {
    return cachedCerts;
  }
  const resp = await fetch(
    'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com',
    { signal: AbortSignal.timeout(5000) }
  );
  if (!resp.ok) {
    throw new Error(`Unable to fetch Google Auth public keys (HTTP ${resp.status}).`);
  }
  const cacheControl = resp.headers.get('cache-control') || '';
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/i);
  const ttlMs = maxAgeMatch ? Math.min(3600000, Number(maxAgeMatch[1]) * 1000) : 300000;
  cachedCerts = (await resp.json()) as Record<string, string>;
  certCacheExpiresAt = now + ttlMs;
  return cachedCerts;
}

function decodeBase64UrlJson<T>(segment: string): T {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  const raw = Buffer.from(padded + '='.repeat(padLen), 'base64').toString('utf8');
  return JSON.parse(raw) as T;
}

async function verifyFirebaseIdToken(token: string): Promise<{
  uid: string;
  email: string | null;
  emailVerified: boolean;
} | null> {
  if (!FIREBASE_PROJECT_ID) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, sigB64] = parts;
  let header: { alg?: string; kid?: string };
  let payload: {
    aud?: string;
    iss?: string;
    sub?: string;
    exp?: number;
    iat?: number;
    email?: string;
    email_verified?: boolean;
  };
  try {
    header = decodeBase64UrlJson(headerB64);
    payload = decodeBase64UrlJson(payloadB64);
  } catch {
    return null;
  }

  if (header.alg !== 'RS256' || !header.kid) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp <= nowSec) return null;
  if (!payload.iat || payload.iat > nowSec + 300) return null;
  if (payload.aud !== FIREBASE_PROJECT_ID) return null;
  if (payload.iss !== `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`) return null;
  if (!payload.sub || typeof payload.sub !== 'string' || payload.sub.length > 128) return null;

  const certs = await getFirebasePublicCerts();
  const certPem = certs[header.kid];
  if (!certPem) return null;

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();
  const signature = Buffer.from(
    sigB64.replace(/-/g, '+').replace(/_/g, '/'),
    'base64'
  );
  const valid = verifier.verify(certPem, signature);
  if (!valid) return null;

  return {
    uid: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : null,
    emailVerified: payload.email_verified === true,
  };
}

async function resolveAuthContext(req: Request): Promise<AuthContext | null> {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) {
      try {
        const verified = await verifyFirebaseIdToken(token);
        if (verified) {
          const isAdmin =
            verified.emailVerified &&
            verified.email?.toLowerCase() === BOOTSTRAPPED_ADMIN_EMAIL;
          return {
            authenticated: true,
            isDemoSession: false,
            uid: verified.uid,
            email: verified.email,
            emailVerified: verified.emailVerified,
            role: isAdmin ? 'ADMINISTRATOR' : 'ANALYST',
            isAdmin,
          };
        }
      } catch (err) {
        structuredLog('WARN', 'token_verification_error', {
          error: err instanceof Error ? err.message : 'verification_failed',
        });
      }
      return null;
    }
  }

  // Sandboxed Demo Mode session (explicitly opt-in, isolated under demo_workspace namespace)
  if (req.headers['x-roadshadow-demo-mode'] === 'true') {
    const rawDemoRole = String(req.headers['x-roadshadow-demo-role'] || 'ANALYST').toUpperCase();
    const demoRole: Role =
      rawDemoRole === 'ADMINISTRATOR' || rawDemoRole === 'ANALYST' || rawDemoRole === 'VIEWER'
        ? rawDemoRole
        : 'ANALYST';
    return {
      authenticated: true,
      isDemoSession: true,
      uid: 'demo_workspace',
      email: null,
      emailVerified: false,
      role: demoRole,
      isAdmin: false, // Demo sessions NEVER gain live admin privileges across real users
    };
  }

  return null;
}

function requireAuth(allowedRoles?: Role[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const ctx = await resolveAuthContext(req);
    if (!ctx) {
      structuredLog('WARN', 'auth_required_denied', { path: req.path, method: req.method });
      res.status(401).json({
        error: 'Authentication required. Sign in with your account or enter Demo Mode.',
      });
      return;
    }
    if (allowedRoles && !allowedRoles.includes(ctx.role)) {
      structuredLog('WARN', 'rbac_denied', {
        path: req.path,
        uid: ctx.uid,
        role: ctx.role,
        allowedRoles,
      });
      res.status(403).json({
        error: `Insufficient permissions for this action. Current role: ${ctx.role}.`,
      });
      return;
    }
    req.authContext = ctx;
    next();
  };
}

// --- Network Target Validation for External CV / SUMO / RTSP URLs ---
function isBlockedHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (
    lower === 'localhost' ||
    lower === '127.0.0.1' ||
    lower === '::1' ||
    lower === '0.0.0.0' ||
    lower === '169.254.169.254' ||
    lower.endsWith('.internal') ||
    lower.endsWith('.local')
  ) {
    return true;
  }
  const ipv4Parts = lower.split('.').map(Number);
  if (ipv4Parts.length === 4 && ipv4Parts.every((n) => !Number.isNaN(n))) {
    const [a, b] = ipv4Parts;
    if (a === 10 || a === 127 || (a === 169 && b === 254)) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  return false;
}

function resolveExternalServiceUrl(raw?: string): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  if (/^(MY_|YOUR_|REPLACE_|<)/i.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (isBlockedHost(parsed.hostname)) return null;
    return trimmed.replace(/\/$/, '');
  } catch {
    return null;
  }
}

// --- Real Video Probing & Thumbnail Generation via ffprobe / ffmpeg ---
interface ProbedVideoMeta {
  valid: boolean;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  posterUrl: string | null;
  error?: string;
}

async function probeAndThumbnailVideo(filePath: string, fileName: string): Promise<ProbedVideoMeta> {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height,r_frame_rate,duration',
        '-show_entries',
        'format=duration',
        '-of',
        'json',
        filePath,
      ],
      { timeout: 15000 }
    );
    const parsed = JSON.parse(stdout || '{}') as {
      streams?: Array<{
        width?: number;
        height?: number;
        r_frame_rate?: string;
        duration?: string;
      }>;
      format?: { duration?: string };
    };
    const stream = parsed.streams?.[0];
    if (!stream || !stream.width || !stream.height) {
      return {
        valid: false,
        durationSec: 0,
        width: 0,
        height: 0,
        fps: 0,
        posterUrl: null,
        error: 'Uploaded file does not contain a readable video stream.',
      };
    }

    let fps = 25;
    if (stream.r_frame_rate && stream.r_frame_rate.includes('/')) {
      const [num, den] = stream.r_frame_rate.split('/').map(Number);
      if (num > 0 && den > 0) {
        fps = Number(Math.min(240, Math.max(1, num / den)).toFixed(2));
      }
    }
    const rawDur = Number(parsed.format?.duration ?? stream.duration ?? 0);
    const durationSec = Number.isFinite(rawDur) && rawDur > 0 ? Number(rawDur.toFixed(2)) : 0;

    // Extract a real thumbnail JPEG using ffmpeg
    const baseName = path.parse(fileName).name;
    const thumbFileName = `${baseName}.jpg`;
    const thumbPath = path.resolve(THUMBNAILS_DIR, thumbFileName);
    const seekSec = durationSec > 1.2 ? '0.5' : '0';
    let posterUrl: string | null = null;
    try {
      await execFileAsync(
        'ffmpeg',
        [
          '-y',
          '-ss',
          seekSec,
          '-i',
          filePath,
          '-frames:v',
          '1',
          '-vf',
          'scale=640:-2',
          '-q:v',
          '4',
          thumbPath,
        ],
        { timeout: 15000 }
      );
      if (fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 0) {
        posterUrl = `/api/uploads/thumbnails/${encodeURIComponent(thumbFileName)}`;
      }
    } catch {
      // Non-fatal: video is still valid even if thumbnail extraction fails
      posterUrl = null;
    }

    return {
      valid: true,
      durationSec,
      width: Number(stream.width),
      height: Number(stream.height),
      fps,
      posterUrl,
    };
  } catch {
    return {
      valid: false,
      durationSec: 0,
      width: 0,
      height: 0,
      fps: 0,
      posterUrl: null,
      error: 'Uploaded file is corrupted, truncated, or uses an unreadable codec.',
    };
  }
}

// Generate a real, playable 4-second MP4 sample clip using ffmpeg (strictly for Demo Mode testing)
async function ensureDemoSampleClip(): Promise<string | null> {
  const samplePath = path.resolve(UPLOADS_DIR, 'demo_sample_junction.mp4');
  if (fs.existsSync(samplePath) && fs.statSync(samplePath).size > 4096) {
    return samplePath;
  }
  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=640x360:rate=25:duration=4',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        samplePath,
      ],
      { timeout: 20000 }
    );
    return fs.existsSync(samplePath) ? samplePath : null;
  } catch {
    return null;
  }
}

// --- Gemini AI Video Analysis Health Probe (cached 10 seconds) ---
interface AiVideoHealthSnapshot {
  status: 'available' | 'unavailable' | 'not_configured';
  mode: 'GEMINI_AI' | 'UNAVAILABLE';
  externalWorkerConfigured: boolean;
  workerReachable: boolean;
  rtspIngestionReady: boolean;
  modelVersion: string | null;
  tracker: string | null;
  device: string | null;
  sampleFps: number | null;
  classes: string[] | null;
  asyncJobsSupported: boolean;
  supportedFormats: string[];
  latencyMs: number | null;
  message: string;
  checkedAt: string;
}

let cachedAiHealth: AiVideoHealthSnapshot | null = null;
let aiHealthCacheTime = 0;

async function probeGeminiVideoHealth(forceRefresh = false): Promise<AiVideoHealthSnapshot> {
  const now = Date.now();
  if (!forceRefresh && cachedAiHealth && now - aiHealthCacheTime < 10000) {
    return cachedAiHealth;
  }

  const ai = getGeminiClient();
  const supportedFormats = ['video/mp4', 'video/quicktime', 'video/webm'];
  if (!ai) {
    cachedAiHealth = {
      status: 'not_configured',
      mode: 'UNAVAILABLE',
      externalWorkerConfigured: false,
      workerReachable: false,
      rtspIngestionReady: false,
      modelVersion: null,
      tracker: null,
      device: 'Cloud API',
      sampleFps: null,
      classes: null,
      asyncJobsSupported: true,
      supportedFormats,
      latencyMs: null,
      message:
        'GEMINI_API_KEY is not configured on the server. Videos can still be uploaded and stored, and AI analysis can be retried once GEMINI_API_KEY is set.',
      checkedAt: new Date().toISOString(),
    };
    aiHealthCacheTime = now;
    return cachedAiHealth;
  }

  if (!forceRefresh && cachedAiHealth && cachedAiHealth.status === 'available') {
    return cachedAiHealth;
  }

  const t0 = Date.now();
  try {
    // Lightweight server-side connectivity check
    if (forceRefresh) {
      await ai.files.list({ config: { pageSize: 1 } });
    }
    const latencyMs = forceRefresh ? Date.now() - t0 : null;
    cachedAiHealth = {
      status: 'available',
      mode: 'GEMINI_AI',
      externalWorkerConfigured: true,
      workerReachable: true,
      rtspIngestionReady: false,
      modelVersion: GEMINI_FAST_SCAN_MODEL,
      tracker: `Two-Stage AI (${GEMINI_FAST_SCAN_MODEL} Fast Scan + ${GEMINI_DETAILED_MODEL} Detailed)`,
      device: 'Google Gemini API (Server-Side)',
      sampleFps: null,
      classes: ['person', 'car', 'motorcycle', 'bicycle', 'bus', 'truck', 'scooter', 'auto_rickshaw'],
      asyncJobsSupported: true,
      supportedFormats,
      latencyMs,
      message: `Optimized two-stage Gemini video analysis (${GEMINI_FAST_SCAN_MODEL} Fast Scan + selective ${GEMINI_DETAILED_MODEL} Detailed) is ready on the backend.`,
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    const classified = classifyGeminiApiError(err);
    cachedAiHealth = {
      status: 'unavailable',
      mode: 'UNAVAILABLE',
      externalWorkerConfigured: true,
      workerReachable: false,
      rtspIngestionReady: false,
      modelVersion: GEMINI_FAST_SCAN_MODEL,
      tracker: `Two-Stage AI (${GEMINI_FAST_SCAN_MODEL} + ${GEMINI_DETAILED_MODEL})`,
      device: 'Google Gemini API (Server-Side)',
      sampleFps: null,
      classes: null,
      asyncJobsSupported: true,
      supportedFormats,
      latencyMs: Date.now() - t0,
      message: classified.userMessage,
      checkedAt: new Date().toISOString(),
    };
  }

  aiHealthCacheTime = now;
  return cachedAiHealth;
}

// --- Per-User Rate Limiting & Duplicate Job Guard ---
const ACTIVE_JOB_STATUSES = new Set([
  'Queued',
  'Preparing Video',
  'Fast Scan',
  'Detailed Analysis',
  'Analyzing',
  'Processing',
  'AI Analysis',
  'Saving Results',
]);
const analysisRateLimiter = new Map<string, number[]>();

function checkAnalysisRateLimit(uid: string): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const windowStart = now - ANALYSIS_RATE_LIMIT_WINDOW_MS;
  const timestamps = (analysisRateLimiter.get(uid) || []).filter((ts) => ts > windowStart);
  if (timestamps.length >= ANALYSIS_RATE_LIMIT_MAX) {
    const oldest = timestamps[0] || now;
    const retryAfterSec = Math.max(1, Math.ceil((oldest + ANALYSIS_RATE_LIMIT_WINDOW_MS - now) / 1000));
    analysisRateLimiter.set(uid, timestamps);
    return { allowed: false, retryAfterSec };
  }
  timestamps.push(now);
  analysisRateLimiter.set(uid, timestamps);
  return { allowed: true, retryAfterSec: 0 };
}

// --- Asynchronous Processing Job Store, Content Cache & File Ownership Metadata ---
interface ServerJob {
  id: string;
  videoId: string;
  projectId: string;
  locationId: string;
  ownerId: string;
  fileUrl: string;
  durationSec: number;
  occurredAtIso: string;
  analysisMode: 'REAL' | 'DEMO_SAMPLE';
  analysisQuality: AnalysisQualityMode;
  forceRefresh?: boolean;
  status:
    | 'Queued'
    | 'Preparing Video'
    | 'Fast Scan'
    | 'Detailed Analysis'
    | 'Analyzing'
    | 'Processing'
    | 'AI Analysis'
    | 'Saving Results'
    | 'Completed'
    | 'Failed'
    | 'Cancelled';
  progress: number;
  stageMessage?: string;
  segments?: SegmentProgressSummary[];
  segmentResultsCache?: Record<number, SegmentAnalysisResult>;
  timings?: ProcessingTimings;
  engineMode: 'GEMINI_AI' | 'CV_SERVICE' | 'DEVELOPMENT_FALLBACK' | 'DEMONSTRATION';
  modelVersion: string;
  analyzedFrames: number;
  processingTimeMs: number;
  detectedObjectCount: number;
  trackingCount: number;
  conflictCount: number;
  warnings: string[];
  errorMessage?: string;
  resultPayload?: {
    videoMetadata?: {
      fps: number;
      width: number;
      height: number;
      resolution: string;
      duration: number;
    };
    geminiAnalysis?: GeminiVideoAnalysis;
    detectionsSummary?: {
      total_detections: number;
      by_class: Record<string, number>;
    };
    tracks: unknown[];
    conflicts: unknown[];
    thresholds?: Record<string, unknown>;
    detections: unknown[];
    trajectories: unknown[];
    events: unknown[];
  };
  createdAt: string;
  updatedAt: string;
}

interface CachedVideoAnalysisEntry {
  cacheKey: string;
  qualityMode: AnalysisQualityMode;
  modelVersion: string;
  videoMetadata: {
    fps: number;
    width: number;
    height: number;
    resolution: string;
    duration: number;
  };
  geminiAnalysis: GeminiVideoAnalysis;
  framesAnalyzed: number;
  segmentsTotal: number;
  detailedMomentsRefined: number;
  cachedAt: string;
}

const JOBS_FILE = path.resolve(UPLOADS_DIR, 'jobs.json');
const FILE_OWNERS_FILE = path.resolve(UPLOADS_DIR, 'file_owners.json');
const ANALYSIS_CACHE_FILE = path.resolve(UPLOADS_DIR, 'analysis_cache.json');
const jobStore = new Map<string, ServerJob>();
const fileOwnerMap = new Map<string, string>();
const analysisCache = new Map<string, CachedVideoAnalysisEntry>();

// Server-side-only in-memory RTSP credential vault (keyed by ownerUid:cameraId, NEVER exposed to browser)
interface RtspServerConfig {
  cameraId: string;
  ownerId: string;
  protocol: 'rtsp' | 'rtsps';
  streamHost: string;
  streamPort: number;
  streamPath: string;
  hasCredentials: boolean;
  credentialsRef: string | null;
  lastVerifiedConnected: boolean;
  lastCheckedAt: string | null;
  updatedAt: string;
}
const rtspConfigStore = new Map<string, RtspServerConfig>();
const rtspSecretVault = new Map<string, { username: string; password: string }>();

function loadPersistedState() {
  try {
    if (fs.existsSync(JOBS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')) as ServerJob[];
      if (Array.isArray(parsed)) {
        for (const j of parsed.slice(-60)) {
          if (j && typeof j.id === 'string') {
            jobStore.set(j.id, j);
          }
        }
      }
    }
  } catch {
    // Ignore malformed job cache
  }
  try {
    if (fs.existsSync(FILE_OWNERS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(FILE_OWNERS_FILE, 'utf8')) as Record<string, string>;
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string') fileOwnerMap.set(k, v);
      }
    }
  } catch {
    // Ignore malformed file owner cache
  }
  try {
    if (fs.existsSync(ANALYSIS_CACHE_FILE)) {
      const parsed = JSON.parse(
        fs.readFileSync(ANALYSIS_CACHE_FILE, 'utf8')
      ) as CachedVideoAnalysisEntry[];
      if (Array.isArray(parsed)) {
        for (const entry of parsed.slice(-30)) {
          if (entry && typeof entry.cacheKey === 'string' && entry.geminiAnalysis) {
            analysisCache.set(entry.cacheKey, entry);
          }
        }
      }
    }
  } catch {
    // Ignore malformed analysis cache
  }
}

function persistJobsSnapshot() {
  try {
    const compact = Array.from(jobStore.values())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 60)
      .map(({ resultPayload: _omit, segmentResultsCache: _omitSegs, ...rest }) => rest);
    fs.writeFileSync(JOBS_FILE, JSON.stringify(compact, null, 2), 'utf8');
  } catch {
    // Non-fatal
  }
}

function persistFileOwners() {
  try {
    const obj: Record<string, string> = {};
    for (const [k, v] of fileOwnerMap.entries()) obj[k] = v;
    fs.writeFileSync(FILE_OWNERS_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch {
    // Non-fatal
  }
}

function persistAnalysisCache() {
  try {
    const recent = Array.from(analysisCache.values())
      .sort((a, b) => b.cachedAt.localeCompare(a.cachedAt))
      .slice(0, 30);
    fs.writeFileSync(ANALYSIS_CACHE_FILE, JSON.stringify(recent, null, 2), 'utf8');
  } catch {
    // Non-fatal
  }
}

async function computeFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

loadPersistedState();

function resolveUploadedFilePath(fileUrl: string): { fileName: string; fullPath: string } | null {
  const prefix = '/api/uploads/files/';
  if (!fileUrl.startsWith(prefix)) return null;
  const rawName = decodeURIComponent(fileUrl.slice(prefix.length));
  const safeName = path.basename(rawName);
  if (!/^rs_[a-zA-Z0-9_]+\.(mp4|mov|webm)$/.test(safeName)) return null;
  const resolved = path.resolve(UPLOADS_DIR, safeName);
  if (!resolved.startsWith(UPLOADS_DIR + path.sep)) return null;
  if (!fs.existsSync(resolved)) return null;
  return { fileName: safeName, fullPath: resolved };
}

function findActiveJobForVideo(videoId: string): ServerJob | null {
  for (const job of jobStore.values()) {
    if (job.videoId === videoId && ACTIVE_JOB_STATUSES.has(job.status)) {
      return job;
    }
  }
  return null;
}

const GEMINI_VIDEO_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    video_summary: {
      type: Type.STRING,
      description: 'Concise factual summary of what actually appears in the video.',
    },
    duration_seconds: {
      type: Type.NUMBER,
      description: 'Approximate or known duration of the video in seconds.',
    },
    events: {
      type: Type.ARRAY,
      description:
        'Chronological notable events, traffic interactions, movement changes, or safety incidents visibly observed in the video. Return an empty array if nothing notable occurs.',
      items: {
        type: Type.OBJECT,
        properties: {
          timestamp_start: {
            type: Type.STRING,
            description: 'Start timestamp in HH:MM:SS format within the video duration.',
          },
          timestamp_end: {
            type: Type.STRING,
            description: 'End timestamp in HH:MM:SS format within the video duration.',
          },
          is_approximate: {
            type: Type.BOOLEAN,
            description: 'True if the timestamp is an approximate estimate rather than frame-exact.',
          },
          event: {
            type: Type.STRING,
            description: 'Objective factual description of what happened in the footage.',
          },
          objects_detected: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Visible objects/road users involved (e.g. person, car, motorcycle, bus, truck, bicycle).',
          },
          activity: {
            type: Type.STRING,
            description: 'Observed motion or activity (e.g. crossing intersection, sudden braking, pedestrian waiting).',
          },
          confidence: {
            type: Type.STRING,
            description: 'Confidence level: low, medium, or high.',
          },
          risk_level: {
            type: Type.STRING,
            description: 'Safety risk level: low, medium, high, or critical.',
          },
          reason: {
            type: Type.STRING,
            description: 'Visual evidence supporting this classification, separated clearly from speculation.',
          },
        },
        required: [
          'timestamp_start',
          'timestamp_end',
          'is_approximate',
          'event',
          'objects_detected',
          'activity',
          'confidence',
          'risk_level',
          'reason',
        ],
      },
    },
    detected_objects: {
      type: Type.ARRAY,
      description: 'Distinct visible object or road-user categories actually seen in the footage.',
      items: {
        type: Type.OBJECT,
        properties: {
          label: { type: Type.STRING },
          count_estimate: { type: Type.NUMBER },
          notes: { type: Type.STRING },
        },
        required: ['label', 'count_estimate', 'notes'],
      },
    },
    important_moments: {
      type: Type.ARRAY,
      description: 'Key timestamped moments worth human review.',
      items: {
        type: Type.OBJECT,
        properties: {
          timestamp: { type: Type.STRING, description: 'Timestamp in HH:MM:SS format.' },
          is_approximate: { type: Type.BOOLEAN },
          description: { type: Type.STRING },
        },
        required: ['timestamp', 'is_approximate', 'description'],
      },
    },
    safety_observations: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Evidence-based road safety, visibility, or scene observations.',
    },
    overall_assessment: {
      type: Type.STRING,
      description: 'Balanced overall safety assessment distinguishing observed facts from AI interpretation.',
    },
  },
  required: [
    'video_summary',
    'duration_seconds',
    'events',
    'detected_objects',
    'important_moments',
    'safety_observations',
    'overall_assessment',
  ],
};

const GEMINI_DETAILED_MOMENT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    refined_event: {
      type: Type.STRING,
      description: 'Refined factual description of the sequence of events observed in these closer frames.',
    },
    refined_activity: {
      type: Type.STRING,
      description: 'Specific motion/interaction observed.',
    },
    refined_risk_level: {
      type: Type.STRING,
      description: 'Updated risk level: low, medium, high, or critical.',
    },
    refined_confidence: {
      type: Type.STRING,
      description: 'Confidence level: low, medium, or high.',
    },
    detailed_reason: {
      type: Type.STRING,
      description: 'Clear visual evidence explaining why this moment is flagged or benign.',
    },
    safety_note: {
      type: Type.STRING,
      description: 'Optional concise safety observation for road engineers (empty string if none).',
    },
  },
  required: [
    'refined_event',
    'refined_activity',
    'refined_risk_level',
    'refined_confidence',
    'detailed_reason',
    'safety_note',
  ],
};

function buildFastScanSegmentPrompt(opts: {
  segmentIndex: number;
  segmentsTotal: number;
  startSec: number;
  endSec: number;
  totalDurationSec: number;
  frameLabels: string[];
  qualityMode: AnalysisQualityMode;
}): string {
  const startTs = formatSecondsToTimestamp(opts.startSec);
  const endTs = formatSecondsToTimestamp(opts.endSec);
  const conciseHint =
    opts.qualityMode === 'fast'
      ? 'Keep descriptions ultra-concise (1 short sentence per field). Report major events only.'
      : 'Keep descriptions concise and factual (1-2 short sentences per field).';
  return [
    `ROADSHADOW Fast Scan — Segment ${opts.segmentIndex + 1}/${opts.segmentsTotal} (${startTs}–${endTs} of ${formatSecondsToTimestamp(opts.totalDurationSec)}).`,
    `Attached frames are ordered chronologically with exact original-video timestamps: ${opts.frameLabels.join(', ')}.`,
    'Rules:',
    '1. Report ONLY what is genuinely visible in the attached frames. Never fabricate vehicles, people, or incidents.',
    '2. If frames show calm traffic, an empty scene, or a synthetic/test pattern, say so honestly and return an empty events array or low-risk factual notes.',
    `3. Use exact original-video HH:MM:SS timestamps strictly inside ${startTs}–${endTs}. Set is_approximate=true when timing between sampled frames is approximate.`,
    '4. Separate observable visual facts from AI interpretation. Never accuse anyone of intent or crime without clear visual evidence.',
    `5. ${conciseHint}`,
    'Return valid JSON matching the schema.',
  ].join('\n');
}

function buildDetailedMomentPrompt(opts: {
  windowStartSec: number;
  windowEndSec: number;
  initialEvent: string;
  initialReason: string;
  frameLabels: string[];
}): string {
  return [
    `ROADSHADOW Detailed Analysis — Window ${formatSecondsToTimestamp(opts.windowStartSec)}–${formatSecondsToTimestamp(opts.windowEndSec)}.`,
    `Fast Scan flagged: "${opts.initialEvent}" (initial note: "${opts.initialReason}").`,
    `Closer frames attached at exact timestamps: ${opts.frameLabels.join(', ')}.`,
    'Verify the sequence of interactions across these closer frames. Confirm or downgrade risk honestly based strictly on visible evidence. Keep response concise and factual.',
  ].join('\n');
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function toThinkingLevel(level: 'MINIMAL' | 'LOW' | 'MEDIUM'): ThinkingLevel {
  if (level === 'MINIMAL') return ThinkingLevel.MINIMAL;
  if (level === 'MEDIUM') return ThinkingLevel.MEDIUM;
  return ThinkingLevel.LOW;
}

/**
 * Extracts downscaled JPEG keyframes directly from the stored local video via fast input seeking (-ss before -i).
 * Streams JPEG buffers in memory with zero temp files and deduplicates near-identical consecutive frames.
 */
async function extractSampledFrames(
  videoPath: string,
  timestampsSec: number[],
  widthPx: number,
  jpegQuality: number
): Promise<SampledFramePayload[]> {
  const rawFrames = await runWithBoundedConcurrency(timestampsSec, 4, async (ts) => {
    try {
      const { stdout } = await execFileAsync(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-ss',
          ts.toFixed(2),
          '-i',
          videoPath,
          '-frames:v',
          '1',
          '-vf',
          `scale='min(${widthPx},iw)':-2`,
          '-q:v',
          String(jpegQuality),
          '-f',
          'image2pipe',
          '-vcodec',
          'mjpeg',
          'pipe:1',
        ],
        {
          encoding: 'buffer',
          maxBuffer: 4 * 1024 * 1024,
          timeout: 12000,
        }
      );
      if (!stdout || stdout.length < 256) return null;
      return {
        timestampSec: ts,
        timestampLabel: formatSecondsToTimestamp(ts),
        base64Jpeg: stdout.toString('base64'),
        byteLength: stdout.length,
      } satisfies SampledFramePayload;
    } catch {
      return null;
    }
  });

  const valid = rawFrames
    .filter((f): f is SampledFramePayload => f !== null)
    .sort((a, b) => a.timestampSec - b.timestampSec);

  return deduplicateAdjacentFrames(valid);
}

/**
 * Executes a Gemini generateContent call with timeout and exponential backoff + jitter for transient errors.
 */
async function callGeminiWithBackoff<T>(
  label: string,
  timeoutMs: number,
  fn: () => Promise<T>,
  maxRetries = 2
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await withTimeout(fn(), timeoutMs, label);
    } catch (err) {
      lastErr = err;
      const classified = classifyGeminiApiError(err);
      const rawMsg = err instanceof Error ? err.message : String(err);
      const isAuthOrBadInput =
        !classified.retryable || /(api_key_invalid|permission_denied|401|403|not_found|404)/i.test(rawMsg);
      if (isAuthOrBadInput || attempt === maxRetries) {
        throw err;
      }
      const delayMs = 1100 * Math.pow(2, attempt) + Math.floor(Math.random() * 450);
      structuredLog('WARN', 'gemini_call_retry_backoff', {
        label,
        attempt: attempt + 1,
        delayMs,
        reason: rawMsg.slice(0, 180),
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

function buildFrameParts(frames: SampledFramePayload[], prompt: string) {
  const parts: Array<
    { text: string } | { inlineData: { mimeType: string; data: string } }
  > = [];
  for (const frame of frames) {
    parts.push({ text: `Frame at ${frame.timestampLabel} (${frame.timestampSec.toFixed(1)}s):` });
    parts.push({
      inlineData: {
        mimeType: 'image/jpeg',
        data: frame.base64Jpeg,
      },
    });
  }
  parts.push({ text: prompt });
  return { parts };
}

function executeJobAsync(jobId: string) {
  const startedAt = Date.now();
  setTimeout(async () => {
    const current = jobStore.get(jobId);
    if (!current || current.status === 'Cancelled') return;

    const qualityMode = normalizeQualityMode(current.analysisQuality);
    const cfg = QUALITY_MODE_CONFIGS[qualityMode];

    current.status = 'Preparing Video';
    current.progress = 8;
    current.stageMessage = `Preparing stored video (${cfg.label} mode)...`;
    current.errorMessage = undefined;
    current.warnings = [];
    current.updatedAt = new Date().toISOString();
    persistJobsSnapshot();

    const ai = getGeminiClient();

    try {
      if (!ai) {
        current.status = 'Failed';
        current.progress = 0;
        current.stageMessage = 'Gemini API key is missing.';
        current.processingTimeMs = Date.now() - startedAt;
        current.modelVersion = 'Gemini API Not Configured';
        current.errorMessage =
          'GEMINI_API_KEY is not configured on the server. Set GEMINI_API_KEY in server environment variables and click Retry AI Analysis.';
        current.warnings = ['No analysis results were created because GEMINI_API_KEY is missing.'];
        current.updatedAt = new Date().toISOString();
        persistJobsSnapshot();
        structuredLog('WARN', 'processing_job_gemini_unconfigured', {
          jobId,
          videoId: current.videoId,
        });
        return;
      }

      const localFile = resolveUploadedFilePath(current.fileUrl);
      if (!localFile) {
        throw new Error('Uploaded video file could not be located on server storage.');
      }

      const stat = await fs.promises.stat(localFile.fullPath);
      if (stat.size <= 0) {
        throw new Error('Uploaded video file is empty.');
      }
      if (stat.size > MAX_UPLOAD_BYTES) {
        throw new Error(`Uploaded video exceeds the ${MAX_UPLOAD_MB} MB processing limit.`);
      }

      const prepStart = Date.now();
      const [probe, fileHash] = await Promise.all([
        probeAndThumbnailVideo(localFile.fullPath, localFile.fileName),
        computeFileSha256(localFile.fullPath),
      ]);
      if (!probe.valid) {
        throw new Error(probe.error || 'Stored video file could not be decoded.');
      }
      const effectiveDuration =
        probe.durationSec > 0 ? probe.durationSec : Math.max(1, current.durationSec || 1);
      const effectiveFps = probe.fps > 0 ? probe.fps : 25;
      current.durationSec = effectiveDuration;

      const videoMetadata = {
        fps: effectiveFps,
        width: probe.width,
        height: probe.height,
        resolution: `${probe.width}x${probe.height}`,
        duration: effectiveDuration,
      };

      // Check reusable content-hash cache unless user explicitly forced a fresh re-run
      const cacheKey = `${fileHash}:${qualityMode}`;
      const cached = !current.forceRefresh ? analysisCache.get(cacheKey) : undefined;
      if (cached) {
        const mergeStart = Date.now();
        const cachedAnalysis: GeminiVideoAnalysis = {
          ...cached.geminiAnalysis,
          duration_seconds: effectiveDuration,
        };
        const detectionsSummary = buildDetectionsSummaryFromGemini(cachedAnalysis);
        const conflictEvents = mapGeminiAnalysisToConflictEvents(cachedAnalysis, {
          videoId: current.videoId,
          projectId: current.projectId,
          locationId: current.locationId,
          ownerId: current.ownerId,
          fps: effectiveFps,
          occurredAtIso: current.occurredAtIso,
          jobId,
        });
        const totalMs = Date.now() - startedAt;
        const mergeMs = Date.now() - mergeStart;

        current.status = 'Completed';
        current.progress = 100;
        current.stageMessage = `Completed instantly from verified cache (${cfg.label} mode).`;
        current.engineMode = 'GEMINI_AI';
        current.modelVersion = cached.modelVersion;
        current.analyzedFrames = cached.framesAnalyzed;
        current.detectedObjectCount = detectionsSummary.total_detections;
        current.trackingCount = cachedAnalysis.events.length;
        current.conflictCount = conflictEvents.length;
        current.processingTimeMs = totalMs;
        current.warnings = [
          'Reused validated Gemini analysis result for identical video content (click Re-run AI Analysis to force a fresh pass).',
        ];
        current.timings = {
          preparationMs: Date.now() - prepStart,
          fastScanMs: 0,
          detailedAnalysisMs: 0,
          mergeMs,
          totalMs,
          cacheHit: true,
          framesAnalyzed: cached.framesAnalyzed,
          segmentsTotal: cached.segmentsTotal,
          segmentsCompleted: cached.segmentsTotal,
          segmentsFailed: 0,
          detailedMomentsRefined: cached.detailedMomentsRefined,
        };
        current.resultPayload = {
          videoMetadata,
          geminiAnalysis: cachedAnalysis,
          detectionsSummary,
          tracks: [],
          conflicts: [],
          detections: [],
          trajectories: [],
          events: conflictEvents,
        };
        current.updatedAt = new Date().toISOString();
        persistJobsSnapshot();
        structuredLog('INFO', 'processing_job_cache_hit', {
          jobId,
          videoId: current.videoId,
          qualityMode,
          totalMs,
        });
        return;
      }

      // Plan smart video segments and check if completed segments from a previous failed attempt can be preserved
      const plannedSegments = planVideoSegments(effectiveDuration, qualityMode);
      const { reusedIndices, pendingIndices } = partitionSegmentsForRetry(
        current.segments,
        plannedSegments
      );
      const preservedCache = current.segmentResultsCache ?? {};
      const reusableSet = new Set(
        reusedIndices.filter((idx) => Boolean(preservedCache[idx]?.analysis))
      );

      const segmentSummaries: SegmentProgressSummary[] = plannedSegments.map((seg) => {
        if (reusableSet.has(seg.segmentIndex)) {
          const prev = current.segments?.[seg.segmentIndex];
          return {
            segmentIndex: seg.segmentIndex,
            startSec: seg.startSec,
            endSec: seg.endSec,
            status: 'completed',
            framesSent: prev?.framesSent ?? seg.sampleTimestampsSec.length,
            prepMs: prev?.prepMs ?? 0,
            modelMs: prev?.modelMs ?? 0,
          };
        }
        return {
          segmentIndex: seg.segmentIndex,
          startSec: seg.startSec,
          endSec: seg.endSec,
          status: 'pending',
        };
      });

      const segmentResultsMap: Record<number, SegmentAnalysisResult> = {};
      for (const idx of reusableSet) {
        segmentResultsMap[idx] = preservedCache[idx];
      }

      current.segments = segmentSummaries;
      current.segmentResultsCache = segmentResultsMap;
      current.status = 'Fast Scan';
      const initialDone = reusableSet.size;
      current.progress = Math.min(
        75,
        15 + Math.round((initialDone / Math.max(1, plannedSegments.length)) * 60)
      );
      current.stageMessage =
        reusableSet.size > 0
          ? `Resuming Fast Scan (${reusableSet.size}/${plannedSegments.length} segments preserved; retrying ${pendingIndices.length})...`
          : plannedSegments.length === 1
            ? `Fast Scan (${cfg.fastScanModel}): extracting keyframes & analysing clip...`
            : `Fast Scan (${cfg.fastScanModel}): processing ${plannedSegments.length} segments (max ${cfg.maxConcurrency} concurrent)...`;
      current.updatedAt = new Date().toISOString();
      persistJobsSnapshot();

      let totalPrepMs = Date.now() - prepStart;
      let totalFastScanMs = 0;
      let totalFramesAnalyzed = Array.from(reusableSet).reduce(
        (sum, idx) => sum + (segmentSummaries[idx].framesSent ?? 0),
        0
      );

      const pendingSegments = plannedSegments.filter((seg) => !reusableSet.has(seg.segmentIndex));
      const fastScanStartWall = Date.now();

      await runWithBoundedConcurrency(pendingSegments, cfg.maxConcurrency, async (seg) => {
        const liveJob = jobStore.get(jobId);
        if (!liveJob || liveJob.status === 'Cancelled') return;

        segmentSummaries[seg.segmentIndex] = {
          ...segmentSummaries[seg.segmentIndex],
          status: 'processing',
          errorMessage: undefined,
        };
        liveJob.stageMessage =
          plannedSegments.length === 1
            ? `Fast Scan: sampling & analysing frames (${formatSecondsToTimestamp(seg.startSec)}–${formatSecondsToTimestamp(seg.endSec)})...`
            : `Fast Scan: segment ${seg.segmentIndex + 1}/${plannedSegments.length} (${formatSecondsToTimestamp(seg.startSec)}–${formatSecondsToTimestamp(seg.endSec)})...`;
        liveJob.updatedAt = new Date().toISOString();
        persistJobsSnapshot();

        const segPrepT0 = Date.now();
        try {
          const frames = await extractSampledFrames(
            localFile.fullPath,
            seg.sampleTimestampsSec,
            cfg.frameWidthPx,
            cfg.jpegQuality
          );
          const segPrepMs = Date.now() - segPrepT0;
          totalPrepMs += segPrepMs;

          if (frames.length === 0) {
            throw new Error(
              `Could not extract readable video frames for segment ${seg.segmentIndex + 1} (${formatSecondsToTimestamp(seg.startSec)}–${formatSecondsToTimestamp(seg.endSec)}).`
            );
          }

          const segPrompt = buildFastScanSegmentPrompt({
            segmentIndex: seg.segmentIndex,
            segmentsTotal: plannedSegments.length,
            startSec: seg.startSec,
            endSec: seg.endSec,
            totalDurationSec: effectiveDuration,
            frameLabels: frames.map((f) => f.timestampLabel),
            qualityMode,
          });

          const segModelT0 = Date.now();
          const response = await callGeminiWithBackoff(
            `Gemini Fast Scan segment ${seg.segmentIndex + 1}`,
            GEMINI_SEGMENT_TIMEOUT_MS,
            async () =>
              ai.models.generateContent({
                model: cfg.fastScanModel,
                contents: buildFrameParts(frames, segPrompt),
                config: {
                  responseMimeType: 'application/json',
                  responseSchema: GEMINI_VIDEO_RESPONSE_SCHEMA,
                  thinkingConfig: {
                    thinkingLevel: toThinkingLevel(cfg.fastScanThinkingLevel),
                  },
                },
              })
          );
          const segModelMs = Date.now() - segModelT0;

          const segAnalysis = validateAndNormalizeGeminiAnalysis(response.text, {
            durationSec: effectiveDuration,
            modelVersion: cfg.fastScanModel,
          });

          segmentResultsMap[seg.segmentIndex] = {
            segmentIndex: seg.segmentIndex,
            startSec: seg.startSec,
            endSec: seg.endSec,
            analysis: segAnalysis,
          };
          totalFramesAnalyzed += frames.length;
          segmentSummaries[seg.segmentIndex] = {
            segmentIndex: seg.segmentIndex,
            startSec: seg.startSec,
            endSec: seg.endSec,
            status: 'completed',
            framesSent: frames.length,
            prepMs: segPrepMs,
            modelMs: segModelMs,
          };

          structuredLog('INFO', 'gemini_segment_completed', {
            jobId,
            segmentIndex: seg.segmentIndex,
            range: `${seg.startSec}-${seg.endSec}s`,
            framesSent: frames.length,
            prepMs: segPrepMs,
            modelMs: segModelMs,
            eventsFound: segAnalysis.events.length,
          });

          // Progressive result merge so UI sees partial completed results immediately
          const postSegJob = jobStore.get(jobId);
          if (postSegJob && postSegJob.status !== 'Cancelled') {
            const doneCount = segmentSummaries.filter((s) => s.status === 'completed').length;
            postSegJob.progress = Math.min(
              75,
              15 + Math.round((doneCount / Math.max(1, plannedSegments.length)) * 60)
            );
            const partialMerged = mergeSegmentAnalyses(Object.values(segmentResultsMap), {
              totalDurationSec: effectiveDuration,
              modelVersion: cfg.fastScanModel,
            });
            postSegJob.resultPayload = {
              videoMetadata,
              geminiAnalysis: partialMerged,
              detectionsSummary: buildDetectionsSummaryFromGemini(partialMerged),
              tracks: [],
              conflicts: [],
              detections: [],
              trajectories: [],
              events: [],
            };
            postSegJob.analyzedFrames = totalFramesAnalyzed;
            postSegJob.updatedAt = new Date().toISOString();
            persistJobsSnapshot();
          }
        } catch (segErr) {
          const classified = classifyGeminiApiError(segErr);
          const rawReason = segErr instanceof Error ? segErr.message : String(segErr);
          segmentSummaries[seg.segmentIndex] = {
            ...segmentSummaries[seg.segmentIndex],
            status: 'failed',
            prepMs: Date.now() - segPrepT0,
            errorMessage: classified.userMessage,
          };
          structuredLog('ERROR', 'gemini_segment_failed', {
            jobId,
            segmentIndex: seg.segmentIndex,
            range: `${seg.startSec}-${seg.endSec}s`,
            error: rawReason.slice(0, 300),
          });
        }
      });

      totalFastScanMs = Date.now() - fastScanStartWall;

      const afterFastScan = jobStore.get(jobId);
      if (!afterFastScan || afterFastScan.status === 'Cancelled') return;

      const completedSegs = segmentSummaries.filter((s) => s.status === 'completed');
      const failedSegs = segmentSummaries.filter((s) => s.status === 'failed');

      // Never mark Completed if any segment failed — preserve completed segments for targeted retry!
      if (failedSegs.length > 0) {
        const firstErr = failedSegs[0].errorMessage || 'Segment analysis failed.';
        const partialAvailable = completedSegs.length > 0;
        const partialMerged = partialAvailable
          ? mergeSegmentAnalyses(Object.values(segmentResultsMap), {
              totalDurationSec: effectiveDuration,
              modelVersion: cfg.fastScanModel,
              partialWarning: `Partial results shown: ${completedSegs.length}/${plannedSegments.length} segments completed. Click Retry AI Analysis to retry only the ${failedSegs.length} failed segment(s).`,
            })
          : undefined;

        afterFastScan.status = 'Failed';
        afterFastScan.progress = Math.round(
          (completedSegs.length / Math.max(1, plannedSegments.length)) * 100
        );
        afterFastScan.stageMessage = partialAvailable
          ? `${completedSegs.length}/${plannedSegments.length} segments saved; ${failedSegs.length} failed.`
          : 'AI video analysis failed.';
        afterFastScan.errorMessage = partialAvailable
          ? `${completedSegs.length} of ${plannedSegments.length} segments completed and were preserved. ${failedSegs.length} segment(s) failed: ${firstErr} Click Retry AI Analysis to retry only the failed segment(s).`
          : firstErr;
        afterFastScan.processingTimeMs = Date.now() - startedAt;
        afterFastScan.analyzedFrames = totalFramesAnalyzed;
        afterFastScan.timings = {
          preparationMs: totalPrepMs,
          fastScanMs: totalFastScanMs,
          detailedAnalysisMs: 0,
          mergeMs: 0,
          totalMs: Date.now() - startedAt,
          cacheHit: false,
          framesAnalyzed: totalFramesAnalyzed,
          segmentsTotal: plannedSegments.length,
          segmentsCompleted: completedSegs.length,
          segmentsFailed: failedSegs.length,
          detailedMomentsRefined: 0,
        };
        if (partialMerged) {
          afterFastScan.resultPayload = {
            videoMetadata,
            geminiAnalysis: partialMerged,
            detectionsSummary: buildDetectionsSummaryFromGemini(partialMerged),
            tracks: [],
            conflicts: [],
            detections: [],
            trajectories: [],
            events: [],
          };
        }
        afterFastScan.updatedAt = new Date().toISOString();
        persistJobsSnapshot();
        return;
      }

      // Merge all completed Fast Scan segments
      const mergeStart = Date.now();
      const mergedAnalysis = mergeSegmentAnalyses(Object.values(segmentResultsMap), {
        totalDurationSec: effectiveDuration,
        modelVersion: cfg.fastScanModel,
      });

      // Stage B — Selective Detailed Analysis ONLY on flagged high-priority moments
      let detailedAnalysisMs = 0;
      let detailedMomentsRefined = 0;
      const detailedTargets = selectDetailedTargetWindows(
        mergedAnalysis,
        qualityMode,
        effectiveDuration
      );

      if (detailedTargets.length > 0) {
        afterFastScan.status = 'Detailed Analysis';
        afterFastScan.progress = 80;
        afterFastScan.stageMessage = `Detailed Analysis (${cfg.detailedModel}): inspecting ${detailedTargets.length} flagged moment(s)...`;
        afterFastScan.updatedAt = new Date().toISOString();
        persistJobsSnapshot();

        const detailStart = Date.now();
        await runWithBoundedConcurrency(detailedTargets, 2, async (target, idx) => {
          const liveJob = jobStore.get(jobId);
          if (!liveJob || liveJob.status === 'Cancelled') return;
          try {
            const winSpan = Math.max(0.5, target.windowEndSec - target.windowStartSec);
            const count = cfg.detailedFramesPerMoment;
            const sampleTs: number[] = [];
            for (let i = 0; i < count; i++) {
              const frac = count === 1 ? 0.5 : i / (count - 1);
              sampleTs.push(
                Number(
                  Math.min(effectiveDuration, target.windowStartSec + winSpan * frac).toFixed(2)
                )
              );
            }
            const closerFrames = await extractSampledFrames(
              localFile.fullPath,
              sampleTs,
              cfg.detailedFrameWidthPx,
              Math.max(4, cfg.jpegQuality - 1)
            );
            if (closerFrames.length === 0) return;
            totalFramesAnalyzed += closerFrames.length;

            const ev = mergedAnalysis.events[target.eventIndex];
            if (!ev) return;

            const detailPrompt = buildDetailedMomentPrompt({
              windowStartSec: target.windowStartSec,
              windowEndSec: target.windowEndSec,
              initialEvent: ev.event,
              initialReason: ev.reason,
              frameLabels: closerFrames.map((f) => f.timestampLabel),
            });

            const detailRes = await callGeminiWithBackoff(
              `Gemini Detailed Analysis moment ${idx + 1}`,
              GEMINI_SEGMENT_TIMEOUT_MS,
              async () =>
                ai.models.generateContent({
                  model: cfg.detailedModel,
                  contents: buildFrameParts(closerFrames, detailPrompt),
                  config: {
                    responseMimeType: 'application/json',
                    responseSchema: GEMINI_DETAILED_MOMENT_SCHEMA,
                    thinkingConfig: {
                      thinkingLevel: toThinkingLevel(cfg.detailedThinkingLevel),
                    },
                  },
                }),
              1
            );

            const parsedDetail = JSON.parse((detailRes.text || '{}').trim()) as {
              refined_event?: string;
              refined_activity?: string;
              refined_risk_level?: string;
              refined_confidence?: string;
              detailed_reason?: string;
              safety_note?: string;
            };

            if (parsedDetail.refined_event && parsedDetail.refined_event.trim().length > 2) {
              ev.event = parsedDetail.refined_event.trim().slice(0, 500);
            }
            if (parsedDetail.refined_activity && parsedDetail.refined_activity.trim().length > 2) {
              ev.activity = parsedDetail.refined_activity.trim().slice(0, 300);
            }
            if (
              parsedDetail.refined_risk_level === 'low' ||
              parsedDetail.refined_risk_level === 'medium' ||
              parsedDetail.refined_risk_level === 'high' ||
              parsedDetail.refined_risk_level === 'critical'
            ) {
              ev.risk_level = parsedDetail.refined_risk_level;
            }
            if (
              parsedDetail.refined_confidence === 'low' ||
              parsedDetail.refined_confidence === 'medium' ||
              parsedDetail.refined_confidence === 'high'
            ) {
              ev.confidence = parsedDetail.refined_confidence;
            }
            if (parsedDetail.detailed_reason && parsedDetail.detailed_reason.trim().length > 3) {
              ev.reason = parsedDetail.detailed_reason.trim().slice(0, 500);
            }
            if (parsedDetail.safety_note && parsedDetail.safety_note.trim().length > 3) {
              const note = parsedDetail.safety_note.trim().slice(0, 400);
              if (
                !mergedAnalysis.safety_observations.some(
                  (s) => s.toLowerCase() === note.toLowerCase()
                )
              ) {
                mergedAnalysis.safety_observations.push(note);
              }
            }
            detailedMomentsRefined++;
          } catch (detailErr) {
            // Preserve Fast Scan results if Stage B refinement fails transiently
            structuredLog('WARN', 'gemini_detailed_moment_skipped', {
              jobId,
              momentIndex: idx,
              error: detailErr instanceof Error ? detailErr.message.slice(0, 180) : 'detail_error',
            });
            afterFastScan.warnings.push(
              `Detailed pass skipped for moment at ${formatSecondsToTimestamp(target.centerSec)}; Fast Scan observation preserved.`
            );
          }
        });
        detailedAnalysisMs = Date.now() - detailStart;
      }

      const finalCheck = jobStore.get(jobId);
      if (!finalCheck || finalCheck.status === 'Cancelled') return;

      finalCheck.status = 'Saving Results';
      finalCheck.progress = 92;
      finalCheck.stageMessage = 'Validating merged timeline and saving structured results...';
      finalCheck.updatedAt = new Date().toISOString();
      persistJobsSnapshot();

      const effectiveModelLabel =
        detailedMomentsRefined > 0
          ? `${cfg.fastScanModel} + ${cfg.detailedModel}`
          : cfg.fastScanModel;
      mergedAnalysis.model_version = effectiveModelLabel;
      mergedAnalysis.analyzed_at = new Date().toISOString();

      const detectionsSummary = buildDetectionsSummaryFromGemini(mergedAnalysis);
      const conflictEvents = mapGeminiAnalysisToConflictEvents(mergedAnalysis, {
        videoId: finalCheck.videoId,
        projectId: finalCheck.projectId,
        locationId: finalCheck.locationId,
        ownerId: finalCheck.ownerId,
        fps: effectiveFps,
        occurredAtIso: finalCheck.occurredAtIso,
        jobId,
      });

      const mergeMs = Math.max(1, Date.now() - mergeStart - detailedAnalysisMs);
      const totalMs = Date.now() - startedAt;

      const timings: ProcessingTimings = {
        preparationMs: totalPrepMs,
        fastScanMs: totalFastScanMs,
        detailedAnalysisMs,
        mergeMs,
        totalMs,
        cacheHit: false,
        framesAnalyzed: totalFramesAnalyzed,
        segmentsTotal: plannedSegments.length,
        segmentsCompleted: completedSegs.length,
        segmentsFailed: 0,
        detailedMomentsRefined,
      };

      // Save to reusable content-hash cache
      analysisCache.set(cacheKey, {
        cacheKey,
        qualityMode,
        modelVersion: effectiveModelLabel,
        videoMetadata,
        geminiAnalysis: mergedAnalysis,
        framesAnalyzed: totalFramesAnalyzed,
        segmentsTotal: plannedSegments.length,
        detailedMomentsRefined,
        cachedAt: mergedAnalysis.analyzed_at,
      });
      persistAnalysisCache();

      finalCheck.status = 'Completed';
      finalCheck.progress = 100;
      finalCheck.stageMessage = `Completed (${cfg.label} mode · ${(totalMs / 1000).toFixed(1)}s · ${totalFramesAnalyzed} keyframes).`;
      finalCheck.engineMode = 'GEMINI_AI';
      finalCheck.modelVersion = effectiveModelLabel;
      finalCheck.analyzedFrames = totalFramesAnalyzed;
      finalCheck.detectedObjectCount = detectionsSummary.total_detections;
      finalCheck.trackingCount = mergedAnalysis.events.length;
      finalCheck.conflictCount = conflictEvents.length;
      finalCheck.processingTimeMs = totalMs;
      finalCheck.timings = timings;
      finalCheck.resultPayload = {
        videoMetadata,
        geminiAnalysis: mergedAnalysis,
        detectionsSummary,
        tracks: [],
        conflicts: [],
        detections: [],
        trajectories: [],
        events: conflictEvents,
      };
      finalCheck.updatedAt = new Date().toISOString();
      persistJobsSnapshot();

      structuredLog('INFO', 'processing_job_completed', {
        jobId,
        qualityMode,
        modelVersion: effectiveModelLabel,
        durationSec: effectiveDuration,
        timings,
        detectedObjects: finalCheck.detectedObjectCount,
        timelineEvents: mergedAnalysis.events.length,
        safetyConflictEvents: conflictEvents.length,
      });
    } catch (err) {
      const target = jobStore.get(jobId);
      if (!target || target.status === 'Cancelled') return;
      const classified = classifyGeminiApiError(err);
      target.status = 'Failed';
      target.progress = 0;
      target.stageMessage = 'AI video analysis failed.';
      target.processingTimeMs = Date.now() - startedAt;
      target.errorMessage = classified.userMessage;
      target.updatedAt = new Date().toISOString();
      persistJobsSnapshot();
      structuredLog('ERROR', 'processing_job_failed', {
        jobId,
        videoId: target.videoId,
        error: err instanceof Error ? err.message.slice(0, 300) : 'gemini_analysis_failed',
      });
    }
  }, 80);
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.use((req, _res, next) => {
    if (req.path.startsWith('/api/')) {
      structuredLog('INFO', 'api_request', { method: req.method, path: req.path });
    }
    next();
  });

  // --- Multer Video Upload Configuration ---
  const ALLOWED_MIMES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);
  const ALLOWED_EXTS = new Set(['.mp4', '.mov', '.webm']);

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const safeExt = ALLOWED_EXTS.has(ext) ? ext : '.mp4';
      const uniqueName = `rs_${Date.now()}_${crypto.randomBytes(8).toString('hex')}${safeExt}`;
      cb(null, uniqueName);
    },
  });

  const upload = multer({
    storage,
    limits: { fileSize: MAX_UPLOAD_BYTES },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (!ALLOWED_MIMES.has(file.mimetype) || !ALLOWED_EXTS.has(ext)) {
        cb(new Error('Unsupported video format. Permitted formats: MP4, MOV, WebM.'));
        return;
      }
      cb(null, true);
    },
  });

  // --- System & Gemini AI Video Engine Health Check ---
  app.get('/api/health', async (req, res) => {
    const force = req.query.refresh === '1';
    const aiHealth = await probeGeminiVideoHealth(force);
    const sumoConfigured = Boolean(resolveExternalServiceUrl(process.env.SUMO_SERVICE_URL));
    const geminiConfigured = Boolean(
      process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'
    );
    res.json({
      status: 'ok',
      service: 'ROADSHADOW 2.0 API',
      maxUploadMb: MAX_UPLOAD_MB,
      cvAdapter: aiHealth,
      aiVideoEngine: aiHealth,
      sumoAdapter: {
        configured: sumoConfigured,
      },
      geminiConfigured,
    });
  });

  // --- Playable ffmpeg-Generated Sample Clip for Demo Mode Testing ---
  app.get('/api/demo/sample-clip', async (_req, res) => {
    const samplePath = await ensureDemoSampleClip();
    if (!samplePath) {
      res.status(503).json({ error: 'Sample clip generator unavailable on server.' });
      return;
    }
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'inline; filename="roadshadow-demo-sample.mp4"');
    res.sendFile(samplePath);
  });

  // --- Video Upload Endpoint with Real ffprobe Validation & Thumbnail Generation ---
  app.post(
    '/api/uploads/video',
    requireAuth(['ADMINISTRATOR', 'ANALYST']),
    upload.single('video'),
    async (req, res) => {
      if (!req.file) {
        res.status(400).json({ error: 'No valid video file provided.' });
        return;
      }
      if (req.file.size === 0) {
        fs.unlink(req.file.path, () => {});
        res.status(400).json({ error: 'Uploaded video file is empty.' });
        return;
      }

      const probe = await probeAndThumbnailVideo(req.file.path, req.file.filename);
      if (!probe.valid) {
        fs.unlink(req.file.path, () => {});
        res.status(400).json({
          error: probe.error || 'Uploaded video file is corrupted or unreadable.',
        });
        return;
      }

      fileOwnerMap.set(req.file.filename, req.authContext!.uid);
      persistFileOwners();

      structuredLog('INFO', 'video_uploaded', {
        fileName: req.file.filename,
        ownerId: req.authContext!.uid,
        sizeBytes: req.file.size,
        durationSec: probe.durationSec,
        resolution: `${probe.width}x${probe.height}`,
      });

      res.status(201).json({
        fileName: req.file.filename,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        fileSizeBytes: req.file.size,
        fileUrl: `/api/uploads/files/${encodeURIComponent(req.file.filename)}`,
        posterUrl: probe.posterUrl,
        durationSec: probe.durationSec,
        width: probe.width,
        height: probe.height,
        fps: probe.fps,
      });
    }
  );

  // Serve uploaded videos safely with strict filename regex & directory confinement
  app.get('/api/uploads/files/:fileName', (req, res) => {
    const safeName = path.basename(req.params.fileName);
    if (!/^rs_[a-zA-Z0-9_]+\.(mp4|mov|webm)$/.test(safeName)) {
      res.status(400).json({ error: 'Invalid file identifier.' });
      return;
    }
    const resolved = path.resolve(UPLOADS_DIR, safeName);
    if (!resolved.startsWith(UPLOADS_DIR + path.sep)) {
      res.status(403).json({ error: 'Access denied.' });
      return;
    }
    if (!fs.existsSync(resolved)) {
      res.status(404).json({ error: 'Uploaded video file not found.' });
      return;
    }
    res.sendFile(resolved);
  });

  // Serve extracted JPEG thumbnails safely
  app.get('/api/uploads/thumbnails/:fileName', (req, res) => {
    const safeName = path.basename(req.params.fileName);
    if (!/^rs_[a-zA-Z0-9_]+\.jpg$/.test(safeName)) {
      res.status(400).json({ error: 'Invalid thumbnail identifier.' });
      return;
    }
    const resolved = path.resolve(THUMBNAILS_DIR, safeName);
    if (!resolved.startsWith(THUMBNAILS_DIR + path.sep)) {
      res.status(403).json({ error: 'Access denied.' });
      return;
    }
    if (!fs.existsSync(resolved)) {
      res.status(404).json({ error: 'Thumbnail not found.' });
      return;
    }
    res.sendFile(resolved);
  });

  // Delete an uploaded video file (authorized to owner or admin)
  app.delete(
    '/api/uploads/files/:fileName',
    requireAuth(['ADMINISTRATOR', 'ANALYST']),
    (req, res) => {
      const safeName = path.basename(req.params.fileName);
      if (!/^rs_[a-zA-Z0-9_]+\.(mp4|mov|webm)$/.test(safeName)) {
        res.status(400).json({ error: 'Invalid file identifier.' });
        return;
      }
      const owner = fileOwnerMap.get(safeName);
      const caller = req.authContext!;
      if (owner && owner !== caller.uid && !caller.isAdmin) {
        res.status(403).json({ error: 'You do not have permission to delete this video file.' });
        return;
      }
      const resolved = path.resolve(UPLOADS_DIR, safeName);
      if (resolved.startsWith(UPLOADS_DIR + path.sep) && fs.existsSync(resolved)) {
        fs.unlinkSync(resolved);
      }
      const thumbPath = path.resolve(THUMBNAILS_DIR, `${path.parse(safeName).name}.jpg`);
      if (thumbPath.startsWith(THUMBNAILS_DIR + path.sep) && fs.existsSync(thumbPath)) {
        fs.unlinkSync(thumbPath);
      }
      fileOwnerMap.delete(safeName);
      persistFileOwners();
      res.json({ deleted: true, fileName: safeName });
    }
  );

  // --- Asynchronous Optimized Gemini AI Processing Jobs ---
  const createJobSchema = z.object({
    videoId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_\-]+$/),
    projectId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_\-]+$/),
    locationId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_\-]+$/),
    fileUrl: z.string().min(1).max(512),
    durationSec: z.number().min(0).max(86400).default(0),
    occurredAtIso: z.string().max(64).optional(),
    analysisQuality: z.enum(['fast', 'balanced', 'detailed']).optional(),
    forceRefresh: z.boolean().optional(),
  });

  app.post(
    '/api/processing/jobs',
    requireAuth(['ADMINISTRATOR', 'ANALYST']),
    async (req, res) => {
      const parsed = createJobSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'Invalid processing job payload.',
          details: parsed.error.flatten(),
        });
        return;
      }

      const data = parsed.data;
      const localFile = resolveUploadedFilePath(data.fileUrl);
      if (!localFile) {
        res.status(400).json({
          error: 'Job must reference a valid uploaded video file stored on the server.',
        });
        return;
      }

      const caller = req.authContext!;
      const fileOwner = fileOwnerMap.get(localFile.fileName);
      if (fileOwner && fileOwner !== caller.uid && !caller.isAdmin) {
        res.status(403).json({
          error: 'You do not have permission to process another user’s uploaded video.',
        });
        return;
      }

      // Prevent duplicate concurrent analysis jobs for the same video
      const existingActive = findActiveJobForVideo(data.videoId);
      if (existingActive) {
        res.status(409).json({
          error: 'An AI analysis job is already running for this video.',
          activeJobId: existingActive.id,
          job: existingActive,
        });
        return;
      }

      // Per-user rate limit protecting Gemini API quota
      const rl = checkAnalysisRateLimit(caller.uid);
      if (!rl.allowed) {
        res.setHeader('Retry-After', String(rl.retryAfterSec));
        res.status(429).json({
          error: `Too many video analysis requests. Please wait ${rl.retryAfterSec}s before starting another job.`,
        });
        return;
      }

      const jobId = `job_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const nowIso = new Date().toISOString();
      const geminiConfigured = Boolean(getGeminiClient());
      const analysisQuality = normalizeQualityMode(data.analysisQuality);

      const job: ServerJob = {
        id: jobId,
        videoId: data.videoId,
        projectId: data.projectId,
        locationId: data.locationId,
        ownerId: caller.uid,
        fileUrl: data.fileUrl,
        durationSec: data.durationSec,
        occurredAtIso: data.occurredAtIso || nowIso,
        analysisMode: 'REAL',
        analysisQuality,
        forceRefresh: Boolean(data.forceRefresh),
        status: 'Queued',
        progress: 5,
        stageMessage: `Queued for ${QUALITY_MODE_CONFIGS[analysisQuality].label} Gemini AI analysis...`,
        engineMode: 'GEMINI_AI',
        modelVersion: geminiConfigured ? GEMINI_FAST_SCAN_MODEL : 'Gemini API Not Configured',
        analyzedFrames: 0,
        processingTimeMs: 0,
        detectedObjectCount: 0,
        trackingCount: 0,
        conflictCount: 0,
        warnings: [],
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      jobStore.set(jobId, job);
      persistJobsSnapshot();
      executeJobAsync(jobId);

      res.status(202).json({ job });
    }
  );

  // List processing jobs scoped strictly to caller ownership (admins see all)
  app.get('/api/processing/jobs', requireAuth(), (req, res) => {
    const caller = req.authContext!;
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : null;
    const jobs = Array.from(jobStore.values())
      .filter((j) => (caller.isAdmin ? true : j.ownerId === caller.uid))
      .filter((j) => (!projectId || projectId === 'ALL' ? true : j.projectId === projectId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 40)
      .map(({ resultPayload: _omit, segmentResultsCache: _omitSegs, ...summary }) => summary);
    res.json({ jobs });
  });

  app.get('/api/processing/jobs/:jobId', requireAuth(), (req, res) => {
    const job = jobStore.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Processing job not found.' });
      return;
    }
    const caller = req.authContext!;
    if (!caller.isAdmin && job.ownerId !== caller.uid) {
      res.status(403).json({ error: 'Access denied to this processing job.' });
      return;
    }
    const { segmentResultsCache: _omitSegs, ...publicJob } = job;
    res.json({ job: publicJob });
  });

  app.post(
    '/api/processing/jobs/:jobId/cancel',
    requireAuth(['ADMINISTRATOR', 'ANALYST']),
    (req, res) => {
      const job = jobStore.get(req.params.jobId);
      if (!job) {
        res.status(404).json({ error: 'Processing job not found.' });
        return;
      }
      const caller = req.authContext!;
      if (!caller.isAdmin && job.ownerId !== caller.uid) {
        res.status(403).json({ error: 'Access denied to cancel this processing job.' });
        return;
      }
      if (job.status === 'Completed' || job.status === 'Failed') {
        res.status(409).json({ error: `Cannot cancel a job already in ${job.status} state.` });
        return;
      }
      job.status = 'Cancelled';
      job.stageMessage = 'Analysis cancelled by user.';
      job.updatedAt = new Date().toISOString();
      persistJobsSnapshot();
      const { segmentResultsCache: _omitSegs, ...publicJob } = job;
      res.json({ job: publicJob });
    }
  );

  // Retry a Failed, Cancelled, or Completed processing job without re-uploading the video.
  // Automatically preserves any completed segments and retries only failed segments!
  app.post(
    '/api/processing/jobs/:jobId/retry',
    requireAuth(['ADMINISTRATOR', 'ANALYST']),
    (req, res) => {
      const job = jobStore.get(req.params.jobId);
      if (!job) {
        res.status(404).json({ error: 'Processing job not found.' });
        return;
      }
      const caller = req.authContext!;
      if (!caller.isAdmin && job.ownerId !== caller.uid) {
        res.status(403).json({ error: 'Access denied to retry this processing job.' });
        return;
      }
      if (ACTIVE_JOB_STATUSES.has(job.status)) {
        res.status(409).json({ error: 'Analysis job is already running.' });
        return;
      }
      const otherActive = findActiveJobForVideo(job.videoId);
      if (otherActive && otherActive.id !== job.id) {
        res.status(409).json({
          error: 'Another AI analysis job is already running for this video.',
          activeJobId: otherActive.id,
        });
        return;
      }
      if (!resolveUploadedFilePath(job.fileUrl)) {
        res.status(404).json({
          error: 'Original uploaded video file is no longer on server storage. Please upload the video again.',
        });
        return;
      }
      const rl = checkAnalysisRateLimit(caller.uid);
      if (!rl.allowed) {
        res.setHeader('Retry-After', String(rl.retryAfterSec));
        res.status(429).json({
          error: `Too many retry requests. Please wait ${rl.retryAfterSec}s before retrying.`,
        });
        return;
      }

      const requestedQuality =
        req.body && typeof req.body === 'object' && 'analysisQuality' in req.body
          ? normalizeQualityMode((req.body as { analysisQuality?: unknown }).analysisQuality)
          : job.analysisQuality || 'balanced';
      const isQualityChange = requestedQuality !== job.analysisQuality;
      const wasCompleted = job.status === 'Completed';
      const hasFailedSegments = Boolean(job.segments?.some((s) => s.status === 'failed'));

      // If user explicitly re-runs a Completed job or switches quality mode, clear segment cache & force fresh pass
      if (wasCompleted || isQualityChange) {
        job.segments = undefined;
        job.segmentResultsCache = undefined;
        job.resultPayload = undefined;
        job.forceRefresh = true;
      } else {
        // Keep completed segments intact so only failed segments are retried!
        job.forceRefresh = Boolean(
          req.body && typeof req.body === 'object' && (req.body as { forceRefresh?: boolean }).forceRefresh
        );
      }

      job.analysisQuality = requestedQuality;
      job.status = 'Queued';
      job.progress = 5;
      job.stageMessage = hasFailedSegments && !isQualityChange
        ? 'Re-queued to retry failed segments only...'
        : `Re-queued for ${QUALITY_MODE_CONFIGS[requestedQuality].label} Gemini AI analysis...`;
      job.engineMode = 'GEMINI_AI';
      job.modelVersion = getGeminiClient() ? GEMINI_FAST_SCAN_MODEL : 'Gemini API Not Configured';
      job.errorMessage = undefined;
      job.warnings = [];
      job.updatedAt = new Date().toISOString();
      persistJobsSnapshot();
      executeJobAsync(job.id);

      const { segmentResultsCache: _omitSegs, ...publicJob } = job;
      res.status(202).json({ job: publicJob });
    }
  );

  // --- Secure RTSP Adapter Configuration (Credentials isolated strictly server-side per owner) ---
  const rtspConfigSchema = z.object({
    cameraId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_\-]+$/),
    streamHost: z.string().min(3).max(200),
    streamPort: z.number().int().min(1).max(65535).default(554),
    streamPath: z.string().min(1).max(200).default('/stream1'),
    protocol: z.enum(['rtsp', 'rtsps']),
    username: z.string().max(120).optional(),
    password: z.string().max(200).optional(),
  });

  app.post(
    '/api/cameras/rtsp-config',
    requireAuth(['ADMINISTRATOR', 'ANALYST']),
    async (req, res) => {
      const parsed = rtspConfigSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid RTSP configuration payload.' });
        return;
      }
      const { cameraId, streamHost, streamPort, streamPath, protocol, username, password } =
        parsed.data;
      if (isBlockedHost(streamHost)) {
        res.status(400).json({
          error: 'Private, loopback, or cloud metadata hosts are blocked by network security policy.',
        });
        return;
      }

      const caller = req.authContext!;
      const storeKey = `${caller.uid}:${cameraId}`;
      const hasCredentials = Boolean(username && username.trim());
      const refId = hasCredentials ? `vault_${crypto.randomBytes(6).toString('hex')}` : null;
      if (hasCredentials && refId) {
        rtspSecretVault.set(refId, {
          username: username!.trim(),
          password: password || '',
        });
      }

      const cleanPath = streamPath.startsWith('/') ? streamPath : `/${streamPath}`;
      const liveConnected = false;

      const cfg: RtspServerConfig = {
        cameraId,
        ownerId: caller.uid,
        protocol,
        streamHost: streamHost.trim(),
        streamPort,
        streamPath: cleanPath,
        hasCredentials,
        credentialsRef: refId,
        lastVerifiedConnected: liveConnected,
        lastCheckedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      rtspConfigStore.set(storeKey, cfg);

      structuredLog('INFO', 'rtsp_config_saved', {
        cameraId,
        ownerId: caller.uid,
        protocol,
        streamHost: cfg.streamHost,
        hasCredentials,
        liveConnected,
      });

      res.json({
        cameraId,
        protocol: cfg.protocol,
        streamHost: cfg.streamHost,
        streamPort: cfg.streamPort,
        streamPath: cfg.streamPath,
        hasCredentials: cfg.hasCredentials,
        adapterReady: false,
        liveConnected: false,
        connectionStatus: 'Not connected',
        message:
          'RTSP parameters validated and stored server-side. Continuous live RTSP ingestion requires a dedicated stream relay; upload recorded clips on Upload Video to run Gemini AI video analysis.',
      });
    }
  );

  app.get('/api/cameras/rtsp-config/:cameraId', requireAuth(), async (req, res) => {
    const caller = req.authContext!;
    const cfg = rtspConfigStore.get(`${caller.uid}:${req.params.cameraId}`);
    if (!cfg) {
      res.json({
        configured: false,
        adapterReady: false,
        liveConnected: false,
        connectionStatus: 'Not connected',
      });
      return;
    }
    res.json({
      configured: true,
      cameraId: cfg.cameraId,
      protocol: cfg.protocol,
      streamHost: cfg.streamHost,
      streamPort: cfg.streamPort,
      streamPath: cfg.streamPath,
      hasCredentials: cfg.hasCredentials,
      adapterReady: false,
      liveConnected: false,
      connectionStatus: 'Not connected',
      updatedAt: cfg.updatedAt,
    });
  });

  // --- Optional External SUMO Micro-Simulation Worker Proxy ---
  const sumoRequestSchema = z.object({
    locationId: z.string().min(1).max(128),
    locationType: z.string().min(1).max(80),
    interventions: z.array(z.string()).max(12),
  });

  app.post('/api/simulation/sumo', requireAuth(), async (req, res) => {
    const parsed = sumoRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid junction simulation request.' });
      return;
    }
    const sumoUrl = resolveExternalServiceUrl(process.env.SUMO_SERVICE_URL);
    if (!sumoUrl) {
      res.status(501).json({
        configured: false,
        mode: 'ANALYTICAL_MODEL',
        message:
          'External SUMO micro-simulation service (SUMO_SERVICE_URL) is not configured. Using ROADSHADOW analytical junction modification model.',
      });
      return;
    }
    try {
      const upstream = await fetch(`${sumoUrl}/api/v1/simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed.data),
        signal: AbortSignal.timeout(30000),
      });
      if (!upstream.ok) {
        res.status(502).json({ error: `External SUMO worker returned HTTP ${upstream.status}.` });
        return;
      }
      const data = await upstream.json();
      res.json({ configured: true, mode: 'SUMO_WORKER', data });
    } catch {
      res.status(502).json({
        error: 'Unable to reach external SUMO worker.',
      });
    }
  });

  // --- Gemini AI Endpoints (Authenticated Server-Side Only via @google/genai) ---
  const explainEventSchema = z.object({
    conflictType: z.string().min(1).max(120),
    riskScore: z.number().min(0).max(100),
    riskCategory: z.string().min(1).max(32),
    detectionConfidence: z.number().min(0).max(1),
    estimatedTtcSec: z.number().nullable(),
    estimatedMinSeparationPx: z.number().nullable(),
    trajectoryConvergenceDeg: z.number().nullable(),
    roadUsers: z.array(z.string()).max(10),
    locationName: z.string().max(160),
    locationType: z.string().max(80),
    contributingFactors: z.array(z.string()).max(12),
    measurementLimitations: z.array(z.string()).max(12),
  });

  app.post('/api/ai/explain-event', requireAuth(), async (req, res) => {
    const parsed = explainEventSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid event payload for AI explanation.' });
      return;
    }
    const ai = getGeminiClient();
    if (!ai) {
      res.status(503).json({
        error: 'Gemini AI is not configured on the server. Set GEMINI_API_KEY in server secrets to enable AI explanations.',
      });
      return;
    }

    try {
      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: `Interpret this structured Indian urban road safety near-miss conflict event for traffic safety authorities:\n${JSON.stringify(parsed.data, null, 2)}`,
        config: {
          systemInstruction:
            'You are a senior road safety engineering analyst for ROADSHADOW in India. Explain the detected interaction clearly based ONLY on the supplied structured measurements. Never claim accident prediction certainty and never describe the 0-100 provisional risk score as an accident probability. Highlight measurement limitations transparently.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              plainLanguageSummary: { type: Type.STRING },
              safetySignificance: { type: Type.STRING },
              recommendedFieldChecks: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              caveatNote: { type: Type.STRING },
            },
            required: [
              'plainLanguageSummary',
              'safetySignificance',
              'recommendedFieldChecks',
              'caveatNote',
            ],
          },
        },
      });

      const rawText = (response.text ?? '').trim();
      const output = JSON.parse(rawText);
      res.json({ explanation: output });
    } catch (err) {
      structuredLog('ERROR', 'gemini_explain_event_error', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(502).json({ error: 'Failed to generate AI event explanation.' });
    }
  });

  const generateRecsSchema = z.object({
    projectName: z.string().min(1).max(160),
    locationName: z.string().min(1).max(160),
    locationType: z.string().min(1).max(80),
    fingerprints: z
      .array(
        z.object({
          patternLabel: z.string(),
          conflictType: z.string(),
          observedCount: z.number(),
          isPreliminary: z.boolean(),
          timeWindow: z.string(),
          roadUserCombo: z.string(),
          contributingFactors: z.array(z.string()),
        })
      )
      .min(1)
      .max(20),
  });

  app.post(
    '/api/ai/generate-recommendations',
    requireAuth(['ADMINISTRATOR', 'ANALYST']),
    async (req, res) => {
      const parsed = generateRecsSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid input for generating safety recommendations.' });
        return;
      }
      const ai = getGeminiClient();
      if (!ai) {
        res.status(503).json({
          error: 'Gemini AI is not configured on the server. Set GEMINI_API_KEY in server secrets.',
        });
        return;
      }

      try {
        const response = await ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: `Generate 2 to 3 practical, evidence-based Indian urban road safety interventions for the following recurring conflict patterns:\n${JSON.stringify(parsed.data, null, 2)}`,
          config: {
            systemInstruction:
              'You are an IRC-aware (Indian Roads Congress) urban road safety engineering advisor for ROADSHADOW. Produce actionable, low-to-medium cost engineering, signal timing, signage, or pedestrian infrastructure recommendations strictly tied to the observed conflict fingerprints. Explicitly note when underlying patterns are preliminary.',
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                recommendations: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      title: { type: Type.STRING },
                      category: { type: Type.STRING },
                      priority: { type: Type.STRING },
                      rationale: { type: Type.STRING },
                      evidenceSummary: { type: Type.STRING },
                      implementationSteps: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                      },
                    },
                    required: [
                      'title',
                      'category',
                      'priority',
                      'rationale',
                      'evidenceSummary',
                      'implementationSteps',
                    ],
                  },
                },
              },
              required: ['recommendations'],
            },
          },
        });

        const parsedOut = JSON.parse((response.text ?? '{}').trim());
        res.json(parsedOut);
      } catch (err) {
        structuredLog('ERROR', 'gemini_recommendations_error', {
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(502).json({ error: 'Failed to generate AI safety recommendations.' });
      }
    }
  );

  const summarizeReportSchema = z.object({
    projectName: z.string().min(1).max(160),
    reportType: z.string().min(1).max(100),
    dateRangeStart: z.string(),
    dateRangeEnd: z.string(),
    metrics: z.object({
      videosAnalyzed: z.number(),
      totalEvents: z.number(),
      criticalEvents: z.number(),
      highEvents: z.number(),
      verifiedEvents: z.number(),
      fingerprintsIdentified: z.number(),
    }),
    topLocations: z.array(
      z.object({
        name: z.string(),
        eventCount: z.number(),
        dominantConflict: z.string(),
      })
    ),
  });

  app.post(
    '/api/ai/summarize-report',
    requireAuth(['ADMINISTRATOR', 'ANALYST']),
    async (req, res) => {
      const parsed = summarizeReportSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid report payload.' });
        return;
      }
      const ai = getGeminiClient();
      if (!ai) {
        res.status(503).json({
          error: 'Gemini AI is not configured on the server. Set GEMINI_API_KEY in server secrets.',
        });
        return;
      }

      try {
        const response = await ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: `Write a concise executive summary for municipal and traffic police decision-makers based strictly on these ROADSHADOW records:\n${JSON.stringify(parsed.data, null, 2)}`,
          config: {
            systemInstruction:
              'Draft a clear, objective, non-sensationalist executive summary in 2-3 paragraphs. Never claim accidents are predicted with certainty. Clarify that risk scores are provisional triage indicators.',
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                executiveSummary: { type: Type.STRING },
                keyFindings: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                },
                priorityNextActions: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                },
              },
              required: ['executiveSummary', 'keyFindings', 'priorityNextActions'],
            },
          },
        });
        res.json(JSON.parse((response.text ?? '{}').trim()));
      } catch (err) {
        structuredLog('ERROR', 'gemini_report_summary_error', {
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(502).json({ error: 'Failed to summarize road safety report.' });
      }
    }
  );

  const nlQuerySchema = z.object({
    question: z.string().min(3).max(500),
    contextSummary: z.record(z.string(), z.unknown()),
  });

  app.post('/api/ai/query-analytics', requireAuth(), async (req, res) => {
    const parsed = nlQuerySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Please enter a valid analytics question (3-500 characters).' });
      return;
    }
    const ai = getGeminiClient();
    if (!ai) {
      res.status(503).json({
        error: 'Gemini AI is not configured on the server. Set GEMINI_API_KEY in server secrets.',
      });
      return;
    }

    try {
      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: `Question: ${parsed.data.question}\n\nStructured Project Analytics Snapshot:\n${JSON.stringify(parsed.data.contextSummary, null, 2)}`,
        config: {
          systemInstruction:
            'Answer the user question strictly using the provided ROADSHADOW analytics snapshot. Cite exact numbers from the snapshot. If the data does not contain enough observations to answer, say so honestly. Never treat provisional risk scores as accident probabilities.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              answer: { type: Type.STRING },
              supportingMetrics: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              dataLimitations: { type: Type.STRING },
            },
            required: ['answer', 'supportingMetrics', 'dataLimitations'],
          },
        },
      });
      res.json(JSON.parse((response.text ?? '{}').trim()));
    } catch (err) {
      structuredLog('ERROR', 'gemini_nl_query_error', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(502).json({ error: 'Failed to answer analytics query.' });
    }
  });

  // Centralized Express error handler (never leaks internal stack traces)
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({
          error: `Video exceeds maximum upload limit of ${MAX_UPLOAD_MB} MB.`,
        });
        return;
      }
      res.status(400).json({ error: `Upload error: ${err.message}` });
      return;
    }
    const msg = err instanceof Error ? err.message : 'Internal server error.';
    if (msg.startsWith('Unsupported video format')) {
      res.status(400).json({ error: msg });
      return;
    }
    structuredLog('ERROR', 'unhandled_express_error', { error: msg });
    res.status(500).json({ error: 'An unexpected server error occurred. Please try again.' });
  });

  // --- Serve Frontend via Vite (dev) or dist/ (prod) ---
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    structuredLog('INFO', 'server_started', {
      port: PORT,
      mode: isProd ? 'production' : 'development',
      maxUploadMb: MAX_UPLOAD_MB,
    });
  });
}

startServer().catch((err) => {
  structuredLog('ERROR', 'server_boot_failed', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
