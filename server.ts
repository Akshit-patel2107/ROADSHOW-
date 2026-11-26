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
import { GoogleGenAI, Type, FileState, createPartFromUri } from '@google/genai';
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

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD_MB = Math.max(10, Math.min(1024, Number(process.env.MAX_UPLOAD_MB || 250)));
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const GEMINI_VIDEO_MODEL = 'gemini-4-hydrogen';
const GEMINI_ANALYSIS_TIMEOUT_MS = Math.max(
  30000,
  Math.min(300000, Number(process.env.GEMINI_ANALYSIS_TIMEOUT_MS || 180000))
);
const GEMINI_INLINE_MAX_BYTES = 15 * 1024 * 1024;
const ANALYSIS_RATE_LIMIT_MAX = 12;
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
    // Lightweight server-side connectivity check (lists at most 1 temporary file metadata record)
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
      modelVersion: GEMINI_VIDEO_MODEL,
      tracker: 'Gemini Multimodal Video Understanding',
      device: 'Google Gemini API (Server-Side)',
      sampleFps: null,
      classes: ['person', 'car', 'motorcycle', 'bicycle', 'bus', 'truck', 'scooter', 'auto_rickshaw'],
      asyncJobsSupported: true,
      supportedFormats,
      latencyMs,
      message: `Gemini multimodal video analysis (${GEMINI_VIDEO_MODEL}) is configured and ready on the backend.`,
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
      modelVersion: GEMINI_VIDEO_MODEL,
      tracker: 'Gemini Multimodal Video Understanding',
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

// --- Asynchronous Processing Job Store & File Ownership Metadata ---
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
  status:
    | 'Queued'
    | 'Analyzing'
    | 'Processing'
    | 'AI Analysis'
    | 'Saving Results'
    | 'Completed'
    | 'Failed'
    | 'Cancelled';
  progress: number;
  stageMessage?: string;
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

const JOBS_FILE = path.resolve(UPLOADS_DIR, 'jobs.json');
const FILE_OWNERS_FILE = path.resolve(UPLOADS_DIR, 'file_owners.json');
const jobStore = new Map<string, ServerJob>();
const fileOwnerMap = new Map<string, string>();

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
}

