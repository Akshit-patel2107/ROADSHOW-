import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  FileVideo,
  Info,
  Loader2,
  RefreshCw,
  Upload,
  XCircle,
} from 'lucide-react';
import { useRoadshadow } from '../context/RoadshadowContext';
import { canPerformAction, sanitizeFirestoreId, validateCoordinates, validateVideoFileMeta } from '../engine/validation';
import { fetchDemoSampleVideoFile, roadshadowFetch, uploadVideoWithProgress } from '../lib/apiClient';
import type { ConflictEvent, FrameDetection, ProcessingJob, TrackedTrajectory, VideoRecord } from '../types/roadshadow';

export function UploadVideoPage() {
  const {
    currentUser,
    isDemoMode,
    projects,
    locations,
    cameras,
    videos,
    processingJobs,
    settings,
    serverHealth,
    refreshServerHealth,
    selectedProjectId,
    setSelectedProjectId,
    selectedSourceByProject,
    registerUploadedVideoAndResults,
    retryVideoAnalysis,
    pushToast,
  } = useRoadshadow();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const canUpload = currentUser ? canPerformAction(currentUser.role, 'upload_video') : false;
  const maxUploadMb = Math.min(settings.maxUploadMb, serverHealth.maxUploadMb);

  const urlProjectId = searchParams.get('projectId') || '';
  const urlCameraId = searchParams.get('cameraId') || '';

  const [title, setTitle] = useState('');
  const [projectId, setProjectId] = useState(
    urlProjectId || (selectedProjectId !== 'ALL' ? selectedProjectId : projects[0]?.id || '')
  );
  const [locationId, setLocationId] = useState(locations[0]?.id || '');
  const [cameraId, setCameraId] = useState(urlCameraId || cameras[0]?.id || '');
  const [recordingDate, setRecordingDate] = useState(new Date().toISOString().slice(0, 10));
  const [recordingTime, setRecordingTime] = useState('08:45');
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [roadType, setRoadType] = useState('Intersection');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const [validationError, setValidationError] = useState<string | null>(null);
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);
  const [workflowStatus, setWorkflowStatus] = useState<
    'Draft' | 'Uploading' | 'Uploaded' | 'Queued' | 'Processing' | 'Completed' | 'Failed' | 'Cancelled'
  >('Draft');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [activeJob, setActiveJob] = useState<ProcessingJob | null>(null);
  const [completedVideoId, setCompletedVideoId] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [backendJobs, setBackendJobs] = useState<ProcessingJob[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [sampleLoading, setSampleLoading] = useState(false);
  const [refreshingHealth, setRefreshingHealth] = useState(false);
  const [retryingVideoId, setRetryingVideoId] = useState<string | null>(null);

  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const submittingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Sync projectId with URL param or workspace selection when projects hydrate
  useEffect(() => {
    if (urlProjectId && projects.some((p) => p.id === urlProjectId)) {
      setProjectId(urlProjectId);
      setSelectedProjectId(urlProjectId);
      return;
    }
    if (selectedProjectId !== 'ALL' && projects.some((p) => p.id === selectedProjectId)) {
      setProjectId(selectedProjectId);
      return;
    }
    if (!projectId || !projects.some((p) => p.id === projectId)) {
      if (projects[0]) setProjectId(projects[0].id);
    }
  }, [urlProjectId, selectedProjectId, projects]);

  const filteredLocations = useMemo(
    () => (projectId ? locations.filter((l) => l.projectId === projectId) : locations),
    [locations, projectId]
  );

  // Sync locationId whenever projectId or locations change
  useEffect(() => {
    const pool = filteredLocations.length > 0 ? filteredLocations : locations;
    if (pool.length === 0) return;
    if (!locationId || !pool.some((l) => l.id === locationId)) {
      setLocationId(pool[0].id);
    }
  }, [filteredLocations, locations, locationId]);

  const filteredCameras = useMemo(
    () => (locationId ? cameras.filter((c) => c.locationId === locationId) : cameras),
    [cameras, locationId]
  );

  // Sync cameraId with URL camera param, remembered project camera, or location cameras
  useEffect(() => {
    const pool = filteredCameras.length > 0 ? filteredCameras : cameras;
    if (pool.length === 0) return;

    if (urlCameraId && cameras.some((c) => c.id === urlCameraId)) {
      const targetCam = cameras.find((c) => c.id === urlCameraId);
      if (targetCam) {
        setCameraId(targetCam.id);
        if (targetCam.locationId && targetCam.locationId !== locationId) {
          setLocationId(targetCam.locationId);
        }
        return;
      }
    }

    const remembered = projectId ? selectedSourceByProject[projectId] : undefined;
    if (remembered?.cameraId && pool.some((c) => c.id === remembered.cameraId)) {
      setCameraId(remembered.cameraId);
      return;
    }

    if (!cameraId || !pool.some((c) => c.id === cameraId)) {
      setCameraId(pool[0].id);
    }
  }, [urlCameraId, filteredCameras, cameras, projectId, selectedSourceByProject, locationId, cameraId]);

  // Manage local object URL for real browser video preview
  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const objUrl = URL.createObjectURL(file);
    setPreviewUrl(objUrl);
    return () => {
      URL.revokeObjectURL(objUrl);
    };
  }, [file]);

  const loadBackendJobs = useCallback(async () => {
    setLoadingJobs(true);
    try {
      const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
      const resp = await roadshadowFetch(`/api/processing/jobs${qs}`, {
        isDemoMode,
        demoRole: currentUser?.role,
      });
      if (resp.ok) {
        const data = (await resp.json()) as { jobs?: ProcessingJob[] };
        setBackendJobs(data.jobs || []);
      }
    } catch {
      // Keep workspace jobs as fallback if server poll fails temporarily
    } finally {
      setLoadingJobs(false);
    }
  }, [projectId, isDemoMode, currentUser?.role]);

  useEffect(() => {
    void loadBackendJobs();
  }, [loadBackendJobs]);

  const mergedJobs = useMemo(() => {
    const map = new Map<string, ProcessingJob>();
    for (const j of processingJobs) {
      if (!projectId || j.projectId === projectId) map.set(j.id, j);
    }
    for (const j of backendJobs) {
      map.set(j.id, j);
    }
    return Array.from(map.values())
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
      .slice(0, 8);
  }, [processingJobs, backendJobs, projectId]);

  const handleSelectFile = (selected: File | null) => {
    setValidationError(null);
    setDuplicateWarning(null);
    if (!selected) {
      setFile(null);
      return;
    }
    const check = validateVideoFileMeta(
      selected.name,
      selected.type,
      selected.size,
      maxUploadMb
    );
    if (!check.valid) {
      setValidationError(check.error || 'Invalid video file.');
      setFile(null);
      return;
    }
    const duplicate = videos.find(
      (v) => v.fileName === selected.name && v.fileSizeBytes === selected.size
    );
    if (duplicate) {
      setDuplicateWarning(
        `A video with the same filename and size ("${duplicate.title}") is already recorded in this workspace.`
      );
    }
    setFile(selected);
    if (!title.trim()) {
      setTitle(selected.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '));
    }
  };

  // Fetches a genuine playable H.264 MP4 sample clip generated by ffmpeg on the backend
  const handleGenerateTestClip = async () => {
    setValidationError(null);
    setSampleLoading(true);
    try {
      const sampleFile = await fetchDemoSampleVideoFile();
      handleSelectFile(sampleFile);
      if (!title.trim()) {
        setTitle('Anand Junction Sample Test Clip');
      }
      pushToast({
        type: 'info',
        title: 'Demo Sample MP4 Attached',
        description: 'Playable H.264 MP4 sample clip attached to verify upload validation, thumbnail extraction, and video preview.',
      });
    } catch (err) {
      setValidationError(err instanceof Error ? err.message : 'Unable to load sample MP4 clip.');
    } finally {
      setSampleLoading(false);
    }
  };

  const handleCancel = async () => {
    if (xhrRef.current) {
      xhrRef.current.abort();
      xhrRef.current = null;
    }
    if (activeJob && (workflowStatus === 'Queued' || workflowStatus === 'Processing')) {
      await roadshadowFetch(`/api/processing/jobs/${activeJob.id}/cancel`, {
        method: 'POST',
        isDemoMode,
        demoRole: currentUser?.role,
      }).catch(() => {});
    }
    submittingRef.current = false;
    setWorkflowStatus('Cancelled');
    void loadBackendJobs();
    pushToast({ type: 'warning', title: 'Upload / Processing Cancelled' });
  };

  const startUploadAndProcess = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (submittingRef.current) return; // Prevent accidental double upload clicks
    setValidationError(null);
    setErrorDetail(null);

    if (!canUpload || !currentUser) {
      setValidationError('Your current role (VIEWER) cannot upload videos or launch processing jobs.');
      return;
    }
    if (!title.trim() || title.trim().length < 2) {
      setValidationError('Enter a descriptive video title (at least 2 characters).');
      return;
    }
    const effectiveProjectId = projectId || projects[0]?.id;
    const effectiveLocationId = locationId || filteredLocations[0]?.id || locations[0]?.id;
    const effectiveCameraId = cameraId || filteredCameras[0]?.id || cameras[0]?.id;

    if (!effectiveProjectId || !effectiveLocationId || !effectiveCameraId) {
      setValidationError('Create at least one Project, Location, and Camera before uploading footage.');
      return;
    }
    if (!file) {
      setValidationError('Select a valid MP4, MOV, or WebM video file before uploading.');
      return;
    }
    if (latitude.trim() || longitude.trim()) {
      const coordCheck = validateCoordinates(Number(latitude), Number(longitude));
      if (!coordCheck.valid) {
        setValidationError(coordCheck.error || 'Invalid GPS coordinates.');
        return;
      }
    }

    submittingRef.current = true;
    setWorkflowStatus('Uploading');
    setUploadProgress(0);

    try {
      // 1. Real upload with progress + ffprobe validation & thumbnail extraction
      const uploadResponse = await uploadVideoWithProgress(file, {
        isDemoMode,
        demoRole: currentUser.role,
        onProgress: setUploadProgress,
        onXhr: (xhr) => {
          xhrRef.current = xhr;
        },
      });

      setWorkflowStatus('Uploaded');
      setUploadProgress(100);

      // 2. Create video ID and enqueue server-side asynchronous CV processing job
      const videoId = sanitizeFirestoreId(`vid_${Date.now()}`);
      const occurredAtIso = new Date(`${recordingDate}T${recordingTime || '09:00'}:00`).toISOString();

      setWorkflowStatus('Queued');
      const jobResp = await roadshadowFetch('/api/processing/jobs', {
        method: 'POST',
        isDemoMode,
        demoRole: currentUser.role,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoId,
          projectId: effectiveProjectId,
          locationId: effectiveLocationId,
          fileUrl: uploadResponse.fileUrl,
          durationSec: uploadResponse.durationSec || 10,
          occurredAtIso,
        }),
      });

      if (!jobResp.ok) {
        const errBody = await jobResp.json().catch(() => ({}));
        throw new Error(errBody.error || 'Failed to enqueue processing job.');
      }

      const { job: initialJob } = (await jobResp.json()) as { job: ProcessingJob };
      setActiveJob(initialJob);

      // 3. Poll real backend job status until terminal state
      let currentJob: ProcessingJob & {
        resultPayload?: {
          detections: FrameDetection[];
          trajectories: TrackedTrajectory[];
          events: ConflictEvent[];
        };
      } = initialJob;

      while (currentJob.status === 'Queued' || currentJob.status === 'Processing') {
        await new Promise((r) => setTimeout(r, 450));
        const pollResp = await roadshadowFetch(`/api/processing/jobs/${initialJob.id}`, {
          isDemoMode,
          demoRole: currentUser.role,
        });
        if (!pollResp.ok) throw new Error('Lost connection while polling processing job.');
        const pollJson = await pollResp.json();
        currentJob = pollJson.job;
        setActiveJob(currentJob);
        setWorkflowStatus(currentJob.status);
      }

      if (currentJob.status === 'Cancelled') {
        setWorkflowStatus('Cancelled');
        submittingRef.current = false;
        void loadBackendJobs();
        return;
      }

      const analysisSucceeded = currentJob.status === 'Completed';
      const nowIso = new Date().toISOString();
      const failureMsg =
        currentJob.errorMessage ||
        'Real CV worker is unavailable. Uploaded video has been saved safely for playback and later retry.';

      // Always persist the uploaded video record to the project (even if automated CV failed)
      const newVideo: VideoRecord = {
        id: videoId,
        projectId: effectiveProjectId,
        locationId: effectiveLocationId,
        cameraId: effectiveCameraId,
        ownerId: currentUser.uid,
        title: title.trim(),
        fileName: file.name,
        mimeType: uploadResponse.mimeType,
        fileSizeBytes: uploadResponse.fileSizeBytes,
        fileUrl: uploadResponse.fileUrl,
        posterUrl: uploadResponse.posterUrl || undefined,
        recordingDate,
        recordingTime,
        ...(latitude.trim() ? { latitude: Number(latitude) } : {}),
        ...(longitude.trim() ? { longitude: Number(longitude) } : {}),
        roadType,
        description: description.trim(),
        durationSec: uploadResponse.durationSec || 0,
        width: uploadResponse.width ?? undefined,
        height: uploadResponse.height ?? undefined,
        fps: uploadResponse.fps ?? undefined,
        status: analysisSucceeded ? 'Completed' : 'Failed',
        errorMessage: analysisSucceeded ? undefined : failureMsg,
        isDemonstration: false,
        detections: analysisSucceeded ? currentJob.resultPayload?.detections || [] : [],
        trajectories: analysisSucceeded ? currentJob.resultPayload?.trajectories || [] : [],
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      const detectedEvents = analysisSucceeded ? currentJob.resultPayload?.events || [] : [];

      await registerUploadedVideoAndResults({
        video: newVideo,
        job: currentJob,
        events: detectedEvents,
      });

      setSelectedProjectId(effectiveProjectId);
      setCompletedVideoId(videoId);
      void loadBackendJobs();

      if (analysisSucceeded) {
        setWorkflowStatus('Completed');
        pushToast({
          type: 'success',
          title: 'Video Processing Completed',
          description: `${detectedEvents.length} candidate conflict events saved to workspace.`,
        });
      } else {
        setWorkflowStatus('Failed');
        setErrorDetail(failureMsg);
        pushToast({
          type: 'warning',
          title: 'Video Saved — CV Analysis Unavailable',
          description: failureMsg,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload or processing failed.';
      if (msg !== 'Upload cancelled by user.') {
        setWorkflowStatus('Failed');
        setErrorDetail(msg);
        void loadBackendJobs();
        pushToast({ type: 'error', title: 'Upload / Processing Failed', description: msg });
      }
    } finally {
      submittingRef.current = false;
    }
  };

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[#F5F8FC]">Video Upload &amp; Processing Centre</h1>
          <p className="text-sm text-[#A9B8CA] mt-1">
            Upload MP4, MOV, or WebM traffic footage to a selected project for trajectory tracking and near-miss extraction.
          </p>
        </div>
        <button
          type="button"
          onClick={() => navigate('/projects')}
          className="px-3.5 py-2 bg-[#122943] hover:bg-[#1B3A5E] border border-[#233B56] rounded-md text-xs font-medium text-[#F5F8FC] whitespace-nowrap shrink-0 transition-colors"
        >
          Manage Projects
        </button>
      </div>

      {/* Honest Live CV Worker Health Notice */}
      <div
        data-testid="cv-engine-status-banner"
        className={`p-4 rounded-lg bg-[#122943] border flex flex-col sm:flex-row sm:items-start justify-between gap-3 ${
          serverHealth.cvAdapter.status === 'available'
            ? 'border-[#22C55E]/40'
            : 'border-[#EAB308]/40'
        }`}
      >
        <div className="flex items-start gap-3">
          <Info
            className={`w-5 h-5 mt-0.5 shrink-0 ${
              serverHealth.cvAdapter.status === 'available' ? 'text-[#22C55E]' : 'text-[#EAB308]'
            }`}
          />
          <div className="text-xs text-[#A9B8CA] leading-relaxed">
            <p className="text-sm font-medium text-[#F5F8FC]">
              Real Analysis CV Worker:{' '}
              {serverHealth.cvAdapter.status === 'available'
                ? `Connected (${serverHealth.cvAdapter.modelVersion || 'YOLO + ByteTrack'}${
                    serverHealth.cvAdapter.latencyMs !== null ? `, ${serverHealth.cvAdapter.latencyMs} ms` : ''
                  })`
                : serverHealth.cvAdapter.status === 'unavailable'
                  ? 'Configured but Unreachable'
                  : 'Not Configured (CV_SERVICE_URL Unset)'}
            </p>
            <p className="mt-1">
              Permitted formats: <strong className="text-[#F5F8FC]">MP4, MOV, WebM</strong> · Maximum file size:{' '}
              <strong className="text-[#F5F8FC] font-mono tabular-nums">{maxUploadMb} MB</strong>.{' '}
              {serverHealth.cvAdapter.message} Uploaded videos are validated with ffprobe, stored safely in your project, and never produce fabricated detections when the CV service is unavailable.
            </p>
          </div>
        </div>
        <button
          type="button"
          disabled={refreshingHealth}
          onClick={async () => {
            setRefreshingHealth(true);
            try {
              await refreshServerHealth(true);
            } finally {
              setRefreshingHealth(false);
            }
          }}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#0D1F35] hover:bg-[#1B3A5E] border border-[#233B56] rounded-md text-xs text-[#F5F8FC] whitespace-nowrap shrink-0 self-start"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshingHealth ? 'animate-spin' : ''}`} />
          Check CV Status
        </button>
      </div>

      {!canUpload && (
        <div role="alert" className="p-4 rounded-lg bg-[#E5484D]/10 border border-[#E5484D]/40 text-sm text-[#F5F8FC]">
          Your current role (<span className="font-mono">{currentUser?.role}</span>) is read-only. Switch to an Analyst or Administrator account to upload and process traffic footage.
        </div>
      )}

      <form onSubmit={startUploadAndProcess} className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Metadata Form */}
        <div className="lg:col-span-7 bg-[#122943] border border-[#233B56] rounded-lg p-5 space-y-4">
          <h2 className="text-base font-semibold text-[#F5F8FC]">Footage Metadata</h2>

          <div>
            <label htmlFor="vid-title" className="block text-xs font-medium text-[#A9B8CA] mb-1.5">
              Video Title *
            </label>
            <input
              id="vid-title"
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Town Hall Junction — Morning Peak 09:00 AM"
              className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC] focus:outline-none focus:ring-2 focus:ring-[#2585FF]"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="vid-project" className="block text-xs font-medium text-[#A9B8CA] mb-1.5">
                Project *
              </label>
              <select
                id="vid-project"
                value={projectId}
                onChange={(e) => {
                  const nextProj = e.target.value;
                  setProjectId(nextProj);
                  setSelectedProjectId(nextProj);
                  const firstLoc = locations.find((l) => l.projectId === nextProj);
                  if (firstLoc) setLocationId(firstLoc.id);
                }}
                className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC] focus:outline-none focus:ring-2 focus:ring-[#2585FF]"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="vid-location" className="block text-xs font-medium text-[#A9B8CA] mb-1.5">
                Road Location *
              </label>
              <select
                id="vid-location"
                value={locationId}
                onChange={(e) => {
                  setLocationId(e.target.value);
                  const firstCam = cameras.find((c) => c.locationId === e.target.value);
                  if (firstCam) setCameraId(firstCam.id);
                }}
                className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC] focus:outline-none focus:ring-2 focus:ring-[#2585FF]"
              >
                {(filteredLocations.length > 0 ? filteredLocations : locations).map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="vid-camera" className="block text-xs font-medium text-[#A9B8CA] mb-1.5">
                Camera *
              </label>
              <select
                id="vid-camera"
                value={cameraId}
                onChange={(e) => setCameraId(e.target.value)}
                className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC] focus:outline-none focus:ring-2 focus:ring-[#2585FF]"
              >
                {(filteredCameras.length > 0 ? filteredCameras : cameras).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.status})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="vid-roadtype" className="block text-xs font-medium text-[#A9B8CA] mb-1.5">
                Road Type
              </label>
              <select
                id="vid-roadtype"
                value={roadType}
                onChange={(e) => setRoadType(e.target.value)}
                className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC] focus:outline-none focus:ring-2 focus:ring-[#2585FF]"
              >
                {[
                  'Intersection',
                  'Highway',
                  'School zone',
                  'Hospital zone',
                  'Commercial road',
                  'Residential road',
                  'Pedestrian crossing',
                  'Other',
                ].map((rt) => (
                  <option key={rt} value={rt}>
                    {rt}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="vid-date" className="block text-xs font-medium text-[#A9B8CA] mb-1.5">
                Recording Date *
              </label>
              <input
                id="vid-date"
                type="date"
                value={recordingDate}
                onChange={(e) => setRecordingDate(e.target.value)}
                className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC] font-mono focus:outline-none focus:ring-2 focus:ring-[#2585FF]"
              />
            </div>

            <div>
              <label htmlFor="vid-time" className="block text-xs font-medium text-[#A9B8CA] mb-1.5">
                Recording Time *
              </label>
              <input
                id="vid-time"
                type="time"
                value={recordingTime}
                onChange={(e) => setRecordingTime(e.target.value)}
                className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC] font-mono focus:outline-none focus:ring-2 focus:ring-[#2585FF]"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="vid-lat" className="block text-xs font-medium text-[#A9B8CA] mb-1.5">
                Optional GPS Latitude
              </label>
              <input
                id="vid-lat"
                type="text"
                value={latitude}
                onChange={(e) => setLatitude(e.target.value)}
                placeholder="e.g. 22.5645"
                className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC] font-mono focus:outline-none focus:ring-2 focus:ring-[#2585FF]"
              />
            </div>
            <div>
              <label htmlFor="vid-lng" className="block text-xs font-medium text-[#A9B8CA] mb-1.5">
                Optional GPS Longitude
              </label>
              <input
                id="vid-lng"
                type="text"
                value={longitude}
                onChange={(e) => setLongitude(e.target.value)}
                placeholder="e.g. 72.9289"
                className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC] font-mono focus:outline-none focus:ring-2 focus:ring-[#2585FF]"
              />
            </div>
          </div>

          <div>
            <label htmlFor="vid-desc" className="block text-xs font-medium text-[#A9B8CA] mb-1.5">
              Field Notes &amp; Conditions
            </label>
            <textarea
              id="vid-desc"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Weather, lighting, traffic police presence, or special road work conditions..."
              className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC] focus:outline-none focus:ring-2 focus:ring-[#2585FF]"
            />
          </div>
        </div>

        {/* Right File Dropzone, Preview & Live Processing Status */}
        <div className="lg:col-span-5 space-y-4">
          <div className="bg-[#122943] border border-[#233B56] rounded-lg p-5 space-y-4">
            <h2 className="text-base font-semibold text-[#F5F8FC]">Video File &amp; Preview</h2>

            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragActive(false);
                const dropped = e.dataTransfer.files?.[0] ?? null;
                handleSelectFile(dropped);
              }}
              className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors ${
                dragActive
                  ? 'border-[#2585FF] bg-[#2585FF]/10'
                  : 'border-[#233B56] bg-[#0D1F35]'
              }`}
            >
              <FileVideo className="w-8 h-8 text-[#45B5FF] mx-auto" />
              <p className="text-sm font-medium text-[#F5F8FC] mt-3">
                Drag and drop traffic video here
              </p>
              <p className="text-xs text-[#A9B8CA] mt-1">
                MP4, MOV, or WebM up to {maxUploadMb} MB
              </p>

              <input
                ref={fileInputRef}
                type="file"
                accept=".mp4,.mov,.webm,video/mp4,video/quicktime,video/webm"
                onChange={(e) => handleSelectFile(e.target.files?.[0] ?? null)}
                className="sr-only"
                id="video-file-input"
              />
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="px-3.5 py-1.5 bg-[#122943] hover:bg-[#1B3A5E] border border-[#233B56] rounded-md text-xs font-medium text-[#F5F8FC] transition-colors whitespace-nowrap"
                >
                  Browse Files
                </button>
                <button
                  type="button"
                  disabled={sampleLoading}
                  onClick={() => void handleGenerateTestClip()}
                  className="px-3.5 py-1.5 bg-[#071426] hover:bg-[#122943] disabled:opacity-50 border border-[#2585FF]/40 rounded-md text-xs font-medium text-[#45B5FF] transition-colors whitespace-nowrap"
                >
                  {sampleLoading ? 'Loading Sample MP4...' : 'Attach Demo Sample Clip (.mp4)'}
                </button>
              </div>
            </div>

            {file && (
              <div className="space-y-3">
                <div className="p-3 rounded-md bg-[#0D1F35] border border-[#233B56] flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-[#F5F8FC] truncate">{file.name}</p>
                    <p className="text-[11px] font-mono tabular-nums text-[#A9B8CA]">
                      {(file.size / (1024 * 1024)).toFixed(2)} MB · {file.type}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setFile(null);
                      setDuplicateWarning(null);
                    }}
                    className="text-xs text-[#A9B8CA] hover:text-[#E5484D] whitespace-nowrap"
                  >
                    Remove
                  </button>
                </div>

                {previewUrl && (
                  <div className="rounded-md overflow-hidden border border-[#233B56] bg-[#071426]">
                    <video
                      src={previewUrl}
                      controls
                      muted
                      playsInline
                      className="w-full max-h-44 object-contain"
                      data-testid="upload-video-preview"
                    />
                  </div>
                )}
              </div>
            )}

            {duplicateWarning && (
              <div role="status" className="p-3 rounded-md bg-[#EAB308]/10 border border-[#EAB308]/40 text-xs text-[#F5F8FC]">
                {duplicateWarning}
              </div>
            )}

            {validationError && (
              <div role="alert" className="p-3 rounded-md bg-[#E5484D]/10 border border-[#E5484D]/40 flex items-start gap-2 text-xs text-[#F5F8FC]">
                <AlertCircle className="w-4 h-4 text-[#E5484D] shrink-0 mt-0.5" />
                <span>{validationError}</span>
              </div>
            )}

            <div className="flex items-center gap-2 pt-2">
              <button
                type="submit"
                disabled={
                  !canUpload ||
                  workflowStatus === 'Uploading' ||
                  workflowStatus === 'Queued' ||
                  workflowStatus === 'Processing'
                }
                className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-[#2585FF] hover:bg-[#1C74E8] disabled:opacity-50 text-white text-sm font-medium rounded-md transition-colors whitespace-nowrap"
              >
                <Upload className="w-4 h-4" />
                Upload &amp; Start Analysis
              </button>
              {(workflowStatus === 'Uploading' ||
                workflowStatus === 'Queued' ||
                workflowStatus === 'Processing') && (
                <button
                  type="button"
                  onClick={handleCancel}
                  className="px-3 py-2.5 bg-[#0D1F35] border border-[#E5484D]/50 text-[#E5484D] text-xs font-medium rounded-md hover:bg-[#E5484D]/10 whitespace-nowrap"
                >
                  Cancel
                </button>
              )}
            </div>
          </div>

          {/* Processing Job State Panel */}
          {workflowStatus !== 'Draft' && (
            <div className="bg-[#122943] border border-[#233B56] rounded-lg p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-[#F5F8FC]">Processing Pipeline Status</h3>
                <span className="text-xs font-mono text-[#45B5FF]">{workflowStatus}</span>
              </div>

              <div className="w-full h-2 bg-[#071426] rounded overflow-hidden">
                <div
                  className="h-full bg-[#2585FF] transition-all duration-300"
                  style={{
                    width: `${
                      workflowStatus === 'Uploading'
                        ? uploadProgress
                        : activeJob?.progress ?? (workflowStatus === 'Completed' ? 100 : 15)
                    }%`,
                  }}
                />
              </div>

              {(workflowStatus === 'Uploading' ||
                workflowStatus === 'Queued' ||
                workflowStatus === 'Processing') && (
                <div className="flex items-center gap-2 text-xs text-[#A9B8CA]">
                  <Loader2 className="w-4 h-4 animate-spin text-[#45B5FF]" />
                  <span>
                    {workflowStatus === 'Uploading'
                      ? `Uploading footage (${uploadProgress}%)...`
                      : `Job ${activeJob?.id || ''} is ${workflowStatus.toLowerCase()} (${activeJob?.progress ?? 0}%)...`}
                  </span>
                </div>
              )}

              {workflowStatus === 'Completed' && completedVideoId && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-xs text-[#22C55E]">
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                    <span>
                      Analysis complete · {activeJob?.conflictCount ?? 0} potential conflicts ·{' '}
                      {activeJob?.trackingCount ?? 0} tracked road users
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => navigate(`/video-analysis/${completedVideoId}`)}
                    className="w-full px-4 py-2 bg-[#2585FF] hover:bg-[#1C74E8] text-white text-xs font-medium rounded-md transition-colors whitespace-nowrap"
                  >
                    Open Video Analysis Results
                  </button>
                </div>
              )}

              {workflowStatus === 'Failed' && (
                <div className="space-y-3">
                  <div className="flex items-start gap-2 text-xs text-[#E5484D]">
                    <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{errorDetail || 'Automated CV processing did not complete.'}</span>
                  </div>
                  {completedVideoId && (
                    <p className="text-[11px] text-[#A9B8CA]">
                      Your uploaded video file is safely stored in the project and can be played immediately or re-analysed once the CV worker is connected.
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {completedVideoId ? (
                      <>
                        <button
                          type="button"
                          disabled={retryingVideoId === completedVideoId}
                          onClick={async () => {
                            setRetryingVideoId(completedVideoId);
                            try {
                              await retryVideoAnalysis(completedVideoId);
                              void loadBackendJobs();
                            } finally {
                              setRetryingVideoId(null);
                            }
                          }}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#0D1F35] border border-[#2585FF]/50 text-xs font-medium text-[#45B5FF] rounded-md hover:bg-[#173252] disabled:opacity-50 whitespace-nowrap"
                        >
                          <RefreshCw
                            className={`w-3.5 h-3.5 ${retryingVideoId === completedVideoId ? 'animate-spin' : ''}`}
                          />
                          Retry CV Analysis
                        </button>
                        <button
                          type="button"
                          onClick={() => navigate(`/video-analysis/${completedVideoId}`)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#2585FF] hover:bg-[#1C74E8] text-white text-xs font-medium rounded-md whitespace-nowrap"
                        >
                          Open Stored Video
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void startUploadAndProcess()}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#0D1F35] border border-[#233B56] text-xs font-medium text-[#F5F8FC] rounded-md hover:border-[#2585FF] whitespace-nowrap"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        Retry Upload
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </form>

      {/* Persistent Processing Jobs Queue & History */}
      <section className="bg-[#122943] border border-[#233B56] rounded-lg overflow-hidden">
        <div className="p-4 border-b border-[#233B56] flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-[#F5F8FC]">Recent Processing Jobs</h2>
            <p className="text-xs text-[#A9B8CA]">
              Persisted upload and trajectory-processing history for the selected project
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadBackendJobs()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#0D1F35] hover:bg-[#1B3A5E] border border-[#233B56] rounded-md text-xs text-[#F5F8FC] transition-colors whitespace-nowrap"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loadingJobs ? 'animate-spin' : ''}`} />
            Refresh Jobs
          </button>
        </div>

        {mergedJobs.length === 0 ? (
          <div className="p-6 text-center text-xs text-[#A9B8CA]">
            No processing jobs recorded for this project yet. Upload a clip above to enqueue analysis.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#233B56] bg-[#0D1F35] text-xs text-[#A9B8CA]">
                  <th className="py-2.5 px-4 font-medium">Job ID</th>
                  <th className="py-2.5 px-4 font-medium">Video</th>
                  <th className="py-2.5 px-4 font-medium">Engine</th>
                  <th className="py-2.5 px-4 font-medium">Status</th>
                  <th className="py-2.5 px-4 font-medium text-right">Conflicts</th>
                  <th className="py-2.5 px-4 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#233B56] text-xs">
                {mergedJobs.map((job) => {
                  const matchedVideo = videos.find((v) => v.id === job.videoId);
                  return (
                    <tr key={job.id} className="hover:bg-[#0D1F35]/60">
                      <td className="py-2.5 px-4 font-mono text-[#A9B8CA] whitespace-nowrap">
                        {job.id}
                      </td>
                      <td className="py-2.5 px-4 text-[#F5F8FC] font-medium">
                        {matchedVideo?.title || job.videoId}
                      </td>
                      <td className="py-2.5 px-4 text-[#A9B8CA] whitespace-nowrap">
                        {job.engineMode === 'CV_SERVICE'
                          ? 'Real CV Worker'
                          : job.engineMode === 'DEMONSTRATION'
                            ? 'Demo Precomputed'
                            : 'CV Service Unavailable'}
                      </td>
                      <td className="py-2.5 px-4 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center gap-1.5 font-mono ${
                            job.status === 'Completed'
                              ? 'text-[#22C55E]'
                              : job.status === 'Failed' || job.status === 'Cancelled'
                                ? 'text-[#E5484D]'
                                : 'text-[#45B5FF]'
                          }`}
                        >
                          <Clock className="w-3.5 h-3.5" />
                          {job.status} ({job.progress}%)
                        </span>
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums text-[#F5F8FC]">
                        {job.conflictCount}
                      </td>
                      <td className="py-2.5 px-4 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-2.5">
                          {job.status === 'Failed' && matchedVideo && !matchedVideo.isDemonstration && canUpload && (
                            <button
                              type="button"
                              disabled={retryingVideoId === matchedVideo.id}
                              onClick={async () => {
                                setRetryingVideoId(matchedVideo.id);
                                try {
                                  await retryVideoAnalysis(matchedVideo.id);
                                  void loadBackendJobs();
                                } finally {
                                  setRetryingVideoId(null);
                                }
                              }}
                              className="text-[#EAB308] hover:underline font-medium disabled:opacity-50"
                            >
                              Retry
                            </button>
                          )}
                          {matchedVideo ? (
                            <button
                              type="button"
                              onClick={() => navigate(`/video-analysis/${matchedVideo.id}`)}
                              className="text-[#45B5FF] hover:underline font-medium"
                            >
                              {job.status === 'Completed' ? 'Inspect' : 'Open Video'}
                            </button>
                          ) : (
                            <span className="text-[#A9B8CA]">—</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

