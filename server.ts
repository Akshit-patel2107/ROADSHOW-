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
import { GoogleGenAI, Type } from '@google/genai';
import { z } from 'zod';
import { createServer as createViteServer } from 'vite';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD_MB = Math.max(10, Math.min(1024, Number(process.env.MAX_UPLOAD_MB || 250)));
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const CV_TIMEOUT_MS = Math.max(10000, Math.min(300000, Number(process.env.CV_SERVICE_TIMEOUT_MS || 120000)));
const CV_HEALTH_TIMEOUT_MS = Math.max(1500, Math.min(15000, Number(process.env.CV_HEALTH_TIMEOUT_MS || 5000)));
const CV_MAX_RETRIES = Math.max(0, Math.min(3, Number(process.env.CV_MAX_RETRIES ?? 2)));
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

// --- Active External CV Worker Health Probe (cached 5 seconds) ---
interface CvHealthSnapshot {
  status: 'available' | 'unavailable' | 'not_configured';
  mode: 'CV_SERVICE' | 'UNAVAILABLE';
  externalWorkerConfigured: boolean;
  workerReachable: boolean;
  rtspIngestionReady: boolean;
  modelVersion: string | null;
  tracker: string | null;
  device: string | null;
  sampleFps: number | null;
  latencyMs: number | null;
  message: string;
  checkedAt: string;
}

let cachedCvHealth: CvHealthSnapshot | null = null;
let cvHealthCacheTime = 0;

