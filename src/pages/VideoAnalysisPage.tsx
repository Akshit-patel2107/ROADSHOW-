import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  Eye,
  EyeOff,
  GitBranch,
  Loader2,
  Maximize2,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  SkipBack,
  Upload,
} from 'lucide-react';
import { useRoadshadow } from '../context/RoadshadowContext';
import { RiskIndicator } from '../components/RiskBadge';
import { canPerformAction } from '../engine/validation';
import type { DetectedObjectClass } from '../types/roadshadow';

const CLASS_STYLE: Record<DetectedObjectClass, { stroke: string; label: string }> = {
  person: { stroke: '#E5484D', label: 'Person' },
  bicycle: { stroke: '#EAB308', label: 'Bicycle' },
  motorcycle: { stroke: '#F97316', label: 'Motorcycle' },
  scooter: { stroke: '#FB923C', label: 'Scooter' },
  car: { stroke: '#45B5FF', label: 'Car' },
  auto_rickshaw: { stroke: '#A855F7', label: 'Auto' },
  bus: { stroke: '#22C55E', label: 'Bus' },
  truck: { stroke: '#38BDF8', label: 'Truck' },
  other_vehicle: { stroke: '#CBD5E1', label: 'Vehicle' },
};

export function VideoAnalysisPage() {
  const { videoId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const {
    currentUser,
    videos,
    processingJobs,
    conflictEvents,
    locations,
    selectedProjectId,
    retryVideoAnalysis,
  } = useRoadshadow();

  const canRetry = currentUser ? canPerformAction(currentUser.role, 'upload_video') : false;

  const availableVideos = useMemo(
    () =>
      videos.filter((v) =>
        selectedProjectId === 'ALL' ? true : v.projectId === selectedProjectId
      ),
    [videos, selectedProjectId]
  );

  const selectedVideo = useMemo(() => {
    if (videoId) {
      return videos.find((v) => v.id === videoId) ?? availableVideos[0] ?? null;
    }
    return availableVideos[0] ?? null;
  }, [videoId, videos, availableVideos]);

  const relatedJob = useMemo(
    () => (selectedVideo ? processingJobs.find((j) => j.videoId === selectedVideo.id) ?? null : null),
    [selectedVideo, processingJobs]
  );

  const relatedEvents = useMemo(
    () =>
      selectedVideo
        ? conflictEvents
            .filter((e) => e.videoId === selectedVideo.id)
            .sort((a, b) => a.timestampSec - b.timestampSec)
        : [],
    [selectedVideo, conflictEvents]
  );

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [showOverlay, setShowOverlay] = useState(true);
  const [showTrajectories, setShowTrajectories] = useState(true);
  const [activeEventId, setActiveEventId] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  const playerContainerRef = useRef<HTMLDivElement | null>(null);
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const replayStopAtRef = useRef<number | null>(null);

  const duration = Math.max(1, selectedVideo?.durationSec || 20);
  const queryEventId = searchParams.get('eventId');
  const queryTimeParam = searchParams.get('t');
  const queryReplay = searchParams.get('replay') === '1';

  useEffect(() => {
    const matchedEv = queryEventId
      ? relatedEvents.find((e) => e.id === queryEventId) ?? null
      : null;
    const parsedT = queryTimeParam !== null ? Number(queryTimeParam) : NaN;
    const targetSec = matchedEv
      ? matchedEv.timestampSec
      : Number.isFinite(parsedT)
        ? parsedT
        : null;

    if (matchedEv) {
      setActiveEventId(matchedEv.id);
    } else {
      setActiveEventId(relatedEvents[0]?.id ?? null);
    }

    if (targetSec !== null) {
      const clamped = Math.max(0, Math.min(duration, targetSec));
      if (queryReplay) {
        const startSec = Math.max(0, Number((clamped - 2.5).toFixed(1)));
        replayStopAtRef.current = Math.min(duration, Number((clamped + 2.5).toFixed(1)));
        setCurrentTime(startSec);
        setIsPlaying(true);
      } else {
        replayStopAtRef.current = null;
        setCurrentTime(clamped);
        setIsPlaying(false);
      }
    } else {
      replayStopAtRef.current = null;
      setCurrentTime(0);
      setIsPlaying(false);
    }
  }, [selectedVideo?.id, queryEventId, queryTimeParam, queryReplay, duration]);

  // Playback timer (drives synchronized playback cleanly for both real uploaded videos and demo CCTV frames)
  useEffect(() => {
    if (!isPlaying || !selectedVideo) return;
    const interval = setInterval(() => {
      setCurrentTime((prev) => {
        const next = prev + 0.1 * playbackSpeed;
        const stopAt = replayStopAtRef.current;
        if (stopAt !== null && next >= stopAt) {
          replayStopAtRef.current = null;
          setIsPlaying(false);
          return stopAt;
        }
        if (next >= duration) {
          replayStopAtRef.current = null;
          setIsPlaying(false);
          return duration;
        }
        return Number(next.toFixed(2));
      });
    }, 100);
    return () => clearInterval(interval);
  }, [isPlaying, playbackSpeed, duration, selectedVideo]);

  // Keep HTML5 video element synced if present
  useEffect(() => {
    const vid = videoElRef.current;
    if (!vid || !selectedVideo?.fileUrl) return;
    vid.playbackRate = playbackSpeed;
    if (Math.abs(vid.currentTime - currentTime) > 0.35) {
      vid.currentTime = currentTime;
    }
    if (isPlaying && vid.paused) {
      vid.play().catch(() => {});
    } else if (!isPlaying && !vid.paused) {
      vid.pause();
    }
  }, [isPlaying, currentTime, playbackSpeed, selectedVideo?.fileUrl]);

  // Nearest frame detections strictly from actual stored detection array (never draws fake boxes!)
  const activeFrameDetections = useMemo(() => {
    const all = selectedVideo?.detections ?? [];
    if (all.length === 0) return [];
    let closestTime = all[0].timestampSec;
    let minDiff = Math.abs(all[0].timestampSec - currentTime);
    for (const d of all) {
      const diff = Math.abs(d.timestampSec - currentTime);
      if (diff < minDiff) {
        minDiff = diff;
        closestTime = d.timestampSec;
      }
    }
    if (minDiff > 1.2) return [];
    return all.filter((d) => Math.abs(d.timestampSec - closestTime) < 0.05);
  }, [selectedVideo?.detections, currentTime]);

  // Draw detection & tracked trajectory overlay on canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const w = canvas.width;
    const h = canvas.height;

    // 1. Tracked movement trajectory polylines up to current timestamp
    if (showOverlay && showTrajectories && selectedVideo?.trajectories && selectedVideo.trajectories.length > 0) {
      for (const traj of selectedVideo.trajectories) {
        const pts = traj.positions.filter((pt) => pt.timestampSec <= currentTime + 0.6);
        if (pts.length < 2) continue;
        const style = CLASS_STYLE[traj.objectClass] || CLASS_STYLE.other_vehicle;
        ctx.save();
        ctx.strokeStyle = style.stroke;
        ctx.globalAlpha = 0.78;
        ctx.lineWidth = 2.5;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(pts[0].cx * w, pts[0].cy * h);
        for (let i = 1; i < pts.length; i++) {
          ctx.lineTo(pts[i].cx * w, pts[i].cy * h);
        }
        ctx.stroke();
        ctx.setLineDash([]);

        // Direction endpoint dot
        const last = pts[pts.length - 1];
        ctx.fillStyle = style.stroke;
        ctx.beginPath();
        ctx.arc(last.cx * w, last.cy * h, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    if (!showOverlay || activeFrameDetections.length === 0) return;

    for (const det of activeFrameDetections) {
      const style = CLASS_STYLE[det.objectClass] || CLASS_STYLE.other_vehicle;
      const x = det.bbox.x * w;
      const y = det.bbox.y * h;
      const bw = det.bbox.w * w;
      const bh = det.bbox.h * h;

      ctx.strokeStyle = style.stroke;
      ctx.lineWidth = det.objectClass === 'person' ? 3 : 2;
      if (
        det.objectClass === 'motorcycle' ||
        det.objectClass === 'scooter' ||
        det.objectClass === 'bicycle'
      ) {
        ctx.setLineDash([6, 3]);
      } else {
        ctx.setLineDash([]);
      }
      ctx.strokeRect(x, y, bw, bh);
      ctx.setLineDash([]);

      const label = `${det.trackingId} · ${style.label} ${Math.round(det.confidence * 100)}%`;
      ctx.font = '600 12px "JetBrains Mono", monospace';
      const textWidth = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(7, 20, 38, 0.88)';
      ctx.fillRect(x, Math.max(0, y - 20), textWidth + 10, 19);
      ctx.fillStyle = style.stroke;
      ctx.fillText(label, x + 5, Math.max(13, y - 6));
    }

    // Frame timestamp bar in bottom-left of canvas
    const frameNum = activeFrameDetections[0]?.frameNumber ?? Math.round(currentTime * 25);
    const stamp = `FRAME ${String(frameNum).padStart(4, '0')} · T=${currentTime.toFixed(1)}s`;
    ctx.font = '500 11px "JetBrains Mono", monospace';
    const sw = ctx.measureText(stamp).width;
    ctx.fillStyle = 'rgba(7, 20, 38, 0.85)';
    ctx.fillRect(12, h - 30, sw + 14, 20);
    ctx.fillStyle = '#F5F8FC';
    ctx.fillText(stamp, 19, h - 16);
  }, [activeFrameDetections, showOverlay, showTrajectories, selectedVideo?.trajectories, currentTime]);

  const activeEvent = relatedEvents.find((e) => e.id === activeEventId) ?? relatedEvents[0] ?? null;

  const jumpToEvent = (evId: string, sec: number) => {
    replayStopAtRef.current = null;
    setActiveEventId(evId);
    setCurrentTime(Math.max(0, Math.min(duration, sec)));
    setIsPlaying(false);
  };

  const replayEventContext = (evId: string, sec: number) => {
    const startSec = Math.max(0, Number((sec - 2.5).toFixed(1)));
    replayStopAtRef.current = Math.min(duration, Number((sec + 2.5).toFixed(1)));
    setActiveEventId(evId);
    setCurrentTime(startSec);
    setIsPlaying(true);
  };

  const toggleFullscreen = () => {
    const el = playerContainerRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      el.requestFullscreen?.().catch(() => {});
    }
  };

  if (!selectedVideo) {
    return (
      <div className="bg-[#122943] border border-[#233B56] rounded-lg p-10 text-center max-w-xl mx-auto">
        <h1 className="text-lg font-semibold text-[#F5F8FC]">No Analysed Videos Available</h1>
        <p className="text-sm text-[#A9B8CA] mt-2">
          Upload a traffic video clip first to inspect bounding-box detections, tracked trajectories, and event timelines.
        </p>
        <button
          type="button"
          onClick={() => navigate('/upload')}
          className="mt-5 inline-flex items-center gap-2 px-4 py-2 bg-[#2585FF] hover:bg-[#1C74E8] text-white text-sm font-medium rounded-md"
        >
          <Upload className="w-4 h-4" />
          Upload Video
        </button>
      </div>
    );
  }

  const location = locations.find((l) => l.id === selectedVideo.locationId);

  return (
    <div className="space-y-6">
      {/* Header + Video Selector */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[#F5F8FC]">Video Analysis Engine</h1>
          <p className="text-sm text-[#A9B8CA] mt-1">
            {location?.name || selectedVideo.locationId} · {selectedVideo.recordingDate}{' '}
            {selectedVideo.recordingTime} ·{' '}
            <span
              className={
                selectedVideo.isDemonstration
                  ? 'text-[#45B5FF]'
                  : selectedVideo.status === 'Failed'
                    ? 'text-[#EAB308]'
                    : 'text-[#22C55E]'
              }
            >
              {selectedVideo.isDemonstration
                ? 'Demonstration Precomputed Output'
                : selectedVideo.status === 'Failed'
                  ? 'Stored Video · CV Analysis Pending/Failed'
                  : relatedJob?.engineMode === 'CV_SERVICE'
                    ? 'Real CV Worker Output'
                    : 'Stored Video'}
            </span>
          </p>
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor="video-selector" className="sr-only">
            Select analysed video
          </label>
          <select
            id="video-selector"
            value={selectedVideo.id}
            onChange={(e) => navigate(`/video-analysis/${e.target.value}`)}
            className="bg-[#122943] border border-[#233B56] text-[#F5F8FC] text-sm rounded-md px-3 py-2 max-w-xs truncate focus:outline-none focus:ring-2 focus:ring-[#2585FF]"
          >
            {availableVideos.map((v) => (
              <option key={v.id} value={v.id}>
                {v.title} {v.isDemonstration ? '(Demo)' : v.status === 'Failed' ? '(CV Pending)' : ''}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Honest CV Unavailable / Retry Banner for stored non-demo videos that failed CV analysis */}
      {!selectedVideo.isDemonstration && selectedVideo.status === 'Failed' && (
        <div
          role="status"
          data-testid="video-cv-unavailable-banner"
          className="p-4 rounded-lg bg-[#122943] border border-[#EAB308]/50 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
        >
          <div className="flex items-start gap-2.5 text-xs text-[#A9B8CA]">
            <AlertTriangle className="w-4 h-4 text-[#EAB308] shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-[#F5F8FC]">
                Uploaded Video Stored — Automated CV Analysis Unavailable
              </p>
              <p className="mt-0.5 leading-relaxed">
                {selectedVideo.errorMessage ||
                  relatedJob?.errorMessage ||
                  'External CV service (CV_SERVICE_URL) was not connected when this video was submitted. No synthetic bounding boxes or conflict events were fabricated.'}
              </p>
            </div>
          </div>
          {canRetry && (
            <button
              type="button"
              disabled={retrying}
              onClick={async () => {
                setRetrying(true);
                try {
                  await retryVideoAnalysis(selectedVideo.id);
                } finally {
                  setRetrying(false);
                }
              }}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-[#2585FF] hover:bg-[#1C74E8] disabled:opacity-50 text-white text-xs font-medium rounded-md whitespace-nowrap shrink-0"
            >
              {retrying ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5" />
              )}
              Retry CV Analysis
            </button>
          )}
        </div>
      )}

      {/* Main Player + Event Details Grid */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        <div className="xl:col-span-8 space-y-4">
          <div
            ref={playerContainerRef}
            className="bg-[#0D1F35] border border-[#233B56] rounded-lg overflow-hidden"
          >
            <div className="relative aspect-[16/9] bg-[#071426]">
              {selectedVideo.fileUrl && !selectedVideo.isDemonstration ? (
                <video
                  ref={videoElRef}
                  src={selectedVideo.fileUrl}
                  poster={selectedVideo.posterUrl}
                  className="w-full h-full object-contain"
                  muted
                  playsInline
                />
              ) : (
                <img
                  src={selectedVideo.posterUrl}
                  alt={selectedVideo.title}
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-cover"
                />
              )}

              {/* Synchronized Detection Overlay Canvas */}
              <canvas
                ref={canvasRef}
                width={1280}
                height={720}
                data-testid="detection-overlay-canvas"
                className="absolute inset-0 w-full h-full pointer-events-none"
              />
            </div>

            {/* Event Timeline Markers + Scrubber */}
            <div className="p-4 border-t border-[#233B56] space-y-3">
              <div className="relative pt-4 pb-1">
                {/* Conflict Event Timeline Markers */}
                {relatedEvents.map((ev) => {
                  const pct = Math.max(0, Math.min(100, (ev.timestampSec / duration) * 100));
                  const markerColor =
                    ev.riskCategory === 'Critical'
                      ? 'bg-[#E5484D]'
                      : ev.riskCategory === 'High'
                        ? 'bg-[#F97316]'
                        : ev.riskCategory === 'Medium'
                          ? 'bg-[#EAB308]'
                          : 'bg-[#22C55E]';
                  return (
                    <button
                      key={ev.id}
                      type="button"
                      onClick={() => jumpToEvent(ev.id, ev.timestampSec)}
                      title={`${ev.conflictType} at ${ev.timestampSec}s (${ev.riskCategory} ${ev.riskScore}/100)`}
                      aria-label={`Jump to ${ev.conflictType} at ${ev.timestampSec} seconds`}
                      style={{ left: `${pct}%` }}
                      className={`absolute top-0 -translate-x-1/2 w-3 h-3 rounded-sm ${markerColor} border border-[#071426] hover:scale-125 transition-transform`}
                    />
                  );
                })}

                <input
                  type="range"
                  min={0}
                  max={duration}
                  step={0.1}
                  value={currentTime}
                  aria-label="Video playback position"
                  onChange={(e) => setCurrentTime(Number(e.target.value))}
                  className="w-full accent-[#2585FF] cursor-pointer"
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setIsPlaying((p) => !p)}
                    aria-label={isPlaying ? 'Pause video' : 'Play video'}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#2585FF] hover:bg-[#1C74E8] text-white text-xs font-medium rounded-md"
                  >
                    {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                    {isPlaying ? 'Pause' : 'Play'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCurrentTime(0);
                      setIsPlaying(false);
                    }}
                    aria-label="Restart video"
                    className="p-1.5 bg-[#122943] border border-[#233B56] text-[#A9B8CA] hover:text-[#F5F8FC] rounded-md"
                  >
                    <SkipBack className="w-4 h-4" />
                  </button>
                  <span className="text-xs font-mono tabular-nums text-[#F5F8FC] ml-1">
                    {currentTime.toFixed(1)}s / {duration.toFixed(1)}s
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowOverlay((s) => !s)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-[#122943] border border-[#233B56] text-xs text-[#F5F8FC] rounded-md hover:border-[#2585FF] whitespace-nowrap"
                  >
                    {showOverlay ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                    {showOverlay ? 'Boxes On' : 'Boxes Off'}
                  </button>

                  <button
                    type="button"
                    onClick={() => setShowTrajectories((s) => !s)}
                    disabled={!showOverlay}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-[#122943] border border-[#233B56] disabled:opacity-40 text-xs text-[#F5F8FC] rounded-md hover:border-[#2585FF] whitespace-nowrap"
                  >
                    <GitBranch className="w-3.5 h-3.5 text-[#45B5FF]" />
                    {showTrajectories ? 'Trajectories On' : 'Trajectories Off'}
                  </button>

                  <select
                    aria-label="Playback speed"
                    value={playbackSpeed}
                    onChange={(e) => setPlaybackSpeed(Number(e.target.value))}
                    className="bg-[#122943] border border-[#233B56] text-xs font-mono text-[#F5F8FC] rounded-md px-2 py-1.5"
                  >
                    <option value={0.5}>0.5x</option>
                    <option value={1}>1.0x</option>
                    <option value={1.5}>1.5x</option>
                    <option value={2}>2.0x</option>
                  </select>

                  <button
                    type="button"
                    onClick={toggleFullscreen}
                    aria-label="Toggle fullscreen player"
                    className="p-1.5 bg-[#122943] border border-[#233B56] text-[#A9B8CA] hover:text-[#F5F8FC] rounded-md"
                  >
                    <Maximize2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* 11.4 Analysis Summary Metrics */}
          <div className="bg-[#122943] border border-[#233B56] rounded-lg p-5 space-y-4">
            <h2 className="text-base font-semibold text-[#F5F8FC]">Analysis Summary</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 text-xs">
              <div>
                <p className="text-[#A9B8CA]">Duration</p>
                <p className="text-sm font-mono tabular-nums font-semibold text-[#F5F8FC] mt-1">
                  {selectedVideo.durationSec}s
                </p>
              </div>
              <div>
                <p className="text-[#A9B8CA]">Analysed Frames</p>
                <p className="text-sm font-mono tabular-nums font-semibold text-[#F5F8FC] mt-1">
                  {relatedJob?.analyzedFrames ?? 0}
                </p>
              </div>
              <div>
                <p className="text-[#A9B8CA]">Processing Time</p>
                <p className="text-sm font-mono tabular-nums font-semibold text-[#F5F8FC] mt-1">
                  {relatedJob ? `${(relatedJob.processingTimeMs / 1000).toFixed(1)}s` : '—'}
                </p>
              </div>
              <div>
                <p className="text-[#A9B8CA]">Detections</p>
                <p className="text-sm font-mono tabular-nums font-semibold text-[#F5F8FC] mt-1">
                  {selectedVideo.detections?.length ?? relatedJob?.detectedObjectCount ?? 0}
                </p>
              </div>
              <div>
                <p className="text-[#A9B8CA]">Tracked IDs</p>
                <p className="text-sm font-mono tabular-nums font-semibold text-[#F5F8FC] mt-1">
                  {selectedVideo.trajectories?.length ?? relatedJob?.trackingCount ?? 0}
                </p>
              </div>
              <div>
                <p className="text-[#A9B8CA]">Conflicts Found</p>
                <p className="text-sm font-mono tabular-nums font-semibold text-[#F5F8FC] mt-1">
                  {relatedEvents.length}
                </p>
              </div>
            </div>

            <div className="pt-3 border-t border-[#233B56] text-xs text-[#A9B8CA] space-y-1">
              <p>
                <span className="text-[#F5F8FC] font-medium">Model / Engine:</span>{' '}
                {relatedJob?.modelVersion || 'No processing job metadata'}
              </p>
              {relatedJob?.warnings && relatedJob.warnings.length > 0 && (
                <div className="mt-2 p-3 rounded-md bg-[#0D1F35] border border-[#EAB308]/35 space-y-1">
                  <p className="text-[#EAB308] font-medium flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    Processing Warnings &amp; Limitations
                  </p>
                  {relatedJob.warnings.map((w, i) => (
                    <p key={i} className="text-xs text-[#A9B8CA]">
                      • {w}
                    </p>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right Column: Detected Timeline Events & Risk Explanation */}
        <div className="xl:col-span-4 space-y-4">
          <div className="bg-[#122943] border border-[#233B56] rounded-lg p-5 space-y-3">
            <h2 className="text-base font-semibold text-[#F5F8FC]">
              Detected Events ({relatedEvents.length})
            </h2>
            {relatedEvents.length === 0 ? (
              <p className="text-xs text-[#A9B8CA]">
                No potential conflict events detected for this video clip.
              </p>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                {relatedEvents.map((ev) => {
                  const selected = activeEvent?.id === ev.id;
                  return (
                    <button
                      key={ev.id}
                      type="button"
                      onClick={() => jumpToEvent(ev.id, ev.timestampSec)}
                      className={`w-full text-left p-3 rounded-md border transition-colors ${
                        selected
                          ? 'bg-[#0D1F35] border-[#2585FF]'
                          : 'bg-[#0D1F35]/60 border-[#233B56] hover:border-[#2585FF]/50'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <RiskIndicator category={ev.riskCategory} score={ev.riskScore} compact />
                        <span className="text-xs font-mono tabular-nums text-[#45B5FF]">
                          @{ev.timestampSec.toFixed(1)}s
                        </span>
                      </div>
                      <p className="text-sm font-medium text-[#F5F8FC] mt-1">{ev.conflictType}</p>
                      <p className="text-xs text-[#A9B8CA] mt-0.5">
                        {ev.roadUsers.map((r) => r.replace('_', ' ')).join(' + ')} · {ev.validationStatus}
                      </p>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {activeEvent && (
            <div className="bg-[#122943] border border-[#233B56] rounded-lg p-5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-[#F5F8FC]">Selected Event Evidence</h3>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    data-testid="replay-event-btn"
                    onClick={() => replayEventContext(activeEvent.id, activeEvent.timestampSec)}
                    className="inline-flex items-center gap-1 px-2.5 py-1 bg-[#2585FF] hover:bg-[#1C74E8] text-white text-[11px] font-medium rounded"
                  >
                    <RotateCcw className="w-3 h-3" />
                    Replay (-2.5s / +2.5s)
                  </button>
                  <button
                    type="button"
                    onClick={() => navigate(`/events?eventId=${activeEvent.id}`)}
                    className="text-xs text-[#45B5FF] hover:underline"
                  >
                    Open Review
                  </button>
                </div>
              </div>
              <RiskIndicator category={activeEvent.riskCategory} score={activeEvent.riskScore} />
              <p className="text-xs text-[#F5F8FC] leading-relaxed">
                {activeEvent.evidenceSummary}
              </p>
              {activeEvent.involvedTrackIds && activeEvent.involvedTrackIds.length > 0 && (
                <p className="text-[11px] font-mono text-[#45B5FF]">
                  Involved Tracks: {activeEvent.involvedTrackIds.join(' ↔ ')}
                  {activeEvent.movementDirection ? ` · ${activeEvent.movementDirection}` : ''}
                </p>
              )}
              <div className="grid grid-cols-2 gap-2 text-xs pt-2 border-t border-[#233B56]">
                <div>
                  <span className="text-[#A9B8CA]">Interaction Tier:</span>{' '}
                  <span className="font-mono text-[#F5F8FC]">
                    {activeEvent.interactionTier || (activeEvent.riskScore >= 65 ? 'Near miss' : 'Potential conflict')}
                  </span>
                </div>
                <div>
                  <span className="text-[#A9B8CA]">Est. TTC:</span>{' '}
                  <span className="font-mono text-[#F5F8FC]">
                    {activeEvent.estimatedTtcSec !== null ? `${activeEvent.estimatedTtcSec}s` : 'N/A'}
                  </span>
                </div>
                <div>
                  <span className="text-[#A9B8CA]">Est. PET:</span>{' '}
                  <span className="font-mono text-[#F5F8FC]">
                    {activeEvent.estimatedPetSec !== undefined && activeEvent.estimatedPetSec !== null
                      ? `${activeEvent.estimatedPetSec}s`
                      : 'N/A'}
                  </span>
                </div>
                <div>
                  <span className="text-[#A9B8CA]">Evasive Action:</span>{' '}
                  <span
                    className={`font-mono ${
                      activeEvent.evasiveManeuverDetected ? 'text-[#F97316]' : 'text-[#A9B8CA]'
                    }`}
                  >
                    {activeEvent.evasiveManeuverDetected ? 'Detected' : 'Not detected'}
                  </span>
                </div>
                <div>
                  <span className="text-[#A9B8CA]">Confidence:</span>{' '}
                  <span className="font-mono text-[#F5F8FC]">
                    {Math.round(activeEvent.detectionConfidence * 100)}%
                  </span>
                </div>
                <div>
                  <span className="text-[#A9B8CA]">Min Clearance:</span>{' '}
                  <span className="font-mono text-[#F5F8FC]">
                    {activeEvent.estimatedMinSeparationPx !== null
                      ? `${activeEvent.estimatedMinSeparationPx} px`
                      : 'N/A'}
                  </span>
                </div>
                <div className="col-span-2">
                  <span className="text-[#A9B8CA]">Trajectory Convergence:</span>{' '}
                  <span className="font-mono text-[#F5F8FC]">
                    {activeEvent.trajectoryConvergenceDeg !== null
                      ? `${activeEvent.trajectoryConvergenceDeg}°`
                      : 'N/A'}
                  </span>
                </div>
              </div>
              <div className="pt-2 border-t border-[#233B56]">
                <p className="text-xs font-medium text-[#F5F8FC] mb-1">Contributing Factors</p>
                <ul className="space-y-1 text-xs text-[#A9B8CA]">
                  {activeEvent.contributingFactors.map((f, i) => (
                    <li key={i}>• {f}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
