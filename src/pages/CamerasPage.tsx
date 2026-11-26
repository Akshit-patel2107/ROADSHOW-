import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  Camera as CameraIcon,
  CheckCircle2,
  FileVideo,
  Play,
  PlaySquare,
  Plus,
  Radio,
  ShieldCheck,
  Trash2,
  Upload,
} from 'lucide-react';
import { useRoadshadow } from '../context/RoadshadowContext';
import { canPerformAction } from '../engine/validation';
import { ConfirmDialog } from '../components/ToastContainer';
import { DEMO_IMAGES } from '../data/demoDataset';
import { roadshadowFetch } from '../lib/apiClient';
import type { ActiveCameraSource, Camera, CameraStatus } from '../types/roadshadow';

const CAMERA_STATUSES: CameraStatus[] = [
  'Active',
  'Inactive',
  'Offline',
  'Maintenance',
  'Not connected',
];

type SourceTab = 'registered' | 'uploaded' | 'rtsp' | 'demo';

interface DemoCameraPreset {
  id: string;
  name: string;
  locationName: string;
  videoId: string;
  previewUrl: string;
  description: string;
}

const DEMO_CAMERA_PRESETS: DemoCameraPreset[] = [
  {
    id: 'demo_cam_townhall',
    name: 'DEMO-CAM-01 · Sardar Patel Town Hall Junction',
    locationName: 'Station Road & Sardar Patel Marg, Anand',
    videoId: 'vid_anand_th_01',
    previewUrl: DEMO_IMAGES.intersection,
    description: 'Four-arm urban signalized intersection with dense two-wheeler and turning car flows.',
  },
  {
    id: 'demo_cam_school',
    name: "DEMO-CAM-02 · St. Mary's School Zebra Crossing",
    locationName: 'Vidya Dairy Road, School Zone, Anand',
    videoId: 'vid_school_02',
    previewUrl: DEMO_IMAGES.schoolZone,
    description: 'Morning student drop-off crosswalk monitoring vulnerable pedestrian interactions.',
  },
  {
    id: 'demo_cam_highway',
    name: 'DEMO-CAM-03 · Chikhodra NH-48 Merge Ramp',
    locationName: 'NH-48 Feeder Junction, Chikhodra',
    videoId: 'vid_highway_03',
    previewUrl: DEMO_IMAGES.highwayMerge,
    description: 'Highway gantry perspective tracking heavy truck, bus, and motorcycle merging.',
  },
];

function isCameraUsableForAnalysis(status: CameraStatus): {
  usable: boolean;
  reason?: string;
} {
  if (status === 'Active') {
    return { usable: true };
  }
  if (status === 'Offline') {
    return {
      usable: false,
      reason: 'Selected camera is Offline. Switch to an Active camera, Uploaded Footage, or Demo Camera Mode.',
    };
  }
  if (status === 'Maintenance') {
    return {
      usable: false,
      reason: 'Selected camera is currently under Maintenance and cannot start live or scheduled analysis.',
    };
  }
  if (status === 'Not connected') {
    return {
      usable: false,
      reason: 'Selected camera is Not connected to a live RTSP CV worker. Select Uploaded Footage or Demo Camera Mode instead.',
    };
  }
  return {
    usable: false,
    reason: 'Selected camera is Inactive. Mark it Active or choose another footage source.',
  };
}

