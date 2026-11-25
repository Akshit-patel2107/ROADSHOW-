import { auth } from './firebase';
import type { UserRole } from '../types/roadshadow';

export interface ApiFetchOptions extends RequestInit {
  isDemoMode?: boolean;
  demoRole?: UserRole;
}

export interface UploadedVideoResponse {
  fileName: string;
  storedFileName: string;
  mimeType: 'video/mp4' | 'video/quicktime' | 'video/webm';
  fileSizeBytes: number;
  fileUrl: string;
  posterUrl: string | null;
  durationSec: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  codec: string | null;
  probedByFfprobe: boolean;
}

async function resolveAuthHeaders(isDemoMode: boolean, demoRole?: UserRole): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const firebaseUser = auth.currentUser;
  if (firebaseUser && !isDemoMode) {
    try {
      const idToken = await firebaseUser.getIdToken();
      result.Authorization = `Bearer ${idToken}`;
    } catch {
      // Let backend return 401 cleanly if token retrieval fails
    }
  } else if (isDemoMode) {
    result['X-Roadshadow-Demo-Mode'] = 'true';
    if (demoRole) {
      result['X-Roadshadow-Demo-Role'] = demoRole;
    }
  }
  return result;
}

/**
 * Centralized API helper for ROADSHADOW backend requests.
 * - Authenticated Firebase users send a verified `Authorization: Bearer <idToken>`.
 * - Demo Mode sessions explicitly send `X-Roadshadow-Demo-Mode: true` so the server
 *   isolates demo jobs and configurations in a sandboxed demo namespace.
 */
export async function roadshadowFetch(
  url: string,
  options: ApiFetchOptions = {}
): Promise<Response> {
  const { isDemoMode = false, demoRole, headers: rawHeaders, ...rest } = options;
  const headers = new Headers(rawHeaders || {});
  const authHeaders = await resolveAuthHeaders(isDemoMode, demoRole);
  for (const [k, v] of Object.entries(authHeaders)) {
    headers.set(k, v);
  }

  return fetch(url, {
    ...rest,
    headers,
  });
}

/**
 * Authenticated XHR video uploader with real upload progress reporting and server-side ffprobe metadata.
 */
export async function uploadVideoWithProgress(
  file: File,
  opts: {
    isDemoMode?: boolean;
    demoRole?: UserRole;
    onProgress?: (pct: number) => void;
    onXhr?: (xhr: XMLHttpRequest | null) => void;
  } = {}
): Promise<UploadedVideoResponse> {
  const authHeaders = await resolveAuthHeaders(Boolean(opts.isDemoMode), opts.demoRole);

  return new Promise<UploadedVideoResponse>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    opts.onXhr?.(xhr);
    const formData = new FormData();
    formData.append('video', file);

    xhr.upload.onprogress = (evt) => {
      if (evt.lengthComputable) {
        opts.onProgress?.(Math.round((evt.loaded / evt.total) * 100));
      }
    };

    xhr.onload = () => {
      opts.onXhr?.(null);
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as UploadedVideoResponse);
        } catch {
          reject(new Error('Server returned an unreadable upload response.'));
        }
      } else {
        try {
          const parsed = JSON.parse(xhr.responseText);
          reject(new Error(parsed.error || `Upload failed (HTTP ${xhr.status}).`));
        } catch {
          reject(new Error(`Upload failed (HTTP ${xhr.status}).`));
        }
      }
    };

    xhr.onerror = () => {
      opts.onXhr?.(null);
      reject(new Error('Network failure during video upload.'));
    };

    xhr.onabort = () => {
      opts.onXhr?.(null);
      reject(new Error('Upload cancelled by user.'));
    };

    xhr.open('POST', '/api/uploads/video');
    for (const [k, v] of Object.entries(authHeaders)) {
      xhr.setRequestHeader(k, v);
    }
    xhr.send(formData);
  });
}

/**
 * Fetches a genuine playable H.264 MP4 sample test clip from the backend for verifying
 * upload validation, thumbnail generation, video preview, and storage without fake headers.
 */
export async function fetchDemoSampleVideoFile(): Promise<File> {
  const resp = await fetch('/api/demo/sample-clip');
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.error || `Unable to load sample test clip (HTTP ${resp.status}).`);
  }
  const blob = await resp.blob();
  return new File([blob], `roadshadow_sample_junction_${Date.now().toString().slice(-4)}.mp4`, {
    type: 'video/mp4',
  });
}