function persistJobsSnapshot() {
  try {
    const compact = Array.from(jobStore.values())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 60)
      .map(({ resultPayload: _omit, ...rest }) => rest);
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

function buildGeminiVideoPrompt(durationSec: number, width: number, height: number, fps: number): string {
  const maxTs = formatSecondsToTimestamp(durationSec);
  return [
    'You are the ROADSHADOW 2.0 Road Safety & Multimodal Video Intelligence Engine.',
    `Analyze the attached uploaded video (duration: ${durationSec.toFixed(1)}s, resolution: ${width}x${height}, ${fps} fps).`,
    '',
    'CRITICAL INTEGRITY & ACCURACY RULES:',
    '1. Analyze ONLY what is genuinely visible in this actual video. NEVER fabricate vehicles, pedestrians, incidents, or timestamps that are not visible.',
    '2. If the video shows an empty road, calm traffic with no conflicts, or a synthetic/test video pattern, report that honestly and return an empty events array or low-risk factual observations.',
    '3. Clearly distinguish observable visual facts from AI interpretation. Never accuse any person of a crime without clear visual evidence; describe unusual or concerning behavior objectively.',
    `4. Every timestamp MUST be formatted as HH:MM:SS and MUST lie strictly between 00:00:00 and ${maxTs}. Set is_approximate=true whenever timing is approximate.`,
    '5. Identify visible people, vehicles, objects, movement/activities, scene changes, interactions, near-misses or safety hazards, important moments, and overall assessment.',
    '6. Return strictly valid JSON matching the required response schema.',
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

function executeJobAsync(jobId: string) {
  const startedAt = Date.now();
  setTimeout(async () => {
    const current = jobStore.get(jobId);
    if (!current || current.status === 'Cancelled') return;

    current.status = 'Processing';
    current.progress = 15;
    current.stageMessage = 'Validating stored video and connecting to Gemini API...';
    current.errorMessage = undefined;
    current.warnings = [];
    current.updatedAt = new Date().toISOString();
    persistJobsSnapshot();

    let uploadedGeminiFileName: string | null = null;
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

      const ext = path.extname(localFile.fileName).toLowerCase();
      const mime =
        ext === '.webm' ? 'video/webm' : ext === '.mov' ? 'video/quicktime' : 'video/mp4';

      // Probe authoritative video metadata with ffprobe so timestamps are clamped accurately
      const probe = await probeAndThumbnailVideo(localFile.fullPath, localFile.fileName);
      if (!probe.valid) {
        throw new Error(probe.error || 'Stored video file could not be decoded.');
      }
      const effectiveDuration =
        probe.durationSec > 0 ? probe.durationSec : Math.max(0, current.durationSec || 0);
      const effectiveFps = probe.fps > 0 ? probe.fps : 25;
      current.durationSec = effectiveDuration;

      const checkBeforeUpload = jobStore.get(jobId);
      if (!checkBeforeUpload || checkBeforeUpload.status === 'Cancelled') return;

      // Upload video to Gemini Files API (preferred for all video sizes); inline fallback only for small clips
      let videoPart: unknown;
      checkBeforeUpload.status = 'Processing';
      checkBeforeUpload.progress = 25;
      checkBeforeUpload.stageMessage = 'Uploading video to Gemini Files API...';
      checkBeforeUpload.updatedAt = new Date().toISOString();
      persistJobsSnapshot();

      try {
        structuredLog('INFO', 'gemini_files_upload_start', {
          jobId,
          videoId: current.videoId,
          fileSizeBytes: stat.size,
          mimeType: mime,
          durationSec: effectiveDuration,
        });

        let remoteFile = await withTimeout(
          ai.files.upload({
            file: localFile.fullPath,
            config: {
              mimeType: mime,
              displayName: localFile.fileName,
            },
          }),
          Math.min(GEMINI_ANALYSIS_TIMEOUT_MS, 90000),
          'Gemini file upload'
        );

        uploadedGeminiFileName = remoteFile.name ?? null;

        // Poll Gemini Files API until file state becomes ACTIVE
        const pollDeadline = Date.now() + Math.min(GEMINI_ANALYSIS_TIMEOUT_MS, 120000);
        while (remoteFile.state === FileState.PROCESSING || remoteFile.state === 'PROCESSING') {
          const cancelledCheck = jobStore.get(jobId);
          if (!cancelledCheck || cancelledCheck.status === 'Cancelled') return;
          if (Date.now() >= pollDeadline) {
            throw new Error('Gemini file processing timed out before becoming active.');
          }
          cancelledCheck.progress = Math.min(48, Math.max(30, cancelledCheck.progress + 3));
          cancelledCheck.stageMessage = 'Waiting for Gemini to finish indexing video frames...';
          cancelledCheck.updatedAt = new Date().toISOString();
          persistJobsSnapshot();
          await new Promise((resolve) => setTimeout(resolve, 1500));
          if (!remoteFile.name) break;
          remoteFile = await ai.files.get({ name: remoteFile.name });
        }

        if (remoteFile.state === FileState.FAILED || remoteFile.state === 'FAILED') {
          throw new Error(
            `Gemini file processing failed (state: FAILED)${
              remoteFile.error?.message ? `: ${remoteFile.error.message}` : '.'
            }`
          );
        }

        if (!remoteFile.uri) {
          throw new Error('Gemini Files API did not return a usable file URI.');
        }

        videoPart = createPartFromUri(remoteFile.uri, remoteFile.mimeType || mime);
      } catch (uploadErr) {
        // Fallback to inlineData ONLY for small files (<= 15 MB) if Files API upload fails transiently
        const errMsg = uploadErr instanceof Error ? uploadErr.message : String(uploadErr);
        const isAuthOrQuota = /(401|403|429|api_key_invalid|quota|resource_exhausted|state: failed)/i.test(
          errMsg
        );
        if (stat.size <= GEMINI_INLINE_MAX_BYTES && !isAuthOrQuota) {
          structuredLog('WARN', 'gemini_files_upload_fallback_inline', {
            jobId,
            reason: errMsg.slice(0, 200),
          });
          const buf = await fs.promises.readFile(localFile.fullPath);
          videoPart = {
            inlineData: {
              mimeType: mime,
              data: buf.toString('base64'),
            },
          };
          current.warnings.push('Used direct inline video payload for Gemini analysis.');
        } else {
          throw uploadErr;
        }
      }

      const preAnalysisCheck = jobStore.get(jobId);
      if (!preAnalysisCheck || preAnalysisCheck.status === 'Cancelled') return;

      preAnalysisCheck.status = 'AI Analysis';
      preAnalysisCheck.progress = 58;
      preAnalysisCheck.stageMessage = `Running multimodal video analysis with ${GEMINI_VIDEO_MODEL}...`;
      preAnalysisCheck.updatedAt = new Date().toISOString();
      persistJobsSnapshot();

      const prompt = buildGeminiVideoPrompt(
        effectiveDuration,
        probe.width,
        probe.height,
        effectiveFps
      );

      const remainingMs = Math.max(
        30000,
        GEMINI_ANALYSIS_TIMEOUT_MS - (Date.now() - startedAt)
      );

      const response = await withTimeout(
        ai.models.generateContent({
          model: GEMINI_VIDEO_MODEL,
          contents: [videoPart as Parameters<typeof ai.models.generateContent>[0]['contents'], prompt] as Parameters<
            typeof ai.models.generateContent
          >[0]['contents'],
          config: {
            responseMimeType: 'application/json',
            responseSchema: GEMINI_VIDEO_RESPONSE_SCHEMA,
          },
        }),
        remainingMs,
        'Gemini AI video analysis'
      );

      const postAnalysisCheck = jobStore.get(jobId);
      if (!postAnalysisCheck || postAnalysisCheck.status === 'Cancelled') return;

      postAnalysisCheck.status = 'Saving Results';
      postAnalysisCheck.progress = 88;
      postAnalysisCheck.stageMessage = 'Validating structured AI output and clamping timestamps...';
      postAnalysisCheck.updatedAt = new Date().toISOString();
      persistJobsSnapshot();

      const geminiAnalysis = validateAndNormalizeGeminiAnalysis(response.text, {
        durationSec: effectiveDuration,
        modelVersion: GEMINI_VIDEO_MODEL,
      });

      const detectionsSummary = buildDetectionsSummaryFromGemini(geminiAnalysis);
      const conflictEvents = mapGeminiAnalysisToConflictEvents(geminiAnalysis, {
        videoId: postAnalysisCheck.videoId,
        projectId: postAnalysisCheck.projectId,
        locationId: postAnalysisCheck.locationId,
        ownerId: postAnalysisCheck.ownerId,
        fps: effectiveFps,
        occurredAtIso: postAnalysisCheck.occurredAtIso,
        jobId,
      });

      const videoMetadata = {
        fps: effectiveFps,
        width: probe.width,
        height: probe.height,
        resolution: `${probe.width}x${probe.height}`,
        duration: effectiveDuration,
      };

      postAnalysisCheck.status = 'Completed';
      postAnalysisCheck.progress = 100;
      postAnalysisCheck.stageMessage = 'Gemini AI video analysis completed and validated.';
      postAnalysisCheck.engineMode = 'GEMINI_AI';
      postAnalysisCheck.modelVersion = GEMINI_VIDEO_MODEL;
      postAnalysisCheck.analyzedFrames = Math.max(1, Math.round(effectiveDuration * effectiveFps));
      postAnalysisCheck.detectedObjectCount = detectionsSummary.total_detections;
      postAnalysisCheck.trackingCount = geminiAnalysis.events.length;
      postAnalysisCheck.conflictCount = conflictEvents.length;
      postAnalysisCheck.processingTimeMs = Date.now() - startedAt;
      postAnalysisCheck.resultPayload = {
        videoMetadata,
        geminiAnalysis,
        detectionsSummary,
        tracks: [],
        conflicts: [],
        detections: [],
        trajectories: [],
        events: conflictEvents,
      };
      postAnalysisCheck.updatedAt = new Date().toISOString();
      persistJobsSnapshot();

      structuredLog('INFO', 'processing_job_completed', {
        jobId,
        engineMode: postAnalysisCheck.engineMode,
        modelVersion: postAnalysisCheck.modelVersion,
        durationSec: effectiveDuration,
        detectedObjects: postAnalysisCheck.detectedObjectCount,
        timelineEvents: geminiAnalysis.events.length,
        safetyConflictEvents: conflictEvents.length,
        processingTimeMs: postAnalysisCheck.processingTimeMs,
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
    } finally {
      if (uploadedGeminiFileName && ai) {
        try {
          await ai.files.delete({ name: uploadedGeminiFileName });
          structuredLog('INFO', 'gemini_temp_file_deleted', {
            jobId,
            fileName: uploadedGeminiFileName,
          });
        } catch (cleanupErr) {
          structuredLog('WARN', 'gemini_temp_file_delete_failed', {
            jobId,
            fileName: uploadedGeminiFileName,
            error: cleanupErr instanceof Error ? cleanupErr.message.slice(0, 160) : 'cleanup_failed',
          });
        }
      }
    }
  }, 150);
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

  // --- Asynchronous Real CV Processing Jobs ---
  const createJobSchema = z.object({
    videoId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_\-]+$/),
    projectId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_\-]+$/),
    locationId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_\-]+$/),
    fileUrl: z.string().min(1).max(512),
    durationSec: z.number().min(0).max(86400).default(0),
    occurredAtIso: z.string().max(64).optional(),
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
        status: 'Queued',
        progress: 5,
        stageMessage: 'Queued for Gemini AI video analysis...',
        engineMode: 'GEMINI_AI',
        modelVersion: geminiConfigured ? GEMINI_VIDEO_MODEL : 'Gemini API Not Configured',
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
      .map(({ resultPayload: _omit, ...summary }) => summary);
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
    res.json({ job });
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
      res.json({ job });
    }
  );

  // Retry a Failed, Cancelled, or Completed processing job without re-uploading the video
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
      job.status = 'Queued';
      job.progress = 5;
      job.stageMessage = 'Re-queued for Gemini AI video analysis...';
      job.engineMode = 'GEMINI_AI';
      job.modelVersion = getGeminiClient() ? GEMINI_VIDEO_MODEL : 'Gemini API Not Configured';
      job.errorMessage = undefined;
      job.warnings = [];
      job.resultPayload = undefined;
      job.updatedAt = new Date().toISOString();
      persistJobsSnapshot();
      executeJobAsync(job.id);
      res.status(202).json({ job });
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