export function CamerasPage() {
  const {
    cameras,
    locations,
    projects,
    videos,
    selectedProjectId,
    selectedSourceByProject,
    selectSourceForProject,
    serverHealth,
    currentUser,
    isDemoMode,
    createCamera,
    updateCamera,
    deleteCamera,
    pushToast,
  } = useRoadshadow();
  const navigate = useNavigate();

  const canManage = currentUser ? canPerformAction(currentUser.role, 'manage_cameras') : false;

  const activeProjectScopeKey = selectedProjectId || 'ALL';
  const activeProject = projects.find((p) => p.id === selectedProjectId) ?? null;

  const [activeTab, setActiveTab] = useState<SourceTab>('registered');
  const [showRegisterForm, setShowRegisterForm] = useState(false);

  // Register new camera form state
  const [name, setName] = useState('');
  const [locationId, setLocationId] = useState('');
  const [cameraType, setCameraType] = useState('Fixed Bullet 4MP');
  const [direction, setDirection] = useState('Facing North-East');
  const [resolution, setResolution] = useState('1920x1080');
  const [frameRate, setFrameRate] = useState('25');
  const [installationDate, setInstallationDate] = useState(new Date().toISOString().slice(0, 10));
  const [status, setStatus] = useState<CameraStatus>('Active');
  const [description, setDescription] = useState('');
  const [rtspAdapterEnabled, setRtspAdapterEnabled] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  // Live RTSP configuration state (credentials sent strictly server-side, never stored in browser)
  const [rtspCameraId, setRtspCameraId] = useState('');
  const [rtspProtocol, setRtspProtocol] = useState<'rtsp' | 'rtsps'>('rtsps');
  const [rtspHost, setRtspHost] = useState('');
  const [rtspPort, setRtspPort] = useState('554');
  const [rtspPath, setRtspPath] = useState('/stream1');
  const [rtspUser, setRtspUser] = useState('');
  const [rtspPass, setRtspPass] = useState('');
  const [rtspBusy, setRtspBusy] = useState(false);
  const [rtspStatusMsg, setRtspStatusMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const scopedLocations = useMemo(
    () =>
      locations.filter((l) =>
        selectedProjectId === 'ALL' ? true : l.projectId === selectedProjectId
      ),
    [locations, selectedProjectId]
  );

  const scopedCameras = useMemo(
    () =>
      cameras.filter((c) =>
        selectedProjectId === 'ALL' ? true : c.projectId === selectedProjectId
      ),
    [cameras, selectedProjectId]
  );

  const scopedVideos = useMemo(
    () =>
      videos.filter((v) =>
        selectedProjectId === 'ALL' ? true : v.projectId === selectedProjectId
      ),
    [videos, selectedProjectId]
  );

  // Fix Bug 2 root cause: keep locationId & rtspCameraId synced when locations/cameras load or project changes
  useEffect(() => {
    const validLoc =
      scopedLocations.find((l) => l.id === locationId) ?? scopedLocations[0] ?? locations[0];
    if (validLoc && validLoc.id !== locationId) {
      setLocationId(validLoc.id);
    }
  }, [scopedLocations, locations, locationId]);

  useEffect(() => {
    const validCam =
      scopedCameras.find((c) => c.id === rtspCameraId) ?? scopedCameras[0] ?? cameras[0];
    if (validCam && validCam.id !== rtspCameraId) {
      setRtspCameraId(validCam.id);
    }
  }, [scopedCameras, cameras, rtspCameraId]);

  // Resolve currently selected source for the active project (persisted across reloads!)
  const selectedSource: ActiveCameraSource | null = useMemo(() => {
    const saved = selectedSourceByProject[activeProjectScopeKey];
    if (saved) {
      // Refresh live status if it's a registered camera whose status changed
      if (saved.sourceMode === 'registered_camera' && saved.cameraId) {
        const latest = cameras.find((c) => c.id === saved.cameraId);
        if (latest) {
          const check = isCameraUsableForAnalysis(latest.status);
          return {
            ...saved,
            label: latest.name,
            status: latest.status,
            isSelectable: check.usable,
            disabledReason: check.reason,
          };
        }
      }
      return saved;
    }

    // Fallback to project's saved selectedCameraId if present
    if (activeProject?.selectedCameraId) {
      const cam = cameras.find((c) => c.id === activeProject.selectedCameraId);
      if (cam) {
        const loc = locations.find((l) => l.id === cam.locationId);
        const linkedVid = videos.find((v) => v.cameraId === cam.id);
        const check = isCameraUsableForAnalysis(cam.status);
        return {
          projectId: activeProjectScopeKey,
          sourceMode: 'registered_camera',
          sourceId: cam.id,
          cameraId: cam.id,
          videoId: linkedVid?.id,
          label: cam.name,
          locationName: loc?.name || cam.locationId,
          status: cam.status,
          previewUrl: linkedVid?.posterUrl || DEMO_IMAGES.intersection,
          isSelectable: check.usable,
          disabledReason: check.reason,
        };
      }
    }
    return null;
  }, [selectedSourceByProject, activeProjectScopeKey, activeProject, cameras, locations, videos]);

  const handleSelectRegisteredCamera = async (cam: Camera) => {
    const loc = locations.find((l) => l.id === cam.locationId);
    const linkedVid = videos.find((v) => v.cameraId === cam.id);
    const check = isCameraUsableForAnalysis(cam.status);

    const source: ActiveCameraSource = {
      projectId: activeProjectScopeKey,
      sourceMode: 'registered_camera',
      sourceId: cam.id,
      cameraId: cam.id,
      videoId: linkedVid?.id,
      label: cam.name,
      locationName: loc ? `${loc.name} (${loc.city})` : cam.locationId,
      status: cam.status,
      previewUrl: linkedVid?.posterUrl || DEMO_IMAGES.intersection,
      isSelectable: check.usable,
      disabledReason: check.reason,
    };

    await selectSourceForProject(activeProjectScopeKey, source);
    pushToast({
      type: check.usable ? 'success' : 'warning',
      title: `Selected ${cam.name}`,
      description: check.usable
        ? 'Camera associated with active project and ready for analysis.'
        : check.reason,
    });
  };

  const handleSelectUploadedVideo = async (videoId: string) => {
    const vid = videos.find((v) => v.id === videoId);
    if (!vid) return;
    const loc = locations.find((l) => l.id === vid.locationId);
    const source: ActiveCameraSource = {
      projectId: activeProjectScopeKey,
      sourceMode: 'uploaded_footage',
      sourceId: vid.id,
      videoId: vid.id,
      cameraId: vid.cameraId,
      label: vid.title,
      locationName: loc ? `${loc.name} (${loc.city})` : vid.locationId,
      status: 'Ready',
      previewUrl: vid.posterUrl || DEMO_IMAGES.intersection,
      isSelectable: true,
    };
    await selectSourceForProject(activeProjectScopeKey, source);
    pushToast({
      type: 'success',
      title: 'Uploaded Footage Selected',
      description: `${vid.title} is pinned for analysis.`,
    });
  };

  const handleSelectDemoCamera = async (preset: DemoCameraPreset) => {
    const source: ActiveCameraSource = {
      projectId: activeProjectScopeKey,
      sourceMode: 'demo_camera',
      sourceId: preset.id,
      videoId: preset.videoId,
      label: preset.name,
      locationName: preset.locationName,
      status: 'Demo Ready',
      previewUrl: preset.previewUrl,
      isSelectable: true,
    };
    await selectSourceForProject(activeProjectScopeKey, source);
    pushToast({
      type: 'info',
      title: 'Demo Camera Selected',
      description: `${preset.name} loaded in clearly labelled Demo Camera Mode.`,
    });
  };

  const handleStartAnalysis = () => {
    if (!selectedSource || !selectedSource.isSelectable) return;
    if (selectedSource.videoId) {
      navigate(`/video-analysis/${selectedSource.videoId}`);
    } else if (selectedSource.cameraId) {
      navigate(
        `/upload?projectId=${selectedProjectId !== 'ALL' ? selectedProjectId : ''}&cameraId=${selectedSource.cameraId}`
      );
    } else {
      navigate('/upload');
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!canManage) {
      setFormError('Only Analysts and Administrators can register cameras.');
      return;
    }
    const loc =
      locations.find((l) => l.id === locationId) ?? scopedLocations[0] ?? locations[0];
    if (!loc) {
      setFormError('Register a Road Location before attaching cameras.');
      return;
    }
    if (name.trim().length < 2) {
      setFormError('Enter a camera name or asset identifier.');
      return;
    }
    const created = await createCamera({
      projectId: loc.projectId,
      locationId: loc.id,
      name: name.trim(),
      cameraType: cameraType.trim(),
      direction: direction.trim(),
      resolution: resolution.trim(),
      frameRate: frameRate ? Number(frameRate) : undefined,
      installationDate: installationDate || undefined,
      status,
      description: description.trim(),
      rtspAdapterEnabled,
    });
    setName('');
    setDescription('');
    setShowRegisterForm(false);
    await handleSelectRegisteredCamera(created);
  };

  const handleSaveRtsp = async (e: React.FormEvent) => {
    e.preventDefault();
    setRtspStatusMsg(null);
    if (!rtspHost.trim()) {
      setRtspStatusMsg({ ok: false, text: 'Enter an authorized external RTSP/RTSPS host or domain.' });
      return;
    }
    setRtspBusy(true);
    try {
      const resp = await roadshadowFetch('/api/cameras/rtsp-config', {
        method: 'POST',
        isDemoMode,
        demoRole: currentUser?.role,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cameraId: rtspCameraId || 'rtsp_manual_cam',
          protocol: rtspProtocol,
          streamHost: rtspHost.trim(),
          streamPort: Number(rtspPort) || 554,
          streamPath: rtspPath.trim() || '/stream1',
          username: rtspUser.trim() || undefined,
          password: rtspPass || undefined,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.error || 'RTSP configuration validation failed.');
      }
      setRtspPass(''); // Never retain password in browser state after submission
      const isLiveConnected = Boolean(data.liveConnected);
      setRtspStatusMsg({
        ok: isLiveConnected,
        text: data.message,
      });

      const cam = cameras.find((c) => c.id === rtspCameraId);
      const loc = locations.find((l) => l.id === cam?.locationId);
      await selectSourceForProject(activeProjectScopeKey, {
        projectId: activeProjectScopeKey,
        sourceMode: 'live_rtsp',
        sourceId: `rtsp_${rtspCameraId || 'custom'}`,
        cameraId: cam?.id,
        label: `${rtspProtocol.toUpperCase()} · ${rtspHost.trim()}:${rtspPort}${rtspPath}`,
        locationName: loc ? `${loc.name} (${loc.city})` : 'Configured RTSP Stream',
        status: isLiveConnected ? 'Active' : 'Not connected',
        previewUrl: DEMO_IMAGES.intersection,
        isSelectable: isLiveConnected,
        disabledReason: isLiveConnected
          ? undefined
          : data.message || 'Live RTSP stream could not be verified as connected by the CV worker.',
      });
    } catch (err) {
      setRtspStatusMsg({
        ok: false,
        text: err instanceof Error ? err.message : 'Unable to validate RTSP endpoint.',
      });
    } finally {
      setRtspBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[#F5F8FC]">Road Camera &amp; Source Selection</h1>
          <p className="text-sm text-[#A9B8CA] mt-1">
            Select an active road camera, uploaded traffic clip, authorized RTSP endpoint, or labelled Demo Camera feed for{' '}
            <strong className="text-[#F5F8FC]">
              {activeProject ? activeProject.name : 'All Active Projects'}
            </strong>
            .
          </p>
        </div>

        <button
          type="button"
          disabled={!canManage}
          onClick={() => {
            setActiveTab('registered');
            setShowRegisterForm((v) => !v);
          }}
          className="inline-flex items-center gap-2 px-4 py-2 bg-[#2585FF] hover:bg-[#1C74E8] disabled:opacity-50 text-white text-sm font-medium rounded-md whitespace-nowrap shrink-0"
        >
          <Plus className="w-4 h-4" />
          Register Camera
        </button>
      </div>

      {/* Persistent Active Source Selection Bar + Start Analysis Control */}
      <section
        aria-label="Selected camera source summary"
        data-testid="selected-camera-summary"
        className="bg-[#122943] border border-[#2585FF]/50 rounded-lg p-5 grid grid-cols-1 lg:grid-cols-12 gap-5 items-center"
      >
        <div className="lg:col-span-3">
          <div className="relative aspect-[16/9] rounded-md overflow-hidden bg-[#071426] border border-[#233B56]">
            {selectedSource?.previewUrl ? (
              <img
                src={selectedSource.previewUrl}
                alt={selectedSource.label}
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center text-xs text-[#A9B8CA] p-3 text-center">
                <CameraIcon className="w-6 h-6 text-[#45B5FF] mb-1.5" />
                <span>No source selected yet</span>
              </div>
            )}
            {selectedSource?.sourceMode === 'demo_camera' && (
              <span className="absolute top-2 left-2 px-2 py-0.5 text-[10px] font-mono font-semibold bg-[#071426]/90 border border-[#2585FF] text-[#45B5FF] rounded">
                DEMO CAMERA
              </span>
            )}
          </div>
        </div>

        <div className="lg:col-span-6 space-y-1.5 min-w-0">
          <p className="text-xs font-mono uppercase text-[#45B5FF]">
            {selectedSource
              ? `Selected Source · ${selectedSource.sourceMode.replace('_', ' ')}`
              : 'No Road Camera or Footage Selected'}
          </p>
          <h2 className="text-lg font-semibold text-[#F5F8FC] truncate">
            {selectedSource ? selectedSource.label : 'Choose a source below to enable analysis'}
          </h2>
          {selectedSource ? (
            <>
              <p className="text-xs text-[#A9B8CA]">
                {selectedSource.locationName} · Source ID:{' '}
                <span className="font-mono text-[#F5F8FC]">{selectedSource.sourceId}</span>
              </p>
              <div className="flex flex-wrap items-center gap-3 pt-1 text-xs">
                <span
                  className={`font-mono font-medium ${
                    selectedSource.isSelectable ? 'text-[#22C55E]' : 'text-[#E5484D]'
                  }`}
                >
                  Status: {selectedSource.status}
                </span>
                <span className="text-[#A9B8CA]">
                  · Remembered for {activeProject ? activeProject.name : 'Workspace'}
                </span>
              </div>
              {!selectedSource.isSelectable && selectedSource.disabledReason && (
                <p role="alert" className="text-xs text-[#E5484D] pt-1 flex items-start gap-1.5">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>{selectedSource.disabledReason}</span>
                </p>
              )}
            </>
          ) : (
            <p className="text-xs text-[#A9B8CA]">
              Pick an Active registered camera, an uploaded project video, or a Demo Camera feed below. Your choice is remembered per project.
            </p>
          )}
        </div>

        <div className="lg:col-span-3 flex flex-col gap-2">
          <button
            type="button"
            data-testid="start-analysis-btn"
            disabled={!selectedSource || !selectedSource.isSelectable}
            onClick={handleStartAnalysis}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-[#2585FF] hover:bg-[#1C74E8] disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium rounded-md transition-colors"
          >
            <Play className="w-4 h-4" />
            Start Analysis
          </button>
          <button
            type="button"
            onClick={() => navigate('/upload')}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 bg-[#0D1F35] hover:bg-[#173252] border border-[#233B56] text-xs font-medium text-[#F5F8FC] rounded-md"
          >
            <Upload className="w-3.5 h-3.5 text-[#45B5FF]" />
            Upload New Traffic Clip
          </button>
        </div>
      </section>

      {/* Source Category Tabs */}
      <div
        role="tablist"
        aria-label="Camera and video source modes"
        className="flex flex-wrap gap-2 border-b border-[#233B56] pb-3"
      >
        {(
          [
            { id: 'registered', label: `Registered Road Cameras (${scopedCameras.length})`, icon: CameraIcon },
            { id: 'uploaded', label: `Uploaded Road Footage (${scopedVideos.length})`, icon: FileVideo },
            { id: 'rtsp', label: 'Live CCTV / RTSP Config', icon: Radio },
            { id: 'demo', label: 'Demo Camera Mode (3)', icon: PlaySquare },
          ] as const
        ).map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setActiveTab(tab.id)}
              className={`inline-flex items-center gap-2 px-3.5 py-2 text-xs sm:text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
                active
                  ? 'bg-[#2585FF] text-white'
                  : 'bg-[#122943] border border-[#233B56] text-[#A9B8CA] hover:text-[#F5F8FC]'
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* TAB A: Registered Road Cameras */}
      {activeTab === 'registered' && (
        <div className="space-y-4">
          {showRegisterForm && (
            <form
              onSubmit={handleCreate}
              className="bg-[#122943] border border-[#2585FF]/50 rounded-lg p-5 space-y-4"
            >
              <h2 className="text-base font-semibold text-[#F5F8FC]">Register New Traffic Camera</h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label htmlFor="cam-name" className="block text-xs text-[#A9B8CA] mb-1">
                    Camera Name / Asset ID *
                  </label>
                  <input
                    id="cam-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. CAM-TH-SW02 (West Arm)"
                    className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC]"
                  />
                </div>
                <div>
                  <label htmlFor="cam-loc" className="block text-xs text-[#A9B8CA] mb-1">
                    Associated Location *
                  </label>
                  <select
                    id="cam-loc"
                    value={locationId}
                    onChange={(e) => setLocationId(e.target.value)}
                    className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC]"
                  >
                    {(scopedLocations.length > 0 ? scopedLocations : locations).map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name} ({l.city})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="cam-status" className="block text-xs text-[#A9B8CA] mb-1">
                    Connection Status
                  </label>
                  <select
                    id="cam-status"
                    value={status}
                    onChange={(e) => setStatus(e.target.value as CameraStatus)}
                    className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC]"
                  >
                    {CAMERA_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <label htmlFor="cam-type" className="block text-xs text-[#A9B8CA] mb-1">
                    Camera Type
                  </label>
                  <input
                    id="cam-type"
                    type="text"
                    value={cameraType}
                    onChange={(e) => setCameraType(e.target.value)}
                    className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-1.5 text-sm text-[#F5F8FC]"
                  />
                </div>
                <div>
                  <label htmlFor="cam-dir" className="block text-xs text-[#A9B8CA] mb-1">
                    Viewing Direction
                  </label>
                  <input
                    id="cam-dir"
                    type="text"
                    value={direction}
                    onChange={(e) => setDirection(e.target.value)}
                    className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-1.5 text-sm text-[#F5F8FC]"
                  />
                </div>
                <div>
                  <label htmlFor="cam-res" className="block text-xs text-[#A9B8CA] mb-1">
                    Resolution
                  </label>
                  <input
                    id="cam-res"
                    type="text"
                    value={resolution}
                    onChange={(e) => setResolution(e.target.value)}
                    className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-1.5 text-sm font-mono text-[#F5F8FC]"
                  />
                </div>
                <div>
                  <label htmlFor="cam-fps" className="block text-xs text-[#A9B8CA] mb-1">
                    FPS
                  </label>
                  <input
                    id="cam-fps"
                    type="number"
                    min={1}
                    max={120}
                    value={frameRate}
                    onChange={(e) => setFrameRate(e.target.value)}
                    className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-1.5 text-sm font-mono text-[#F5F8FC]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="cam-install" className="block text-xs text-[#A9B8CA] mb-1">
                    Installation Date
                  </label>
                  <input
                    id="cam-install"
                    type="date"
                    value={installationDate}
                    onChange={(e) => setInstallationDate(e.target.value)}
                    className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-1.5 text-sm font-mono text-[#F5F8FC]"
                  />
                </div>
                <div>
                  <label htmlFor="cam-desc" className="block text-xs text-[#A9B8CA] mb-1">
                    Field Notes
                  </label>
                  <input
                    id="cam-desc"
                    type="text"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Pole height, field of view, occlusion notes..."
                    className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-1.5 text-sm text-[#F5F8FC]"
                  />
                </div>
              </div>

              <label className="flex items-center gap-2 text-xs text-[#A9B8CA] cursor-pointer">
                <input
                  type="checkbox"
                  checked={rtspAdapterEnabled}
                  onChange={(e) => setRtspAdapterEnabled(e.target.checked)}
                  className="accent-[#2585FF]"
                />
                <span>Flag for external RTSP CV worker ingestion (credentials stored server-side only)</span>
              </label>

              {formError && (
                <p role="alert" className="text-xs text-[#E5484D]">
                  {formError}
                </p>
              )}

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowRegisterForm(false)}
                  className="px-3 py-1.5 bg-[#0D1F35] border border-[#233B56] text-xs text-[#A9B8CA] rounded-md"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-[#2585FF] hover:bg-[#1C74E8] text-white text-xs font-medium rounded-md"
                >
                  Save &amp; Select Camera
                </button>
              </div>
            </form>
          )}

          {scopedCameras.length === 0 ? (
            <div className="bg-[#122943] border border-[#233B56] rounded-lg p-10 text-center text-sm text-[#A9B8CA]">
              No road cameras registered for this project yet. Click &ldquo;Register Camera&rdquo; or switch to Demo Camera Mode.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {scopedCameras.map((cam) => {
                const loc = locations.find((l) => l.id === cam.locationId);
                const proj = projects.find((p) => p.id === cam.projectId);
                const isSelected =
                  selectedSource?.sourceMode === 'registered_camera' &&
                  selectedSource.sourceId === cam.id;
                const usable = cam.status === 'Active';

                return (
                  <div
                    key={cam.id}
                    data-testid={`camera-card-${cam.id}`}
                    className={`bg-[#122943] rounded-lg p-5 space-y-3 border transition-colors ${
                      isSelected
                        ? 'border-[#2585FF] ring-1 ring-[#2585FF]/40'
                        : 'border-[#233B56] hover:border-[#2585FF]/50'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[11px] font-mono text-[#A9B8CA]">
                          ID: {cam.id} · {proj?.name || cam.projectId}
                        </p>
                        <h3 className="text-base font-semibold text-[#F5F8FC] mt-0.5">
                          {cam.name}
                        </h3>
                        <p className="text-xs text-[#A9B8CA] mt-0.5">
                          {loc?.name || cam.locationId} · {cam.direction}
                        </p>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        {canManage ? (
                          <select
                            aria-label={`Change status for ${cam.name}`}
                            value={cam.status}
                            onChange={(e) =>
                              void updateCamera(cam.id, { status: e.target.value as CameraStatus })
                            }
                            className="bg-[#0D1F35] border border-[#233B56] rounded-md px-2 py-1 text-xs text-[#F5F8FC]"
                          >
                            {CAMERA_STATUSES.map((s) => (
                              <option key={s} value={s}>
                                {s}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="text-xs font-mono text-[#F5F8FC]">{cam.status}</span>
                        )}

                        {canManage && (
                          <button
                            type="button"
                            onClick={() => setDeleteId(cam.id)}
                            aria-label={`Delete camera ${cam.name}`}
                            className="p-1.5 text-[#A9B8CA] hover:text-[#E5484D] rounded hover:bg-[#0D1F35]"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </div>

                    {cam.description && (
                      <p className="text-xs text-[#A9B8CA] leading-relaxed">{cam.description}</p>
                    )}

                    <div className="pt-2.5 border-t border-[#233B56] flex flex-wrap items-center justify-between gap-3">
                      <span className="text-xs font-mono text-[#A9B8CA]">
                        {cam.resolution} · {cam.frameRate ?? 25} fps ·{' '}
                        <span className={usable ? 'text-[#22C55E]' : 'text-[#EAB308]'}>
                          {cam.status}
                        </span>
                        {cam.rtspAdapterEnabled
                          ? serverHealth.cvAdapter.rtspIngestionReady
                            ? ' · RTSP Ready'
                            : ' · RTSP Not Connected'
                          : ' · Upload Footage Mode'}
                      </span>

                      <button
                        type="button"
                        onClick={() => void handleSelectRegisteredCamera(cam)}
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                          isSelected
                            ? 'bg-[#0D1F35] border border-[#2585FF] text-[#45B5FF]'
                            : 'bg-[#2585FF] hover:bg-[#1C74E8] text-white'
                        }`}
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        {isSelected ? 'Selected Camera' : 'Select Camera'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* TAB B: Uploaded Road Footage */}
      {activeTab === 'uploaded' && (
        <div className="space-y-4">
          {scopedVideos.length === 0 ? (
            <div className="bg-[#122943] border border-[#233B56] rounded-lg p-10 text-center space-y-3">
              <p className="text-sm font-medium text-[#F5F8FC]">No Uploaded Road Footage Yet</p>
              <p className="text-xs text-[#A9B8CA]">
                Upload an MP4, MOV, or WebM traffic clip to preview and analyse it here.
              </p>
              <button
                type="button"
                onClick={() => navigate('/upload')}
                className="inline-flex items-center gap-2 px-4 py-2 bg-[#2585FF] hover:bg-[#1C74E8] text-white text-xs font-medium rounded-md"
              >
                <Upload className="w-4 h-4" />
                Go to Video Upload Centre
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {scopedVideos.map((vid) => {
                const loc = locations.find((l) => l.id === vid.locationId);
                const isSelected =
                  selectedSource?.sourceMode === 'uploaded_footage' &&
                  selectedSource.sourceId === vid.id;
                return (
                  <div
                    key={vid.id}
                    className={`bg-[#122943] rounded-lg overflow-hidden border transition-colors flex flex-col justify-between ${
                      isSelected
                        ? 'border-[#2585FF] ring-1 ring-[#2585FF]/40'
                        : 'border-[#233B56] hover:border-[#2585FF]/50'
                    }`}
                  >
                    <div className="aspect-[16/9] bg-[#071426] relative">
                      <img
                        src={vid.posterUrl || DEMO_IMAGES.intersection}
                        alt={vid.title}
                        referrerPolicy="no-referrer"
                        className="w-full h-full object-cover"
                      />
                      <span className="absolute bottom-2 right-2 px-2 py-0.5 text-[10px] font-mono bg-[#071426]/90 text-[#F5F8FC] rounded">
                        {vid.durationSec}s · {vid.status}
                      </span>
                    </div>
                    <div className="p-4 space-y-3">
                      <div>
                        <p className="text-sm font-semibold text-[#F5F8FC] truncate">{vid.title}</p>
                        <p className="text-xs text-[#A9B8CA] mt-0.5 truncate">
                          {loc?.name || vid.locationId} · {vid.recordingDate}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleSelectUploadedVideo(vid.id)}
                        className={`w-full px-3 py-1.5 text-xs font-medium rounded-md ${
                          isSelected
                            ? 'bg-[#0D1F35] border border-[#2585FF] text-[#45B5FF]'
                            : 'bg-[#2585FF] hover:bg-[#1C74E8] text-white'
                        }`}
                      >
                        {isSelected ? 'Selected Footage' : 'Select Uploaded Footage'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* TAB C: Live CCTV / RTSP Configuration */}
      {activeTab === 'rtsp' && (
        <form
          onSubmit={handleSaveRtsp}
          className="bg-[#122943] border border-[#233B56] rounded-lg p-5 space-y-4 max-w-3xl"
        >
          <div className="flex items-start gap-3 p-3.5 rounded-md bg-[#0D1F35] border border-[#233B56]">
            <ShieldCheck className="w-5 h-5 text-[#45B5FF] shrink-0 mt-0.5" />
            <div className="text-xs text-[#A9B8CA] leading-relaxed">
              <p className="text-sm font-semibold text-[#F5F8FC]">
                Server-Isolated RTSP / RTSPS Configuration
              </p>
              <p className="mt-1">
                Credentials submitted here are validated by the Express backend and held strictly in server memory — never written to Firestore or exposed in browser storage.
                {!serverHealth.cvAdapter.rtspIngestionReady &&
                  ' Live RTSP decoding is not enabled in this runtime; use Upload Video for real server-side Gemini AI analysis of recorded clips.'}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="rtsp-cam" className="block text-xs text-[#A9B8CA] mb-1">
                Target Registered Camera
              </label>
              <select
                id="rtsp-cam"
                value={rtspCameraId}
                onChange={(e) => setRtspCameraId(e.target.value)}
                className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC]"
              >
                {(scopedCameras.length > 0 ? scopedCameras : cameras).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="rtsp-proto" className="block text-xs text-[#A9B8CA] mb-1">
                Stream Protocol
              </label>
              <select
                id="rtsp-proto"
                value={rtspProtocol}
                onChange={(e) => setRtspProtocol(e.target.value as 'rtsp' | 'rtsps')}
                className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm font-mono text-[#F5F8FC]"
              >
                <option value="rtsps">RTSPS (TLS Encrypted)</option>
                <option value="rtsp">RTSP (Authorised Private Relay)</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
            <div className="sm:col-span-6">
              <label htmlFor="rtsp-host" className="block text-xs text-[#A9B8CA] mb-1">
                Authorised Stream Host / Domain *
              </label>
              <input
                id="rtsp-host"
                type="text"
                value={rtspHost}
                onChange={(e) => setRtspHost(e.target.value)}
                placeholder="e.g. cctv-gateway.smartcity.gov.in"
                className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm font-mono text-[#F5F8FC]"
              />
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="rtsp-port" className="block text-xs text-[#A9B8CA] mb-1">
                Port
              </label>
              <input
                id="rtsp-port"
                type="number"
                value={rtspPort}
                onChange={(e) => setRtspPort(e.target.value)}
                className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm font-mono text-[#F5F8FC]"
              />
            </div>
            <div className="sm:col-span-4">
              <label htmlFor="rtsp-path" className="block text-xs text-[#A9B8CA] mb-1">
                Stream Path
              </label>
              <input
                id="rtsp-path"
                type="text"
                value={rtspPath}
                onChange={(e) => setRtspPath(e.target.value)}
                className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm font-mono text-[#F5F8FC]"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="rtsp-user" className="block text-xs text-[#A9B8CA] mb-1">
                Optional Stream Username (Server Vault Only)
              </label>
              <input
                id="rtsp-user"
                type="text"
                autoComplete="off"
                value={rtspUser}
                onChange={(e) => setRtspUser(e.target.value)}
                className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC]"
              />
            </div>
            <div>
              <label htmlFor="rtsp-pass" className="block text-xs text-[#A9B8CA] mb-1">
                Optional Stream Password (Cleared After Submit)
              </label>
              <input
                id="rtsp-pass"
                type="password"
                autoComplete="new-password"
                value={rtspPass}
                onChange={(e) => setRtspPass(e.target.value)}
                className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC]"
              />
            </div>
          </div>

          {rtspStatusMsg && (
            <div
              role="status"
              className={`p-3 rounded-md border text-xs ${
                rtspStatusMsg.ok
                  ? 'bg-[#22C55E]/10 border-[#22C55E]/40 text-[#F5F8FC]'
                  : 'bg-[#EAB308]/10 border-[#EAB308]/40 text-[#F5F8FC]'
              }`}
            >
              {rtspStatusMsg.text}
            </div>
          )}

          <button
            type="submit"
            disabled={!canManage || rtspBusy}
            className="px-4 py-2 bg-[#2585FF] hover:bg-[#1C74E8] disabled:opacity-50 text-white text-sm font-medium rounded-md"
          >
            {rtspBusy ? 'Validating Endpoint...' : 'Validate & Save RTSP Configuration'}
          </button>
        </form>
      )}

      {/* TAB D: Demo Camera Mode */}
      {activeTab === 'demo' && (
        <div className="space-y-4">
          <div className="p-3.5 rounded-md bg-[#0D1F35] border border-[#2585FF]/40 text-xs text-[#A9B8CA]">
            <strong className="text-[#45B5FF]">DEMO CAMERA MODE:</strong> These feeds use clearly labelled sample Indian traffic footage so reviewers and municipal teams can evaluate selection, trajectory playback, and risk analytics without connecting live CCTV hardware.
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {DEMO_CAMERA_PRESETS.map((preset) => {
              const isSelected =
                selectedSource?.sourceMode === 'demo_camera' &&
                selectedSource.sourceId === preset.id;
              return (
                <div
                  key={preset.id}
                  data-testid={`demo-camera-${preset.id}`}
                  className={`bg-[#122943] rounded-lg overflow-hidden border transition-colors flex flex-col justify-between ${
                    isSelected
                      ? 'border-[#2585FF] ring-1 ring-[#2585FF]/40'
                      : 'border-[#233B56] hover:border-[#2585FF]/50'
                  }`}
                >
                  <div className="relative aspect-[16/9] bg-[#071426]">
                    <img
                      src={preset.previewUrl}
                      alt={preset.name}
                      referrerPolicy="no-referrer"
                      className="w-full h-full object-cover"
                    />
                    <span className="absolute top-2 left-2 px-2 py-0.5 text-[10px] font-mono font-semibold bg-[#071426]/90 border border-[#2585FF] text-[#45B5FF] rounded">
                      DEMO CAMERA
                    </span>
                  </div>
                  <div className="p-4 space-y-3 flex-1 flex flex-col justify-between">
                    <div>
                      <h3 className="text-sm font-semibold text-[#F5F8FC]">{preset.name}</h3>
                      <p className="text-xs text-[#45B5FF] mt-0.5">{preset.locationName}</p>
                      <p className="text-xs text-[#A9B8CA] mt-1.5 leading-relaxed">
                        {preset.description}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleSelectDemoCamera(preset)}
                      className={`w-full px-3 py-2 text-xs font-medium rounded-md transition-colors ${
                        isSelected
                          ? 'bg-[#0D1F35] border border-[#2585FF] text-[#45B5FF]'
                          : 'bg-[#2585FF] hover:bg-[#1C74E8] text-white'
                      }`}
                    >
                      {isSelected ? 'Selected Demo Camera' : 'Select Demo Camera'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(deleteId)}
        title="Remove Camera Record?"
        description="This removes the camera from active inventory. Previously uploaded footage and conflict records remain preserved."
        confirmLabel="Remove Camera"
        destructive
        onCancel={() => setDeleteId(null)}
        onConfirm={async () => {
          if (deleteId) {
            await deleteCamera(deleteId);
            setDeleteId(null);
          }
        }}
      />
    </div>
  );
}