async function probeCvWorkerHealth(forceRefresh = false): Promise<CvHealthSnapshot> {
  const now = Date.now();
  if (!forceRefresh && cachedCvHealth && now - cvHealthCacheTime < 5000) {
    return cachedCvHealth;
  }

  const cvServiceUrl = resolveExternalServiceUrl(process.env.CV_SERVICE_URL);
  if (!cvServiceUrl) {
    cachedCvHealth = {
      status: 'not_configured',
      mode: 'UNAVAILABLE',
      externalWorkerConfigured: false,
      workerReachable: false,
      rtspIngestionReady: false,
      modelVersion: null,
      tracker: null,
      device: null,
      sampleFps: null,
      latencyMs: null,
      message:
        'External Python YOLO/ByteTrack CV service (CV_SERVICE_URL) is not configured. Videos can still be uploaded and stored, but automated Real Analysis requires connecting CV_SERVICE_URL.',
      checkedAt: new Date().toISOString(),
    };
    cvHealthCacheTime = now;
    return cachedCvHealth;
  }

  const t0 = Date.now();
  try {
    const resp = await fetch(`${cvServiceUrl}/health`, {
      headers: process.env.CV_SERVICE_API_KEY
        ? { Authorization: `Bearer ${process.env.CV_SERVICE_API_KEY}` }
        : undefined,
      signal: AbortSignal.timeout(CV_HEALTH_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - t0;
    if (!resp.ok) {
      cachedCvHealth = {
        status: 'unavailable',
        mode: 'UNAVAILABLE',
        externalWorkerConfigured: true,
        workerReachable: false,
        rtspIngestionReady: false,
        modelVersion: null,
        tracker: null,
        device: null,
        sampleFps: null,
        latencyMs,
        message: `Configured CV worker responded with HTTP ${resp.status}. Real Analysis is currently unavailable.`,
        checkedAt: new Date().toISOString(),
      };
    } else {
      const json = (await resp.json()) as {
        status?: string;
        model_ready?: boolean;
        model_version?: string;
        tracker?: string;
        device?: string;
        sample_fps?: number;
        error?: string | null;
      };
      const ready = json.status === 'ok' && json.model_ready !== false;
      cachedCvHealth = {
        status: ready ? 'available' : 'unavailable',
        mode: ready ? 'CV_SERVICE' : 'UNAVAILABLE',
        externalWorkerConfigured: true,
        workerReachable: true,
        rtspIngestionReady: ready,
        modelVersion: json.model_version || 'Ultralytics YOLO+ByteTrack',
        tracker: json.tracker || 'ByteTrack',
        device: json.device || null,
        sampleFps: typeof json.sample_fps === 'number' ? json.sample_fps : null,
        latencyMs,
        message: ready
          ? `Connected to external CV worker (${json.model_version || 'YOLO'} + ${json.tracker || 'ByteTrack'}). Ready for Real Analysis.`
          : `CV worker is reachable, but its YOLO detection model is not loaded${json.error ? ` (${String(json.error).slice(0, 140)})` : ''}.`,
        checkedAt: new Date().toISOString(),
      };
    }
  } catch {
    cachedCvHealth = {
      status: 'unavailable',
      mode: 'UNAVAILABLE',
      externalWorkerConfigured: true,
      workerReachable: false,
      rtspIngestionReady: false,
      modelVersion: null,
      tracker: null,
      device: null,
      sampleFps: null,
      latencyMs: Date.now() - t0,
      message:
        'Configured CV worker (CV_SERVICE_URL) is unreachable or timed out. Verify the Python FastAPI CV service is running.',
      checkedAt: new Date().toISOString(),
    };
  }

  cvHealthCacheTime = now;
  return cachedCvHealth;
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
  status: 'Queued' | 'Processing' | 'Completed' | 'Failed' | 'Cancelled';
  progress: number;
  engineMode: 'CV_SERVICE' | 'DEVELOPMENT_FALLBACK' | 'DEMONSTRATION';
  modelVersion: string;
  analyzedFrames: number;
  processingTimeMs: number;
  detectedObjectCount: number;
  trackingCount: number;
  conflictCount: number;
  warnings: string[];
  errorMessage?: string;
  resultPayload?: {
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

function executeJobAsync(jobId: string) {
  const startedAt = Date.now();
  setTimeout(async () => {
    const current = jobStore.get(jobId);
    if (!current || current.status === 'Cancelled') return;

    current.status = 'Processing';
    current.progress = 20;
    current.errorMessage = undefined;
    current.warnings = [];
    current.updatedAt = new Date().toISOString();
    persistJobsSnapshot();

    try {
      const localFile = resolveUploadedFilePath(current.fileUrl);
      if (!localFile) {
        throw new Error('Uploaded video file could not be located on server storage.');
      }

      const cvServiceUrl = resolveExternalServiceUrl(process.env.CV_SERVICE_URL);
      if (!cvServiceUrl) {
        // Honest Real Analysis behavior: NEVER silently fabricate detections or mark Completed!
        current.status = 'Failed';
        current.progress = 0;
        current.analyzedFrames = 0;
        current.detectedObjectCount = 0;
        current.trackingCount = 0;
        current.conflictCount = 0;
        current.processingTimeMs = Date.now() - startedAt;
        current.modelVersion = 'CV Service Not Configured';
        current.errorMessage =
          'Real video analysis requires the external Python YOLO/ByteTrack CV service (CV_SERVICE_URL), which is not configured. Your video remains safely stored in this project and can be retried once CV_SERVICE_URL is connected.';
        current.warnings = [
          'No detections or conflict events were generated because no CV inference service is connected.',
        ];
        current.updatedAt = new Date().toISOString();
        persistJobsSnapshot();
        structuredLog('WARN', 'processing_job_cv_unconfigured', { jobId, videoId: current.videoId });
        return;
      }

      current.progress = 40;
      current.updatedAt = new Date().toISOString();
      persistJobsSnapshot();

      // Forward the actual uploaded video file to the external Python CV worker via multipart upload
      // with bounded retries for transient network / 502 / 503 / 504 / 429 failures (e.g. Cloud Run cold starts).
      const fileBuffer = await fs.promises.readFile(localFile.fullPath);
      const ext = path.extname(localFile.fileName).toLowerCase();
      const mime =
        ext === '.webm' ? 'video/webm' : ext === '.mov' ? 'video/quicktime' : 'video/mp4';

      const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);
      const maxAttempts = 1 + CV_MAX_RETRIES;
      let workerResp: globalThis.Response | null = null;
      let lastError: Error | null = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const preCheck = jobStore.get(jobId);
        if (!preCheck || preCheck.status === 'Cancelled') return;

        const form = new FormData();
        form.append('video', new Blob([fileBuffer], { type: mime }), localFile.fileName);
        form.append('job_id', jobId);
        form.append('video_id', current.videoId);
        form.append('project_id', current.projectId);
        form.append('location_id', current.locationId);
        form.append('owner_id', current.ownerId);
        form.append('occurred_at_iso', current.occurredAtIso);

        structuredLog('INFO', 'cv_worker_request_attempt', {
          jobId,
          videoId: current.videoId,
          attempt,
          maxAttempts,
          fileSizeBytes: fileBuffer.length,
        });

        try {
          const resp = await fetch(`${cvServiceUrl}/api/v1/analyze-upload`, {
            method: 'POST',
            headers: process.env.CV_SERVICE_API_KEY
              ? { Authorization: `Bearer ${process.env.CV_SERVICE_API_KEY}` }
              : undefined,
            body: form,
            signal: AbortSignal.timeout(CV_TIMEOUT_MS),
          });

          if (resp.ok) {
            workerResp = resp;
            lastError = null;
            break;
          }

          let detail = `External CV worker returned HTTP ${resp.status}.`;
          try {
            const errBody = (await resp.json()) as { detail?: string; error?: string };
            if (errBody.detail || errBody.error) {
              detail = String(errBody.detail || errBody.error).slice(0, 350);
            }
          } catch {
            // Keep HTTP status message
          }

          lastError = new Error(detail);
          const isTransient = TRANSIENT_STATUSES.has(resp.status);
          structuredLog('WARN', 'cv_worker_http_error', {
            jobId,
            attempt,
            status: resp.status,
            transient: isTransient,
            detail,
          });
          if (!isTransient || attempt >= maxAttempts) {
            throw lastError;
          }
        } catch (fetchErr) {
          const errObj =
            fetchErr instanceof Error ? fetchErr : new Error('CV worker request failed.');
          // If this was already thrown above for a non-transient HTTP status, rethrow immediately
          if (fetchErr === lastError) {
            throw errObj;
          }
          lastError = errObj;
          structuredLog('WARN', 'cv_worker_network_error', {
            jobId,
            attempt,
            maxAttempts,
            error: errObj.message,
          });
          if (attempt >= maxAttempts) {
            throw errObj;
          }
        }

        const backoffMs = Math.min(6000, 2000 * attempt);
        const retryState = jobStore.get(jobId);
        if (retryState && retryState.status !== 'Cancelled') {
          retryState.progress = Math.min(60, 40 + attempt * 8);
          retryState.warnings = [
            `Transient CV worker error on attempt ${attempt}/${maxAttempts}; retrying in ${backoffMs / 1000}s...`,
          ];
          retryState.updatedAt = new Date().toISOString();
          persistJobsSnapshot();
        }
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }

      const refreshed = jobStore.get(jobId);
      if (!refreshed || refreshed.status === 'Cancelled') return;
      if (!workerResp) {
        throw lastError || new Error('External CV worker did not return a valid response.');
      }

      let rawJson: unknown;
      try {
        rawJson = await workerResp.json();
      } catch {
        throw new Error('External CV worker returned malformed non-JSON output.');
      }

      const workerJson = rawJson as {
        model_version?: string;
        analyzed_frames?: number;
        processing_time_ms?: number;
        detections?: unknown;
        trajectories?: unknown;
        events?: unknown;
        warnings?: unknown;
      };

      if (
        !workerJson ||
        typeof workerJson !== 'object' ||
        !Array.isArray(workerJson.detections) ||
        !Array.isArray(workerJson.trajectories) ||
        !Array.isArray(workerJson.events)
      ) {
        throw new Error(
          'External CV worker response is missing required detections, trajectories, or events arrays.'
        );
      }

      const detections = workerJson.detections;
      const trajectories = workerJson.trajectories;
      const events = workerJson.events;

      refreshed.status = 'Completed';
      refreshed.progress = 100;
      refreshed.engineMode = 'CV_SERVICE';
      refreshed.modelVersion = workerJson.model_version || 'Ultralytics YOLO+ByteTrack';
      refreshed.analyzedFrames = Number(workerJson.analyzed_frames || 0);
      refreshed.detectedObjectCount = detections.length;
      refreshed.trackingCount = trajectories.length;
      refreshed.conflictCount = events.length;
      refreshed.warnings = Array.isArray(workerJson.warnings)
        ? workerJson.warnings.map((w) => String(w))
        : [];
      refreshed.processingTimeMs =
        typeof workerJson.processing_time_ms === 'number' && workerJson.processing_time_ms > 0
          ? Math.round(workerJson.processing_time_ms)
          : Date.now() - startedAt;
      refreshed.resultPayload = {
        detections,
        trajectories,
        events,
      };
      refreshed.updatedAt = new Date().toISOString();
      persistJobsSnapshot();
      structuredLog('INFO', 'processing_job_completed', {
        jobId,
        engineMode: refreshed.engineMode,
        modelVersion: refreshed.modelVersion,
        analyzedFrames: refreshed.analyzedFrames,
        detections: refreshed.detectedObjectCount,
        tracks: refreshed.trackingCount,
        conflicts: refreshed.conflictCount,
        processingTimeMs: refreshed.processingTimeMs,
      });
    } catch (err) {
      const target = jobStore.get(jobId);
      if (!target || target.status === 'Cancelled') return;
      target.status = 'Failed';
      target.progress = 0;
      target.processingTimeMs = Date.now() - startedAt;
      const rawMsg = err instanceof Error ? err.message : 'CV processing worker failed.';
      target.errorMessage = rawMsg.includes('TimeoutError') || rawMsg.includes('aborted')
        ? `CV processing timed out after ${Math.round(CV_TIMEOUT_MS / 1000)}s. Your uploaded video is preserved and you can retry.`
        : rawMsg.slice(0, 500);
      target.updatedAt = new Date().toISOString();
      persistJobsSnapshot();
      structuredLog('ERROR', 'processing_job_failed', {
        jobId,
        error: target.errorMessage,
      });
    }
  }, 180);
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

  // --- System & Real Active CV Health Check ---
  app.get('/api/health', async (req, res) => {
    const force = req.query.refresh === '1';
    const cvHealth = await probeCvWorkerHealth(force);
    const sumoConfigured = Boolean(resolveExternalServiceUrl(process.env.SUMO_SERVICE_URL));
    const geminiConfigured = Boolean(
      process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'
    );
    res.json({
      status: 'ok',
      service: 'ROADSHADOW 2.0 API',
      maxUploadMb: MAX_UPLOAD_MB,
      cvAdapter: cvHealth,
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

      const jobId = `job_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const nowIso = new Date().toISOString();
      const cvServiceUrl = resolveExternalServiceUrl(process.env.CV_SERVICE_URL);

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
        engineMode: 'CV_SERVICE',
        modelVersion: cvServiceUrl
          ? 'External Python YOLO/ByteTrack Worker'
          : 'CV Service Not Configured',
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
      job.updatedAt = new Date().toISOString();
      persistJobsSnapshot();
      res.json({ job });
    }
  );

  // Retry a Failed or Cancelled processing job without re-uploading the video
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
      if (job.status === 'Queued' || job.status === 'Processing') {
        res.status(409).json({ error: 'Job is already running.' });
        return;
      }
      if (!resolveUploadedFilePath(job.fileUrl)) {
        res.status(404).json({
          error: 'Original uploaded video file is no longer on server storage. Please upload the video again.',
        });
        return;
      }
      job.status = 'Queued';
      job.progress = 5;
      job.errorMessage = undefined;
      job.warnings = [];
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
      const cvHealth = await probeCvWorkerHealth();
      let liveConnected = false;
      let probeDetail = '';

      // If the external CV worker is actually reachable, actively probe the RTSP stream
      const cvServiceUrl = resolveExternalServiceUrl(process.env.CV_SERVICE_URL);
      if (cvHealth.status === 'available' && cvServiceUrl) {
        try {
          const creds =
            hasCredentials && refId ? rtspSecretVault.get(refId) : undefined;
          const authPrefix = creds
            ? `${encodeURIComponent(creds.username)}:${encodeURIComponent(creds.password)}@`
            : '';
          const probeUrl = `${protocol}://${authPrefix}${streamHost.trim()}:${streamPort}${cleanPath}`;
          const probeResp = await fetch(`${cvServiceUrl}/api/v1/rtsp/probe`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(process.env.CV_SERVICE_API_KEY
                ? { Authorization: `Bearer ${process.env.CV_SERVICE_API_KEY}` }
                : {}),
            },
            body: JSON.stringify({ rtsp_url: probeUrl }),
            signal: AbortSignal.timeout(8000),
          });
          if (probeResp.ok) {
            const probeJson = (await probeResp.json()) as {
              connected?: boolean;
              error?: string;
            };
            liveConnected = probeJson.connected === true;
            if (!liveConnected && probeJson.error) {
              probeDetail = probeJson.error;
            }
          }
        } catch {
          liveConnected = false;
          probeDetail = 'RTSP probe timed out against external CV worker.';
        }
      }

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
        adapterReady: cvHealth.status === 'available',
        liveConnected,
        connectionStatus: liveConnected ? 'Connected' : 'Not connected',
        message: liveConnected
          ? 'RTSP stream verified via external CV worker. Credentials stay strictly server-side.'
          : cvHealth.status === 'available'
            ? `RTSP parameters saved, but live stream handshake failed (${probeDetail || 'stream unreachable'}).`
            : 'RTSP parameters validated and stored server-side, but live stream ingestion is Not connected because the external CV worker (CV_SERVICE_URL) is unavailable.',
      });
    }
  );

  app.get('/api/cameras/rtsp-config/:cameraId', requireAuth(), async (req, res) => {
    const caller = req.authContext!;
    const cfg = rtspConfigStore.get(`${caller.uid}:${req.params.cameraId}`);
    const cvHealth = await probeCvWorkerHealth();
    if (!cfg) {
      res.json({
        configured: false,
        adapterReady: cvHealth.status === 'available',
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
      adapterReady: cvHealth.status === 'available',
      liveConnected: cfg.lastVerifiedConnected && cvHealth.status === 'available',
      connectionStatus:
        cfg.lastVerifiedConnected && cvHealth.status === 'available'
          ? 'Connected'
          : 'Not connected',
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
