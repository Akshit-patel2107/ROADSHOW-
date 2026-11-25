import type { UserRole } from '../types/roadshadow';

export const ALLOWED_VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
] as const;

export const ALLOWED_VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm'] as const;

export function validateCoordinates(
  lat: number,
  lng: number
): { valid: boolean; error?: string } {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { valid: false, error: 'Latitude and longitude must be valid numbers.' };
  }
  if (lat < -90 || lat > 90) {
    return { valid: false, error: 'Latitude must be between -90 and 90 degrees.' };
  }
  if (lng < -180 || lng > 180) {
    return { valid: false, error: 'Longitude must be between -180 and 180 degrees.' };
  }
  if (lat === 0 && lng === 0) {
    return {
      valid: false,
      error: 'Coordinates (0, 0) are not a valid Indian or urban road location. Select a real point on the map.',
    };
  }
  return { valid: true };
}

export function validateVideoFileMeta(
  fileName: string,
  mimeType: string,
  sizeBytes: number,
  maxUploadMb: number
): { valid: boolean; error?: string } {
  const lower = fileName.toLowerCase();
  const hasValidExt = ALLOWED_VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
  if (!hasValidExt) {
    return {
      valid: false,
      error: `Unsupported file extension. Permitted formats: ${ALLOWED_VIDEO_EXTENSIONS.join(', ')}.`,
    };
  }
  const hasValidMime = (ALLOWED_VIDEO_MIME_TYPES as readonly string[]).includes(mimeType);
  if (!hasValidMime) {
    return {
      valid: false,
      error: `Unsupported MIME type (${mimeType || 'unknown'}). Upload MP4, MOV, or WebM footage.`,
    };
  }
  if (sizeBytes <= 0) {
    return { valid: false, error: 'Selected file appears empty or corrupted (0 bytes).' };
  }
  const maxBytes = maxUploadMb * 1024 * 1024;
  if (sizeBytes > maxBytes) {
    return {
      valid: false,
      error: `File exceeds the configured maximum upload size of ${maxUploadMb} MB.`,
    };
  }
  return { valid: true };
}

export function canPerformAction(
  role: UserRole,
  action:
    | 'manage_users'
    | 'manage_projects'
    | 'manage_locations'
    | 'manage_cameras'
    | 'upload_video'
    | 'review_events'
    | 'create_reports'
    | 'manage_settings'
    | 'view_audit_logs'
): boolean {
  if (role === 'ADMINISTRATOR') return true;
  if (role === 'ANALYST') {
    return [
      'upload_video',
      'review_events',
      'create_reports',
      'manage_locations',
      'manage_cameras',
    ].includes(action);
  }
  return false;
}

export function sanitizeFirestoreId(raw: string): string {
  const clean = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
  return clean.length > 0 ? clean : `id_${Date.now()}`;
}
