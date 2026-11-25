import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  ArrowRight,
  Calendar,
  CheckCircle2,
  FileVideo,
  FolderKanban,
  LayoutDashboard,
  Loader2,
  MapPin,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  Video,
  X,
} from 'lucide-react';
import { useRoadshadow } from '../context/RoadshadowContext';
import { canPerformAction, sanitizeFirestoreId, validateVideoFileMeta } from '../engine/validation';
import { ConfirmDialog } from '../components/ToastContainer';
import { fetchDemoSampleVideoFile, roadshadowFetch, uploadVideoWithProgress } from '../lib/apiClient';
import type { ConflictEvent, FrameDetection, ProcessingJob, Project, TrackedTrajectory, VideoRecord } from '../types/roadshadow';

type ProjectFilterTab = 'recent' | 'all' | 'active' | 'archived';
const PAGE_SIZE = 6;

export function ProjectsPage() {
  const {
    currentUser,
    isDemoMode,
    projects,
    locations,
    cameras,
    videos,
    processingJobs,
    conflictEvents,
    selectedProjectId,
    setSelectedProjectId,
    settings,
    serverHealth,
    createProject,
    updateProject,
    createLocation,
    createCamera,
    deleteProject,
    registerUploadedVideoAndResults,
    pushToast,
  } = useRoadshadow();
  const navigate = useNavigate();

  const canManage = currentUser ? canPerformAction(currentUser.role, 'manage_projects') : false;
  const maxUploadMb = Math.min(settings.maxUploadMb, serverHealth.maxUploadMb);

  const [searchQuery, setSearchQuery] = useState('');
  const [filterTab, setFilterTab] = useState<ProjectFilterTab>('recent');
  const [page, setPage] = useState(1);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [sampleLoading, setSampleLoading] = useState(false);

  // Edit project state
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [editName, setEditName] = useState('');
  const [editLocationSummary, setEditLocationSummary] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editStartDate, setEditStartDate] = useState('');
  const [editStatus, setEditStatus] = useState<'active' | 'archived'>('active');
  const [editSaving, setEditSaving] = useState(false);

  // Create project form state
  const [name, setName] = useState('');
  const [junctionName, setJunctionName] = useState('');
  const [city, setCity] = useState('Anand');
  const [stateName, setStateName] = useState('Gujarat');
  const [description, setDescription] = useState('');
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [initialFile, setInitialFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const [formError, setFormError] = useState<string | null>(null);
  const [busyStep, setBusyStep] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  // Retains created project ID if optional video upload fails so Retry never duplicates project!
  const [pendingProjectContext, setPendingProjectContext] = useState<{
    projectId: string;
    locationId: string;
    cameraId: string;
  } | null>(null);

  const submittingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!initialFile) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(initialFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [initialFile]);

  const enrichedProjects = useMemo(() => {
    return projects.map((proj) => {
      const pVids = videos.filter((v) => v.projectId === proj.id);
      const pJobs = processingJobs.filter((j) => j.projectId === proj.id);
      const pEvents = conflictEvents.filter(
        (e) => e.projectId === proj.id && e.validationStatus !== 'False positive'
      );
      const pLocs = locations.filter((l) => l.projectId === proj.id);
      const pCams = cameras.filter((c) => c.projectId === proj.id);

      let processingStatus: 'Processing' | 'Failed' | 'Completed' | 'No footage yet' =
        'No footage yet';
      if (pJobs.some((j) => j.status === 'Queued' || j.status === 'Processing')) {
        processingStatus = 'Processing';
      } else if (pVids.some((v) => v.status === 'Completed') || pJobs.some((j) => j.status === 'Completed')) {
        processingStatus = 'Completed';
      } else if (pVids.some((v) => v.status === 'Failed') || pJobs.some((j) => j.status === 'Failed')) {
        processingStatus = 'Failed';
      }

      const locationText =
        proj.locationSummary ||
        pLocs.map((l) => `${l.name} (${l.city})`).join(' · ') ||
        'Location not assigned';

      return {
        ...proj,
        videoCount: pVids.length,
        cameraCount: pCams.length,
        eventCount: pEvents.length,
        locationText,
        processingStatus,
      };
    });
  }, [projects, videos, processingJobs, conflictEvents, locations, cameras]);

  const filteredProjects = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    let list = enrichedProjects.filter((p) => {
      if (filterTab === 'active' && p.status !== 'active') return false;
      if (filterTab === 'archived' && p.status !== 'archived') return false;
      if (q) {
        return (
          p.name.toLowerCase().includes(q) ||
          p.locationText.toLowerCase().includes(q) ||
          p.id.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q)
        );
      }
      return true;
    });

    if (filterTab === 'recent') {
      list = [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } else {
      list = [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    return list;
  }, [enrichedProjects, searchQuery, filterTab]);

  const totalPages = Math.max(1, Math.ceil(filteredProjects.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paginatedProjects = filteredProjects.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  useEffect(() => {
    setPage(1);
  }, [searchQuery, filterTab]);

  const handleFileChange = (selected: File | null) => {
    setFormError(null);
    if (!selected) {
      setInitialFile(null);
      return;
    }
    const check = validateVideoFileMeta(selected.name, selected.type, selected.size, maxUploadMb);
    if (!check.valid) {
      setFormError(check.error || 'Unsupported video file.');
      setInitialFile(null);
      return;
    }
    setInitialFile(selected);
  };

  const attachSampleVideo = async () => {
    setFormError(null);
    setSampleLoading(true);
    try {
      const clip = await fetchDemoSampleVideoFile();
      handleFileChange(clip);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Unable to attach playable sample clip.');
    } finally {
      setSampleLoading(false);
    }
  };

  const openEditModal = (proj: Project) => {
    setEditingProject(proj);
    setEditName(proj.name);
    setEditLocationSummary(proj.locationSummary || '');
    setEditDescription(proj.description);
    setEditStartDate(proj.startDate);
    setEditStatus(proj.status);
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingProject || editName.trim().length < 2) return;
    setEditSaving(true);
    try {
      await updateProject(editingProject.id, {
        name: editName.trim(),
        locationSummary: editLocationSummary.trim() || undefined,
        description: editDescription.trim(),
        startDate: editStartDate,
        status: editStatus,
      });
      setEditingProject(null);
    } finally {
      setEditSaving(false);
    }
  };

  const resetCreateForm = () => {
    setName('');
    setJunctionName('');
    setDescription('');
    setInitialFile(null);
    setFormError(null);
    setBusyStep(null);
    setUploadProgress(0);
    setPendingProjectContext(null);
    setShowCreateForm(false);
  };

  const handleCreateProject = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (submittingRef.current) return;
    setFormError(null);

    if (!canManage || !currentUser) {
      setFormError('Only Analysts and Administrators can create projects.');
      return;
    }
    if (!pendingProjectContext) {
      if (name.trim().length < 2) {
        setFormError('Enter a project name (at least 2 characters).');
        return;
      }
      if (junctionName.trim().length < 2) {
        setFormError('Enter the road or junction location name.');
        return;
      }
    }

    submittingRef.current = true;

    try {
      let projCtx = pendingProjectContext;

      if (!projCtx) {
        setBusyStep('Saving project record...');
        const locSummary = `${junctionName.trim()}, ${city.trim() || 'India'}`;
        const createdProj = await createProject({
          name: name.trim(),
          locationSummary: locSummary,
          description: description.trim() || `Road safety monitoring project at ${locSummary}.`,
          startDate,
          status: 'active',
        });

        setBusyStep('Registering primary junction location...');
        const createdLoc = await createLocation({
          projectId: createdProj.id,
          name: junctionName.trim(),
          address: locSummary,
          city: city.trim() || 'Anand',
          state: stateName.trim() || 'Gujarat',
          country: 'India',
          latitude: 22.5645,
          longitude: 72.9289,
          locationType: 'Intersection',
          description: description.trim() || `Primary road junction for ${createdProj.name}.`,
        });

        setBusyStep('Attaching default road camera metadata...');
        const createdCam = await createCamera({
          projectId: createdProj.id,
          locationId: createdLoc.id,
          name: `CAM-${createdProj.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase() || 'ROAD'}-01`,
          cameraType: 'Fixed Traffic Camera',
          direction: 'Primary Junction View',
          resolution: '1920x1080',
          frameRate: 25,
          installationDate: startDate,
          status: 'Active',
          description: 'Default camera registered during project creation for uploaded footage analysis.',
          rtspAdapterEnabled: false,
        });

        projCtx = {
          projectId: createdProj.id,
          locationId: createdLoc.id,
          cameraId: createdCam.id,
        };
        setPendingProjectContext(projCtx);
      }

      // Optional initial video upload inside project creation
      let cvAnalysisFailedMessage: string | null = null;
      if (initialFile) {
        setBusyStep('Uploading and validating traffic video footage...');
        setUploadProgress(5);
        const uploadData = await uploadVideoWithProgress(initialFile, {
          isDemoMode,
          demoRole: currentUser.role,
          onProgress: setUploadProgress,
        });

        setBusyStep('Submitting video to CV processing service...');
        const videoId = sanitizeFirestoreId(`vid_${Date.now()}`);
        const jobResp = await roadshadowFetch('/api/processing/jobs', {
          method: 'POST',
          isDemoMode,
          demoRole: currentUser.role,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            videoId,
            projectId: projCtx.projectId,
            locationId: projCtx.locationId,
            fileUrl: uploadData.fileUrl,
            durationSec: uploadData.durationSec || 10,
            occurredAtIso: new Date().toISOString(),
          }),
        });
        if (!jobResp.ok) {
          const errJson = await jobResp.json().catch(() => ({}));
          throw new Error(errJson.error || 'Failed to start CV processing job.');
        }

        const { job: initialJob } = (await jobResp.json()) as { job: ProcessingJob };
        let currentJob: ProcessingJob & {
          resultPayload?: {
            detections: FrameDetection[];
            trajectories: TrackedTrajectory[];
            events: ConflictEvent[];
          };
        } = initialJob;

        while (currentJob.status === 'Queued' || currentJob.status === 'Processing') {
          await new Promise((r) => setTimeout(r, 400));
          const poll = await roadshadowFetch(`/api/processing/jobs/${initialJob.id}`, {
            isDemoMode,
            demoRole: currentUser.role,
          });
          if (!poll.ok) throw new Error('Lost connection while checking processing job.');
          const pollJson = await poll.json();
          currentJob = pollJson.job;
        }

        const nowIso = new Date().toISOString();
        const analysisSucceeded = currentJob.status === 'Completed';
        if (!analysisSucceeded) {
          cvAnalysisFailedMessage =
            currentJob.errorMessage ||
            'Automated CV service is unavailable. Video is saved in the project for playback and later retry.';
        }

        const newVideo: VideoRecord = {
          id: videoId,
          projectId: projCtx.projectId,
          locationId: projCtx.locationId,
          cameraId: projCtx.cameraId,
          ownerId: currentUser.uid,
          title: (() => {
            const derived = initialFile.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
            return derived.length >= 2 ? derived : `Traffic Clip ${derived || initialFile.name}`;
          })(),
          fileName: initialFile.name,
          mimeType: uploadData.mimeType,
          fileSizeBytes: uploadData.fileSizeBytes,
          fileUrl: uploadData.fileUrl,
          posterUrl: uploadData.posterUrl || undefined,
          recordingDate: startDate,
          recordingTime: '08:45',
          roadType: 'Intersection',
          description: `Initial footage uploaded during creation of ${name.trim() || 'project'}.`,
          durationSec: uploadData.durationSec || 0,
          width: uploadData.width ?? undefined,
          height: uploadData.height ?? undefined,
          fps: uploadData.fps ?? undefined,
          status: analysisSucceeded ? 'Completed' : 'Failed',
          errorMessage: analysisSucceeded ? undefined : cvAnalysisFailedMessage ?? undefined,
          isDemonstration: false,
          detections: analysisSucceeded ? currentJob.resultPayload?.detections || [] : [],
          trajectories: analysisSucceeded ? currentJob.resultPayload?.trajectories || [] : [],
          createdAt: nowIso,
          updatedAt: nowIso,
        };

        await registerUploadedVideoAndResults({
          video: newVideo,
          job: currentJob,
          events: analysisSucceeded ? currentJob.resultPayload?.events || [] : [],
        });
      }

      const finalId = projCtx.projectId;
      setSelectedProjectId(finalId);
      resetCreateForm();
      if (cvAnalysisFailedMessage) {
        pushToast({
          type: 'warning',
          title: 'Project & Video Saved — CV Service Unavailable',
          description: cvAnalysisFailedMessage,
        });
      } else {
        pushToast({
          type: 'success',
          title: 'Project Ready',
          description: 'Project saved, selected, and immediately available across all modules.',
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to save project or upload video.';
      setFormError(msg);
      pushToast({ type: 'error', title: 'Project Operation Error', description: msg });
    } finally {
      setBusyStep(null);
      submittingRef.current = false;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[#F5F8FC]">Project Management</h1>
          <p className="text-sm text-[#A9B8CA] mt-1">
            Create, search, select, and resume road-safety investigation projects with persistent footage and camera associations.
          </p>
        </div>

        <button
          type="button"
          disabled={!canManage}
          onClick={() => setShowCreateForm((v) => !v)}
          className="inline-flex items-center gap-2 px-4 py-2 bg-[#2585FF] hover:bg-[#1C74E8] disabled:opacity-50 text-white text-sm font-medium rounded-md transition-colors whitespace-nowrap shrink-0"
        >
          <Plus className="w-4 h-4" />
          New Project
        </button>
      </div>

      {/* Create New Project Drawer/Card */}
      {showCreateForm && (
        <form
          onSubmit={handleCreateProject}
          className="bg-[#122943] border border-[#2585FF]/50 rounded-lg p-5 space-y-5"
        >
          <div className="flex items-center justify-between gap-3 border-b border-[#233B56] pb-3">
            <div>
              <h2 className="text-base font-semibold text-[#F5F8FC]">
                {pendingProjectContext
                  ? 'Retry Initial Video Upload (Project Already Saved)'
                  : 'Create New Road Safety Project'}
              </h2>
              <p className="text-xs text-[#A9B8CA] mt-0.5">
                Assign a unique project record, road/junction location, and optional initial traffic clip.
              </p>
            </div>
            <button
              type="button"
              onClick={resetCreateForm}
              aria-label="Close project creation form"
              className="p-1.5 text-[#A9B8CA] hover:text-[#F5F8FC] rounded"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            <div className="lg:col-span-7 space-y-4">
              <div>
                <label htmlFor="new-proj-name" className="block text-xs font-medium text-[#A9B8CA] mb-1">
                  Project Name *
                </label>
                <input
                  id="new-proj-name"
                  type="text"
                  required
                  disabled={Boolean(pendingProjectContext)}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Vadodara Ring Road Junction Audit"
                  className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC] disabled:opacity-60"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-1">
                  <label htmlFor="new-proj-junction" className="block text-xs font-medium text-[#A9B8CA] mb-1">
                    Road / Junction Location *
                  </label>
                  <input
                    id="new-proj-junction"
                    type="text"
                    required
                    disabled={Boolean(pendingProjectContext)}
                    value={junctionName}
                    onChange={(e) => setJunctionName(e.target.value)}
                    placeholder="e.g. Genda Circle"
                    className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC] disabled:opacity-60"
                  />
                </div>
                <div>
                  <label htmlFor="new-proj-city" className="block text-xs font-medium text-[#A9B8CA] mb-1">
                    City
                  </label>
                  <input
                    id="new-proj-city"
                    type="text"
                    disabled={Boolean(pendingProjectContext)}
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC] disabled:opacity-60"
                  />
                </div>
                <div>
                  <label htmlFor="new-proj-state" className="block text-xs font-medium text-[#A9B8CA] mb-1">
                    State
                  </label>
                  <input
                    id="new-proj-state"
                    type="text"
                    disabled={Boolean(pendingProjectContext)}
                    value={stateName}
                    onChange={(e) => setStateName(e.target.value)}
                    className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC] disabled:opacity-60"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="new-proj-date" className="block text-xs font-medium text-[#A9B8CA] mb-1">
                    Study Start Date
                  </label>
                  <input
                    id="new-proj-date"
                    type="date"
                    disabled={Boolean(pendingProjectContext)}
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm font-mono text-[#F5F8FC] disabled:opacity-60"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="new-proj-desc" className="block text-xs font-medium text-[#A9B8CA] mb-1">
                  Project Description
                </label>
                <textarea
                  id="new-proj-desc"
                  rows={3}
                  disabled={Boolean(pendingProjectContext)}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Scope, peak traffic hours, pedestrian concerns, and municipal study goals..."
                  className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC] disabled:opacity-60"
                />
              </div>
            </div>

            <div className="lg:col-span-5 bg-[#0D1F35] border border-[#233B56] rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-[#F5F8FC]">
                  Optional Initial Traffic Footage
                </p>
                <span className="text-[11px] font-mono text-[#A9B8CA]">MP4 / MOV / WebM</span>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept=".mp4,.mov,.webm,video/mp4,video/quicktime,video/webm"
                onChange={(e) => handleFileChange(e.target.files?.[0] ?? null)}
                className="sr-only"
                id="new-proj-video-input"
              />

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="px-3 py-1.5 bg-[#122943] hover:bg-[#1A3758] border border-[#233B56] rounded-md text-xs text-[#F5F8FC]"
                >
                  Choose Video File
                </button>
                <button
                  type="button"
                  disabled={sampleLoading}
                  onClick={() => void attachSampleVideo()}
                  className="px-3 py-1.5 bg-[#071426] hover:bg-[#122943] disabled:opacity-50 border border-[#2585FF]/40 rounded-md text-xs text-[#45B5FF]"
                >
                  {sampleLoading ? 'Loading Sample MP4...' : 'Attach Demo Sample Clip (.mp4)'}
                </button>
              </div>

              {initialFile ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs bg-[#122943] p-2.5 rounded border border-[#233B56]">
                    <div className="flex items-center gap-2 min-w-0">
                      <FileVideo className="w-4 h-4 text-[#45B5FF] shrink-0" />
                      <span className="text-[#F5F8FC] truncate">{initialFile.name}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setInitialFile(null)}
                      className="text-[#A9B8CA] hover:text-[#E5484D] ml-2 shrink-0"
                    >
                      Remove
                    </button>
                  </div>
                  {previewUrl && (
                    <video
                      src={previewUrl}
                      controls
                      muted
                      className="w-full h-32 rounded bg-[#071426] object-contain border border-[#233B56]"
                    />
                  )}
                </div>
              ) : (
                <p className="text-xs text-[#A9B8CA] leading-relaxed">
                  You can attach a traffic video now or upload additional videos later from the Project Workspace or Upload Centre.
                </p>
              )}

              {busyStep && (
                <div className="space-y-1.5 pt-2 border-t border-[#233B56]">
                  <div className="flex items-center gap-2 text-xs text-[#45B5FF]">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>{busyStep}</span>
                  </div>
                  {uploadProgress > 0 && (
                    <div className="w-full h-1.5 bg-[#071426] rounded overflow-hidden">
                      <div
                        className="h-full bg-[#2585FF] transition-all"
                        style={{ width: `${uploadProgress}%` }}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {formError && (
            <div role="alert" className="p-3 rounded-md bg-[#E5484D]/10 border border-[#E5484D]/40 text-xs text-[#F5F8FC] flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-[#E5484D] shrink-0 mt-0.5" />
              <span>{formError}</span>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-[#233B56]">
            <button
              type="button"
              onClick={resetCreateForm}
              className="px-4 py-2 bg-[#0D1F35] border border-[#233B56] text-xs font-medium text-[#A9B8CA] hover:text-[#F5F8FC] rounded-md"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={Boolean(busyStep)}
              className="inline-flex items-center gap-2 px-4 py-2 bg-[#2585FF] hover:bg-[#1C74E8] disabled:opacity-50 text-white text-sm font-medium rounded-md"
            >
              {pendingProjectContext ? (
                <>
                  <RefreshCw className="w-4 h-4" />
                  Retry Video Upload
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-4 h-4" />
                  Save &amp; Select Project
                </>
              )}
            </button>
          </div>
        </form>
      )}

      {/* Search & Filter Tabs */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-[#122943] border border-[#233B56] rounded-lg p-3">
        <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="Project filter tabs">
          {(
            [
              { id: 'recent', label: 'Recent Projects' },
              { id: 'all', label: `All Projects (${projects.length})` },
              { id: 'active', label: 'Active' },
              { id: 'archived', label: 'Archived' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={filterTab === tab.id}
              onClick={() => setFilterTab(tab.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                filterTab === tab.id
                  ? 'bg-[#2585FF] text-white'
                  : 'text-[#A9B8CA] hover:text-[#F5F8FC] hover:bg-[#0D1F35]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="relative w-full sm:w-72">
          <Search className="w-4 h-4 text-[#A9B8CA] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by name, junction, or ID..."
            aria-label="Search projects"
            className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md pl-9 pr-3 py-1.5 text-xs text-[#F5F8FC] placeholder:text-[#A9B8CA]/60"
          />
        </div>
      </div>

      {/* Active Selection Summary */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 rounded-lg bg-[#0D1F35] border border-[#233B56] text-xs">
        <div className="flex items-center gap-2 text-[#A9B8CA]">
          <FolderKanban className="w-4 h-4 text-[#45B5FF]" />
          <span>Active Workspace Scope:</span>
          <strong className="text-[#F5F8FC]">
            {selectedProjectId === 'ALL'
              ? `All Projects (${projects.length})`
              : projects.find((p) => p.id === selectedProjectId)?.name || selectedProjectId}
          </strong>
        </div>
        {selectedProjectId !== 'ALL' && (
          <button
            type="button"
            onClick={() => setSelectedProjectId('ALL')}
            className="text-[#45B5FF] hover:underline"
          >
            View All Projects
          </button>
        )}
      </div>

      {/* Project Cards Grid */}
      {paginatedProjects.length === 0 ? (
        <div className="bg-[#122943] border border-[#233B56] rounded-lg p-10 text-center space-y-3">
          <p className="text-sm font-medium text-[#F5F8FC]">No matching projects found</p>
          <p className="text-xs text-[#A9B8CA]">
            Adjust your search filter or create a new road-safety project to begin uploading footage.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {paginatedProjects.map((proj) => {
            const isSelected = selectedProjectId === proj.id;
            const statusColor =
              proj.processingStatus === 'Completed'
                ? 'text-[#22C55E]'
                : proj.processingStatus === 'Processing'
                  ? 'text-[#45B5FF]'
                  : proj.processingStatus === 'Failed'
                    ? 'text-[#E5484D]'
                    : 'text-[#A9B8CA]';

            return (
              <article
                key={proj.id}
                data-testid={`project-card-${proj.id}`}
                className={`bg-[#122943] rounded-lg p-5 flex flex-col justify-between gap-4 border transition-colors ${
                  isSelected
                    ? 'border-[#2585FF] ring-1 ring-[#2585FF]/40'
                    : 'border-[#233B56] hover:border-[#2585FF]/50'
                }`}
              >
                <div className="space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-[11px] font-mono text-[#A9B8CA] truncate">
                        ID: {proj.id}
                      </p>
                      <h3 className="text-base font-semibold text-[#F5F8FC] mt-0.5 leading-snug">
                        {proj.name}
                      </h3>
                    </div>
                    {isSelected ? (
                      <span className="text-[11px] font-semibold text-[#45B5FF] bg-[#2585FF]/15 border border-[#2585FF]/40 px-2 py-0.5 rounded shrink-0">
                        Selected
                      </span>
                    ) : (
                      <span className="text-[11px] font-mono text-[#A9B8CA] uppercase shrink-0">
                        {proj.status}
                      </span>
                    )}
                  </div>

                  <div className="flex items-start gap-1.5 text-xs text-[#A9B8CA]">
                    <MapPin className="w-3.5 h-3.5 text-[#45B5FF] shrink-0 mt-0.5" />
                    <span className="line-clamp-2">{proj.locationText}</span>
                  </div>

                  <p className="text-xs text-[#A9B8CA] line-clamp-2 leading-relaxed">
                    {proj.description}
                  </p>

                  <div className="grid grid-cols-3 gap-2 pt-2 border-t border-[#233B56] text-xs">
                    <div>
                      <p className="text-[11px] text-[#A9B8CA]">Videos</p>
                      <p className="font-mono tabular-nums font-semibold text-[#F5F8FC] flex items-center gap-1 mt-0.5">
                        <Video className="w-3 h-3 text-[#45B5FF]" />
                        {proj.videoCount}
                      </p>
                    </div>
                    <div>
                      <p className="text-[11px] text-[#A9B8CA]">Conflicts</p>
                      <p className="font-mono tabular-nums font-semibold text-[#F5F8FC] mt-0.5">
                        {proj.eventCount}
                      </p>
                    </div>
                    <div>
                      <p className="text-[11px] text-[#A9B8CA]">Status</p>
                      <p className={`font-medium mt-0.5 truncate ${statusColor}`}>
                        {proj.processingStatus}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 text-[11px] font-mono text-[#A9B8CA]">
                    <Calendar className="w-3 h-3" />
                    <span>Created {proj.createdAt.slice(0, 10)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{proj.cameraCount} camera(s)</span>
                  </div>
                </div>

                <div className="pt-3 border-t border-[#233B56] flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedProjectId(proj.id);
                      pushToast({
                        type: 'info',
                        title: 'Project Selected',
                        description: `Workspace switched to ${proj.name}.`,
                      });
                    }}
                    className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                      isSelected
                        ? 'bg-[#0D1F35] border border-[#2585FF] text-[#45B5FF]'
                        : 'bg-[#2585FF] hover:bg-[#1C74E8] text-white'
                    }`}
                  >
                    {isSelected ? 'Active Project' : 'Select Project'}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setSelectedProjectId(proj.id);
                      navigate(`/projects/${proj.id}`);
                    }}
                    className="inline-flex items-center gap-1 px-3 py-1.5 bg-[#0D1F35] hover:bg-[#173252] border border-[#233B56] text-xs font-medium text-[#F5F8FC] rounded-md whitespace-nowrap"
                  >
                    Open
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>

                  <button
                    type="button"
                    title="Open Project Dashboard"
                    aria-label={`Open dashboard for ${proj.name}`}
                    onClick={() => {
                      setSelectedProjectId(proj.id);
                      navigate('/');
                    }}
                    className="p-1.5 bg-[#0D1F35] border border-[#233B56] hover:border-[#2585FF] text-[#A9B8CA] hover:text-[#F5F8FC] rounded-md"
                  >
                    <LayoutDashboard className="w-3.5 h-3.5" />
                  </button>

                  <button
                    type="button"
                    title="Upload Video to Project"
                    aria-label={`Upload video to ${proj.name}`}
                    onClick={() => {
                      setSelectedProjectId(proj.id);
                      navigate(`/upload?projectId=${proj.id}`);
                    }}
                    className="p-1.5 bg-[#0D1F35] border border-[#233B56] hover:border-[#2585FF] text-[#A9B8CA] hover:text-[#F5F8FC] rounded-md"
                  >
                    <Upload className="w-3.5 h-3.5" />
                  </button>

                  {canManage && (
                    <button
                      type="button"
                      title="Edit Project"
                      aria-label={`Edit ${proj.name}`}
                      onClick={() => openEditModal(proj)}
                      className="p-1.5 bg-[#0D1F35] border border-[#233B56] hover:border-[#2585FF] text-[#A9B8CA] hover:text-[#F5F8FC] rounded-md"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  )}

                  {canManage && (
                    <button
                      type="button"
                      title="Delete Project"
                      aria-label={`Delete ${proj.name}`}
                      onClick={() => setDeleteId(proj.id)}
                      className="p-1.5 text-[#A9B8CA] hover:text-[#E5484D] rounded-md hover:bg-[#0D1F35]"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-2 text-xs text-[#A9B8CA]">
          <span>
            Showing {(safePage - 1) * PAGE_SIZE + 1}–
            {Math.min(safePage * PAGE_SIZE, filteredProjects.length)} of {filteredProjects.length} projects
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={safePage <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="px-3 py-1 bg-[#122943] border border-[#233B56] rounded disabled:opacity-40 text-[#F5F8FC]"
            >
              Previous
            </button>
            <span className="font-mono tabular-nums text-[#F5F8FC]">
              {safePage} / {totalPages}
            </span>
            <button
              type="button"
              disabled={safePage >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="px-3 py-1 bg-[#122943] border border-[#233B56] rounded disabled:opacity-40 text-[#F5F8FC]"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {/* Inline Edit Project Modal */}
      {editingProject && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="edit-project-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
        >
          <form
            onSubmit={(e) => void handleSaveEdit(e)}
            className="w-full max-w-lg bg-[#122943] border border-[#2585FF]/60 rounded-lg p-5 space-y-4 shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-[#233B56] pb-3">
              <h2 id="edit-project-title" className="text-base font-semibold text-[#F5F8FC]">
                Edit Project Details
              </h2>
              <button
                type="button"
                onClick={() => setEditingProject(null)}
                aria-label="Close edit project dialog"
                className="p-1 text-[#A9B8CA] hover:text-[#F5F8FC]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div>
              <label htmlFor="edit-proj-name" className="block text-xs text-[#A9B8CA] mb-1">
                Project Name *
              </label>
              <input
                id="edit-proj-name"
                type="text"
                required
                minLength={2}
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC]"
              />
            </div>

            <div>
              <label htmlFor="edit-proj-loc" className="block text-xs text-[#A9B8CA] mb-1">
                Corridor / Junction Summary
              </label>
              <input
                id="edit-proj-loc"
                type="text"
                value={editLocationSummary}
                onChange={(e) => setEditLocationSummary(e.target.value)}
                className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC]"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="edit-proj-date" className="block text-xs text-[#A9B8CA] mb-1">
                  Start Date
                </label>
                <input
                  id="edit-proj-date"
                  type="date"
                  value={editStartDate}
                  onChange={(e) => setEditStartDate(e.target.value)}
                  className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm font-mono text-[#F5F8FC]"
                />
              </div>
              <div>
                <label htmlFor="edit-proj-status" className="block text-xs text-[#A9B8CA] mb-1">
                  Project Status
                </label>
                <select
                  id="edit-proj-status"
                  value={editStatus}
                  onChange={(e) => setEditStatus(e.target.value as 'active' | 'archived')}
                  className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC]"
                >
                  <option value="active">Active</option>
                  <option value="archived">Archived</option>
                </select>
              </div>
            </div>

            <div>
              <label htmlFor="edit-proj-desc" className="block text-xs text-[#A9B8CA] mb-1">
                Description
              </label>
              <textarea
                id="edit-proj-desc"
                rows={3}
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC]"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-[#233B56]">
              <button
                type="button"
                onClick={() => setEditingProject(null)}
                className="px-3.5 py-2 bg-[#0D1F35] border border-[#233B56] text-xs text-[#A9B8CA] rounded-md"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={editSaving}
                className="px-4 py-2 bg-[#2585FF] hover:bg-[#1C74E8] disabled:opacity-50 text-white text-xs font-medium rounded-md"
              >
                {editSaving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </form>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(deleteId)}
        title="Delete Road Safety Project?"
        description="This permanently removes the project and its strictly scoped locations, cameras, uploaded video records, recommendations, and reports."
        confirmLabel="Delete Project"
        destructive
        onCancel={() => setDeleteId(null)}
        onConfirm={async () => {
          if (deleteId) {
            await deleteProject(deleteId);
            setDeleteId(null);
          }
        }}
      />
    </div>
  );
}
