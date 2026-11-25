import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AlertCircle,
  ArrowLeft,
  Camera,
  FileText,
  FlaskConical,
  LayoutDashboard,
  Loader2,
  MapPin,
  Pencil,
  Play,
  RefreshCw,
  Trash2,
  Upload,
  Video,
  X,
} from 'lucide-react';
import { useRoadshadow } from '../context/RoadshadowContext';
import { RiskIndicator } from '../components/RiskBadge';
import { ConfirmDialog } from '../components/ToastContainer';
import { canPerformAction } from '../engine/validation';

export function ProjectDetailPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const {
    currentUser,
    projects,
    locations,
    cameras,
    videos,
    processingJobs,
    conflictEvents,
    conflictFingerprints,
    selectedProjectId,
    setSelectedProjectId,
    selectedSourceByProject,
    updateProject,
    deleteVideo,
    retryVideoAnalysis,
  } = useRoadshadow();

  const canManage = currentUser ? canPerformAction(currentUser.role, 'manage_projects') : false;

  const project = useMemo(
    () => projects.find((p) => p.id === projectId) ?? null,
    [projects, projectId]
  );

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editLocationSummary, setEditLocationSummary] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editStartDate, setEditStartDate] = useState('');
  const [editStatus, setEditStatus] = useState<'active' | 'archived'>('active');
  const [savingEdit, setSavingEdit] = useState(false);
  const [retryingVideoId, setRetryingVideoId] = useState<string | null>(null);
  const [deleteVideoId, setDeleteVideoId] = useState<string | null>(null);

  // Opening a project detail page immediately selects that project in global workspace context
  useEffect(() => {
    if (project && selectedProjectId !== project.id) {
      setSelectedProjectId(project.id);
    }
  }, [project, selectedProjectId, setSelectedProjectId]);

  const startEditing = () => {
    if (!project) return;
    setEditName(project.name);
    setEditLocationSummary(project.locationSummary || '');
    setEditDescription(project.description);
    setEditStartDate(project.startDate);
    setEditStatus(project.status);
    setEditing(true);
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!project || editName.trim().length < 2) return;
    setSavingEdit(true);
    try {
      await updateProject(project.id, {
        name: editName.trim(),
        locationSummary: editLocationSummary.trim() || undefined,
        description: editDescription.trim(),
        startDate: editStartDate,
        status: editStatus,
      });
      setEditing(false);
    } finally {
      setSavingEdit(false);
    }
  };

  if (!project) {
    return (
      <div className="bg-[#122943] border border-[#233B56] rounded-lg p-10 text-center max-w-xl mx-auto space-y-3">
        <h1 className="text-lg font-semibold text-[#F5F8FC]">Project Not Found</h1>
        <p className="text-sm text-[#A9B8CA]">
          The requested project ID could not be located in the current workspace.
        </p>
        <button
          type="button"
          onClick={() => navigate('/projects')}
          className="inline-flex items-center gap-2 px-4 py-2 bg-[#2585FF] hover:bg-[#1C74E8] text-white text-sm font-medium rounded-md"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Projects
        </button>
      </div>
    );
  }

  const projectLocations = locations.filter((l) => l.projectId === project.id);
  const projectCameras = cameras.filter((c) => c.projectId === project.id);
  const projectVideos = videos.filter((v) => v.projectId === project.id);
  const projectJobs = processingJobs.filter((j) => j.projectId === project.id);
  const projectEvents = conflictEvents.filter(
    (e) => e.projectId === project.id && e.validationStatus !== 'False positive'
  );
  const projectFingerprints = conflictFingerprints.filter((f) => f.projectId === project.id);
  const rememberedSource = selectedSourceByProject[project.id];

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
        <div className="space-y-1">
          <button
            type="button"
            onClick={() => navigate('/projects')}
            className="inline-flex items-center gap-1.5 text-xs text-[#45B5FF] hover:underline mb-1"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            All Projects
          </button>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold text-[#F5F8FC]">{project.name}</h1>
            <span className="text-xs font-mono text-[#A9B8CA] bg-[#122943] border border-[#233B56] px-2 py-0.5 rounded">
              {project.id}
            </span>
          </div>
          <p className="text-sm text-[#A9B8CA] flex items-center gap-1.5">
            <MapPin className="w-4 h-4 text-[#45B5FF] shrink-0" />
            <span>
              {project.locationSummary ||
                projectLocations.map((l) => `${l.name} (${l.city})`).join(' · ') ||
                'No location linked yet'}
            </span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canManage && (
            <button
              type="button"
              onClick={startEditing}
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-[#122943] hover:bg-[#1A3758] border border-[#233B56] text-[#F5F8FC] text-xs sm:text-sm font-medium rounded-md whitespace-nowrap"
            >
              <Pencil className="w-3.5 h-3.5 text-[#45B5FF]" />
              Edit Project
            </button>
          )}
          <button
            type="button"
            onClick={() => navigate(`/upload?projectId=${project.id}`)}
            className="inline-flex items-center gap-2 px-3.5 py-2 bg-[#2585FF] hover:bg-[#1C74E8] text-white text-xs sm:text-sm font-medium rounded-md whitespace-nowrap"
          >
            <Upload className="w-4 h-4" />
            Upload Additional Video
          </button>
          <button
            type="button"
            onClick={() => navigate('/')}
            className="inline-flex items-center gap-2 px-3.5 py-2 bg-[#122943] hover:bg-[#1A3758] border border-[#233B56] text-[#F5F8FC] text-xs sm:text-sm font-medium rounded-md whitespace-nowrap"
          >
            <LayoutDashboard className="w-4 h-4 text-[#45B5FF]" />
            Dashboard
          </button>
          <button
            type="button"
            onClick={() => navigate('/improvement-lab')}
            className="inline-flex items-center gap-2 px-3.5 py-2 bg-[#122943] hover:bg-[#1A3758] border border-[#233B56] text-[#F5F8FC] text-xs sm:text-sm font-medium rounded-md whitespace-nowrap"
          >
            <FlaskConical className="w-4 h-4 text-[#45B5FF]" />
            Improvement Lab
          </button>
          <button
            type="button"
            onClick={() => navigate('/reports')}
            className="inline-flex items-center gap-2 px-3.5 py-2 bg-[#122943] hover:bg-[#1A3758] border border-[#233B56] text-[#F5F8FC] text-xs sm:text-sm font-medium rounded-md whitespace-nowrap"
          >
            <FileText className="w-4 h-4 text-[#45B5FF]" />
            Reports
          </button>
        </div>
      </div>

      {/* Inline Edit Project Panel */}
      {editing && (
        <form
          onSubmit={(e) => void handleSaveEdit(e)}
          className="bg-[#122943] border border-[#2585FF]/60 rounded-lg p-5 space-y-4"
        >
          <div className="flex items-center justify-between border-b border-[#233B56] pb-3">
            <h2 className="text-sm font-semibold text-[#F5F8FC]">Edit Project Metadata</h2>
            <button
              type="button"
              onClick={() => setEditing(false)}
              aria-label="Cancel editing project"
              className="p-1 text-[#A9B8CA] hover:text-[#F5F8FC]"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="detail-edit-name" className="block text-xs text-[#A9B8CA] mb-1">
                Project Name *
              </label>
              <input
                id="detail-edit-name"
                type="text"
                required
                minLength={2}
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC]"
              />
            </div>
            <div>
              <label htmlFor="detail-edit-loc" className="block text-xs text-[#A9B8CA] mb-1">
                Location / Corridor Summary
              </label>
              <input
                id="detail-edit-loc"
                type="text"
                value={editLocationSummary}
                onChange={(e) => setEditLocationSummary(e.target.value)}
                className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC]"
              />
            </div>
            <div>
              <label htmlFor="detail-edit-date" className="block text-xs text-[#A9B8CA] mb-1">
                Study Start Date
              </label>
              <input
                id="detail-edit-date"
                type="date"
                value={editStartDate}
                onChange={(e) => setEditStartDate(e.target.value)}
                className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm font-mono text-[#F5F8FC]"
              />
            </div>
            <div>
              <label htmlFor="detail-edit-status" className="block text-xs text-[#A9B8CA] mb-1">
                Status
              </label>
              <select
                id="detail-edit-status"
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
            <label htmlFor="detail-edit-desc" className="block text-xs text-[#A9B8CA] mb-1">
              Description
            </label>
            <textarea
              id="detail-edit-desc"
              rows={2}
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC]"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="px-3 py-1.5 bg-[#0D1F35] border border-[#233B56] text-xs text-[#A9B8CA] rounded-md"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={savingEdit}
              className="px-4 py-1.5 bg-[#2585FF] hover:bg-[#1C74E8] disabled:opacity-50 text-white text-xs font-medium rounded-md"
            >
              {savingEdit ? 'Saving...' : 'Save Project Changes'}
            </button>
          </div>
        </form>
      )}

      {/* KPI Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <div className="bg-[#122943] border border-[#233B56] rounded-lg p-4">
          <p className="text-xs text-[#A9B8CA]">Uploaded Videos</p>
          <p className="text-2xl font-bold font-mono tabular-nums text-[#F5F8FC] mt-1">
            {projectVideos.length}
          </p>
        </div>
        <div className="bg-[#122943] border border-[#233B56] rounded-lg p-4">
          <p className="text-xs text-[#A9B8CA]">Monitored Locations</p>
          <p className="text-2xl font-bold font-mono tabular-nums text-[#F5F8FC] mt-1">
            {projectLocations.length}
          </p>
        </div>
        <div className="bg-[#122943] border border-[#233B56] rounded-lg p-4">
          <p className="text-xs text-[#A9B8CA]">Registered Cameras</p>
          <p className="text-2xl font-bold font-mono tabular-nums text-[#F5F8FC] mt-1">
            {projectCameras.length}
          </p>
        </div>
        <div className="bg-[#122943] border border-[#233B56] rounded-lg p-4">
          <p className="text-xs text-[#A9B8CA]">Detected Conflicts</p>
          <p className="text-2xl font-bold font-mono tabular-nums text-[#F5F8FC] mt-1">
            {projectEvents.length}
          </p>
        </div>
        <div className="bg-[#122943] border border-[#233B56] rounded-lg p-4">
          <p className="text-xs text-[#A9B8CA]">Conflict Fingerprints</p>
          <p className="text-2xl font-bold font-mono tabular-nums text-[#45B5FF] mt-1">
            {projectFingerprints.length}
          </p>
        </div>
      </div>

      {/* Project Description + Remembered Road Camera */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-7 bg-[#122943] border border-[#233B56] rounded-lg p-5 space-y-3">
          <h2 className="text-base font-semibold text-[#F5F8FC]">Project Overview</h2>
          <p className="text-sm text-[#A9B8CA] leading-relaxed">{project.description}</p>
          <div className="pt-3 border-t border-[#233B56] flex flex-wrap gap-4 text-xs font-mono text-[#A9B8CA]">
            <span>Start Date: {project.startDate}</span>
            <span>Created: {project.createdAt.slice(0, 10)}</span>
            <span>Status: {project.status.toUpperCase()}</span>
          </div>
        </div>

        <div className="lg:col-span-5 bg-[#122943] border border-[#233B56] rounded-lg p-5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-semibold text-[#F5F8FC] flex items-center gap-2">
              <Camera className="w-4 h-4 text-[#45B5FF]" />
              Selected Camera / Footage Source
            </h2>
            <button
              type="button"
              onClick={() => navigate('/cameras')}
              className="text-xs text-[#45B5FF] hover:underline"
            >
              Change Source
            </button>
          </div>
          {rememberedSource ? (
            <div className="p-3 rounded-md bg-[#0D1F35] border border-[#2585FF]/40 space-y-1.5 text-xs">
              <p className="font-semibold text-[#F5F8FC]">{rememberedSource.label}</p>
              <p className="text-[#A9B8CA]">{rememberedSource.locationName}</p>
              <p className="font-mono text-[#45B5FF]">
                Mode: {rememberedSource.sourceMode.replace('_', ' ')} · Status: {rememberedSource.status}
              </p>
            </div>
          ) : (
            <div className="p-3 rounded-md bg-[#0D1F35] border border-[#233B56] text-xs text-[#A9B8CA]">
              No active camera or demo feed pinned for this project yet. Open Camera Selection to choose a road camera, uploaded clip, or demo feed.
            </div>
          )}
        </div>
      </div>

      {/* Uploaded Videos List */}
      <section className="bg-[#122943] border border-[#233B56] rounded-lg overflow-hidden">
        <div className="p-5 border-b border-[#233B56] flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-[#F5F8FC]">
              Uploaded Project Videos ({projectVideos.length})
            </h2>
            <p className="text-xs text-[#A9B8CA]">
              All previously uploaded clips linked to this project remain available for playback, retry analysis, and conflict inspection.
            </p>
          </div>
          <button
            type="button"
            onClick={() => navigate(`/upload?projectId=${project.id}`)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#0D1F35] border border-[#2585FF]/50 text-[#45B5FF] text-xs font-medium rounded-md hover:bg-[#173252]"
          >
            <Upload className="w-3.5 h-3.5" />
            Add Another Video
          </button>
        </div>

        {projectVideos.length === 0 ? (
          <div className="p-8 text-center text-sm text-[#A9B8CA]">
            No videos uploaded to this project yet. Click &ldquo;Upload Additional Video&rdquo; to attach traffic footage.
          </div>
        ) : (
          <div className="divide-y divide-[#233B56]">
            {projectVideos.map((vid) => {
              const loc = projectLocations.find((l) => l.id === vid.locationId);
              const cam = projectCameras.find((c) => c.id === vid.cameraId);
              const vidEvents = projectEvents.filter((e) => e.videoId === vid.id);
              const job = projectJobs.find((j) => j.videoId === vid.id);
              const isRetrying = retryingVideoId === vid.id;
              const statusTone =
                vid.status === 'Completed'
                  ? 'text-[#22C55E]'
                  : vid.status === 'Failed'
                    ? 'text-[#E5484D]'
                    : 'text-[#45B5FF]';

              return (
                <div
                  key={vid.id}
                  data-testid={`project-video-row-${vid.id}`}
                  className="p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4 hover:bg-[#0D1F35]/50 transition-colors"
                >
                  <div className="flex items-start gap-3 min-w-0">
                    {vid.posterUrl ? (
                      <img
                        src={vid.posterUrl}
                        alt={vid.title}
                        referrerPolicy="no-referrer"
                        className="w-24 h-14 rounded object-cover border border-[#233B56] shrink-0 bg-[#071426]"
                      />
                    ) : (
                      <div className="w-24 h-14 rounded bg-[#071426] border border-[#233B56] flex items-center justify-center shrink-0">
                        <Video className="w-5 h-5 text-[#45B5FF]" />
                      </div>
                    )}
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold text-[#F5F8FC] truncate">{vid.title}</p>
                        {vid.isDemonstration && (
                          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#2585FF]/15 border border-[#2585FF]/40 text-[#45B5FF]">
                            DEMO
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-[#A9B8CA] mt-0.5 truncate">
                        {loc?.name || vid.locationId} · {cam?.name || vid.cameraId}
                      </p>
                      <p className="text-[11px] font-mono text-[#A9B8CA] mt-1">
                        {vid.fileName} · {(vid.fileSizeBytes / (1024 * 1024)).toFixed(2)} MB
                        {vid.width && vid.height ? ` · ${vid.width}x${vid.height}` : ''}
                        {vid.fps ? ` · ${vid.fps} fps` : ''}
                        {vid.durationSec ? ` · ${vid.durationSec}s` : ''} ·{' '}
                        <span className={statusTone}>{vid.status}</span> · {vidEvents.length} conflict(s)
                        {job ? ` · ${job.engineMode}` : ''}
                      </p>
                      {vid.status === 'Failed' && (vid.errorMessage || job?.errorMessage) && (
                        <p className="text-[11px] text-[#EAB308] mt-1 flex items-start gap-1.5">
                          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                          <span>{vid.errorMessage || job?.errorMessage}</span>
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0 self-start lg:self-center">
                    {!vid.isDemonstration && canManage && vid.status === 'Failed' && (
                      <button
                        type="button"
                        disabled={isRetrying}
                        onClick={async () => {
                          setRetryingVideoId(vid.id);
                          try {
                            await retryVideoAnalysis(vid.id);
                          } finally {
                            setRetryingVideoId(null);
                          }
                        }}
                        className="inline-flex items-center gap-1.5 px-3 py-2 bg-[#0D1F35] hover:bg-[#173252] border border-[#2585FF]/50 disabled:opacity-50 text-[#45B5FF] text-xs font-medium rounded-md whitespace-nowrap"
                      >
                        {isRetrying ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="w-3.5 h-3.5" />
                        )}
                        Retry Analysis
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => navigate(`/video-analysis/${vid.id}`)}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-[#2585FF] hover:bg-[#1C74E8] text-white text-xs font-medium rounded-md whitespace-nowrap"
                    >
                      <Play className="w-3.5 h-3.5" />
                      {vid.status === 'Completed' ? 'Inspect Analysis' : 'Open Video Player'}
                    </button>

                    {canManage && (
                      <button
                        type="button"
                        onClick={() => setDeleteVideoId(vid.id)}
                        aria-label={`Remove video ${vid.title}`}
                        className="p-2 text-[#A9B8CA] hover:text-[#E5484D] rounded-md hover:bg-[#0D1F35]"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Recent Project Conflicts */}
      {projectEvents.length > 0 && (
        <section className="bg-[#122943] border border-[#233B56] rounded-lg p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-[#F5F8FC]">Recent Conflict Events</h2>
            <button
              type="button"
              onClick={() => navigate('/events')}
              className="text-xs text-[#45B5FF] hover:underline"
            >
              Open Full Review Queue
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {projectEvents.slice(0, 6).map((ev) => (
              <button
                key={ev.id}
                type="button"
                onClick={() => navigate(`/events?eventId=${ev.id}`)}
                className="text-left p-3.5 rounded-md bg-[#0D1F35] border border-[#233B56] hover:border-[#2585FF]/60 transition-colors space-y-1.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <RiskIndicator category={ev.riskCategory} score={ev.riskScore} compact />
                  <span className="text-[11px] font-mono text-[#A9B8CA]">
                    {ev.interactionTier || 'Potential conflict'}
                  </span>
                </div>
                <p className="text-sm font-medium text-[#F5F8FC] truncate">{ev.conflictType}</p>
                <p className="text-xs text-[#A9B8CA] truncate">
                  TTC: {ev.estimatedTtcSec !== null ? `${ev.estimatedTtcSec}s` : 'N/A'} · PET:{' '}
                  {ev.estimatedPetSec !== undefined && ev.estimatedPetSec !== null
                    ? `${ev.estimatedPetSec}s`
                    : 'N/A'}
                </p>
              </button>
            ))}
          </div>
        </section>
      )}

      <ConfirmDialog
        open={Boolean(deleteVideoId)}
        title="Remove Uploaded Video?"
        description="This permanently removes the uploaded video record, its stored media file, processing jobs, and any conflict events linked exclusively to this video."
        confirmLabel="Remove Video"
        destructive
        onCancel={() => setDeleteVideoId(null)}
        onConfirm={async () => {
          if (deleteVideoId) {
            await deleteVideo(deleteVideoId);
            setDeleteVideoId(null);
          }
        }}
      />
    </div>
  );
}
