import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Eye,
  EyeOff,
  GitBranch,
  Info,
  Loader2,
  Maximize2,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  SkipBack,
  Sparkles,
  Upload,
} from 'lucide-react';
import { useRoadshadow } from '../context/RoadshadowContext';
import { RiskIndicator } from '../components/RiskBadge';
import { canPerformAction } from '../engine/validation';
import type { DetectedObjectClass, GeminiRiskLevel } from '../types/roadshadow';

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

const CORE_CV_CLASSES: DetectedObjectClass[] = [
  'car',
  'motorcycle',
  'bus',
  'truck',
  'bicycle',
  'person',
];

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

  // Real detection counts by class (derived strictly from CV worker summary or actual detections; never fabricated)
  const detectionsByClass = useMemo(() => {
    const counts: Record<string, number> = {
      car: 0,
      motorcycle: 0,
      bus: 0,
      truck: 0,
      bicycle: 0,
      person: 0,
    };
    if (selectedVideo?.detectionsSummary?.by_class) {
      for (const [cls, val] of Object.entries(selectedVideo.detectionsSummary.by_class)) {
        counts[cls] = Number(val || 0);
      }
      return counts;
    }
    for (const det of selectedVideo?.detections ?? []) {
      counts[det.objectClass] = (counts[det.objectClass] || 0) + 1;
    }
    return counts;
  }, [selectedVideo?.detectionsSummary, selectedVideo?.detections]);

  // Real tracked road-user rows (prefers FastAPI tracks[] with exact speed_px_per_s, falls back to real trajectories[])
  const trackedRoadUsers = useMemo(() => {
    if (selectedVideo?.tracks && selectedVideo.tracks.length > 0) {
      return selectedVideo.tracks.map((tr) => {
        const pts = tr.trajectory || [];
        const firstT = pts.length > 0 ? pts[0].t : 0;
        const lastT = pts.length > 0 ? pts[pts.length - 1].t : 0;
        return {
          id: tr.id,
          objectClass: tr.class,
          avgConfidence: tr.avg_confidence,
          speedPxPerSec: tr.speed_px_per_s,
          pointsCount: pts.length,
          firstTimeSec: firstT,
          lastTimeSec: lastT,
          directionLabel: tr.direction_label || 'Tracked path',
        };
      });
    }
    if (selectedVideo?.trajectories && selectedVideo.trajectories.length > 0) {
      return selectedVideo.trajectories.map((traj) => {
        const pts = traj.positions || [];
        const firstT = pts.length > 0 ? pts[0].timestampSec : 0;
        const lastT = pts.length > 0 ? pts[pts.length - 1].timestampSec : 0;
        return {
          id: traj.trackingId,
          objectClass: traj.objectClass,
          avgConfidence: traj.trackingConfidence,
          speedPxPerSec: null as number | null,
          pointsCount: pts.length,
          firstTimeSec: firstT,
          lastTimeSec: lastT,
          directionLabel: traj.directionLabel,
        };
      });
    }
    return [];
  }, [selectedVideo?.tracks, selectedVideo?.trajectories]);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [showOverlay, setShowOverlay] = useState(true);
  const [showTrajectories, setShowTrajectories] = useState(true);
  const [activeEventId, setActiveEventId] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [liveRetryStage, setLiveRetryStage] = useState<string | null>(null);

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
  const geminiAnalysis = selectedVideo.geminiAnalysis ?? null;

  const getGeminiRiskStyle = (level: GeminiRiskLevel) => {
    switch (level) {
      case 'high':
        return 'bg-[#E5484D]/15 text-[#F87171] border-[#E5484D]/40';
      case 'medium':
        return 'bg-[#F97316]/15 text-[#FB923C] border-[#F97316]/40';
      case 'low':
        return 'bg-[#EAB308]/15 text-[#FACC15] border-[#EAB308]/40';
      default:
        return 'bg-[#22C55E]/15 text-[#4ADE80] border-[#22C55E]/40';
    }
  };

  const handleRunAiAnalysis = async () => {
    if (!selectedVideo || retrying) return;
    setRetrying(true);
    setLiveRetryStage('Submitting video to Gemini AI pipeline...');
    try {
      await retryVideoAnalysis(selectedVideo.id, (jobUpdate) => {
        setLiveRetryStage(jobUpdate.stageMessage || `${jobUpdate.status} (${jobUpdate.progressPercent}%)`);
      });
    } finally {
      setRetrying(false);
      setLiveRetryStage(null);
    }
  };

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
                  ? 'Stored Video · AI Analysis Failed'
                  : geminiAnalysis || relatedJob?.engineMode === 'GEMINI_AI'
                    ? `Gemini AI Video Analysis (${geminiAnalysis?.model_version || relatedJob?.modelVersion || 'gemini-4-hydrogen'})`
                    : 'Stored Video'}
            </span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!selectedVideo.isDemonstration && selectedVideo.status === 'Completed' && canRetry && (
            <button
              type="button"
              disabled={retrying}
              onClick={handleRunAiAnalysis}
              data-testid="rerun-ai-analysis-btn"
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-[#122943] hover:bg-[#173252] border border-[#233B56] disabled:opacity-50 text-[#F5F8FC] text-xs font-medium rounded-md whitespace-nowrap"
            >
              {retrying ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-[#45B5FF]" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5 text-[#45B5FF]" />
              )}
              {retrying ? 'Re-analysing...' : 'Re-run AI Analysis'}
            </button>
          )}
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
                {v.title} {v.isDemonstration ? '(Demo)' : v.status === 'Failed' ? '(AI Failed)' : ''}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Live Retry Progress Banner */}
      {retrying && liveRetryStage && (
        <div
          role="status"
          className="p-3.5 rounded-lg bg-[#0D1F35] border border-[#2585FF]/50 flex items-center gap-2.5 text-xs text-[#F5F8FC]"
        >
          <Loader2 className="w-4 h-4 animate-spin text-[#45B5FF] shrink-0" />
          <span>
            <strong className="text-[#45B5FF]">Gemini AI Analysis Running:</strong> {liveRetryStage}
          </span>
        </div>
      )}

      {/* Honest Failure / Retry Banner for stored non-demo videos that failed AI analysis */}
      {!selectedVideo.isDemonstration && selectedVideo.status === 'Failed' && (
        <div
          role="status"
          data-testid="video-ai-failed-banner"
          className="p-4 rounded-lg bg-[#122943] border border-[#EAB308]/50 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
        >
          <div className="flex items-start gap-2.5 text-xs text-[#A9B8CA]">
            <AlertTriangle className="w-4 h-4 text-[#EAB308] shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-[#F5F8FC]">
                Uploaded Video Stored — Gemini AI Analysis Did Not Complete
              </p>
              <p className="mt-0.5 leading-relaxed">
                {selectedVideo.errorMessage ||
                  relatedJob?.errorMessage ||
                  'Gemini multimodal analysis did not complete when this video was submitted. No synthetic events or detections were fabricated.'}
              </p>
            </div>
          </div>
          {canRetry && (
            <button
              type="button"
              disabled={retrying}
              onClick={handleRunAiAnalysis}
              data-testid="retry-ai-analysis-btn"
              className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-[#2585FF] hover:bg-[#1C74E8] disabled:opacity-50 text-white text-xs font-medium rounded-md whitespace-nowrap shrink-0"
            >
              {retrying ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5" />
              )}
              {retrying ? 'Analysing...' : 'Retry AI Analysis'}
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

          {/* Structured Gemini AI Video Intelligence Results */}
          {geminiAnalysis && (
            <section
              data-testid="gemini-video-intelligence-panel"
              className="bg-[#122943] border border-[#2585FF]/40 rounded-lg p-5 space-y-5"
            >
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#233B56] pb-4">
                <div>
                  <h2 className="text-base font-semibold text-[#F5F8FC] flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-[#45B5FF]" />
                    Gemini AI Video Intelligence
                  </h2>
                  <p className="text-xs text-[#A9B8CA] mt-0.5">
                    Multimodal footage understanding from actual uploaded video · Click any timestamp to jump the player
                  </p>
                </div>
                <div className="text-right text-[11px] font-mono text-[#A9B8CA]">
                  <p className="text-[#45B5FF]">{geminiAnalysis.model_version}</p>
                  <p>{new Date(geminiAnalysis.analyzed_at).toLocaleString()}</p>
                </div>
              </div>

              {/* Summary & Overall Assessment */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="p-4 rounded-md bg-[#0D1F35] border border-[#233B56] space-y-1.5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-[#45B5FF]">
                    Observed Video Summary
                  </p>
                  <p
                    data-testid="gemini-video-summary"
                    className="text-sm text-[#F5F8FC] leading-relaxed"
                  >
                    {geminiAnalysis.video_summary}
                  </p>
                </div>
                <div className="p-4 rounded-md bg-[#0D1F35] border border-[#233B56] space-y-1.5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-[#A9B8CA] flex items-center gap-1.5">
                    <Info className="w-3.5 h-3.5 text-[#45B5FF]" />
                    AI Safety Assessment (Provisional)
                  </p>
                  <p
                    data-testid="gemini-overall-assessment"
                    className="text-sm text-[#F5F8FC] leading-relaxed"
                  >
                    {geminiAnalysis.overall_assessment}
                  </p>
                </div>
              </div>

              {/* Detected Objects & Estimated Counts */}
              <div className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-[#A9B8CA]">
                  Observed Objects &amp; Road Users ({geminiAnalysis.detected_objects.length})
                </h3>
                {geminiAnalysis.detected_objects.length === 0 ? (
                  <p className="text-xs text-[#A9B8CA] p-3 rounded-md bg-[#0D1F35] border border-[#233B56]">
                    No distinct vehicles, pedestrians, or traffic objects were confidently identified in this footage.
                  </p>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                    {geminiAnalysis.detected_objects.map((obj, idx) => (
                      <div
                        key={`${obj.label}-${idx}`}
                        className="p-3 rounded-md bg-[#0D1F35] border border-[#233B56] space-y-1"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-semibold text-[#F5F8FC] capitalize">
                            {obj.label}
                          </span>
                          <span className="px-2 py-0.5 rounded bg-[#122943] border border-[#233B56] font-mono text-[11px] text-[#45B5FF]">
                            ~{obj.count_estimate}
                          </span>
                        </div>
                        {obj.notes && (
                          <p className="text-[11px] text-[#A9B8CA] leading-relaxed">{obj.notes}</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Timestamped AI Events Timeline */}
              <div className="space-y-2.5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-[#A9B8CA]">
                  Timestamped Timeline Events ({geminiAnalysis.events.length})
                </h3>
                {geminiAnalysis.events.length === 0 ? (
                  <p className="text-xs text-[#A9B8CA] p-3 rounded-md bg-[#0D1F35] border border-[#233B56]">
                    No distinct traffic events or anomalous interactions were observed during this clip.
                  </p>
                ) : (
                  <div className="space-y-2.5">
                    {geminiAnalysis.events.map((ev, idx) => (
                      <div
                        key={`${ev.timestamp_start}-${idx}`}
                        className="p-3.5 rounded-md bg-[#0D1F35] border border-[#233B56] space-y-2"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              replayStopAtRef.current = null;
                              setCurrentTime(Math.max(0, Math.min(duration, ev.timestamp_start_sec)));
                              setIsPlaying(false);
                            }}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-[#122943] hover:bg-[#173252] border border-[#2585FF]/40 font-mono text-xs text-[#45B5FF]"
                          >
                            <Clock className="w-3.5 h-3.5" />
                            {ev.timestamp_start} – {ev.timestamp_end}
                            {ev.is_approximate && (
                              <span className="text-[10px] text-[#A9B8CA]">(approx.)</span>
                            )}
                          </button>

                          <div className="flex items-center gap-2 text-[11px] font-mono">
                            <span className="px-2 py-0.5 rounded bg-[#122943] border border-[#233B56] text-[#A9B8CA]">
                              conf: {ev.confidence}
                            </span>
                            <span
                              className={`px-2 py-0.5 rounded border uppercase ${getGeminiRiskStyle(ev.risk_level)}`}
                            >
                              risk: {ev.risk_level}
                            </span>
                          </div>
                        </div>

                        <div>
                          <p className="text-sm font-semibold text-[#F5F8FC]">{ev.event}</p>
                          <p className="text-xs text-[#A9B8CA] mt-0.5">{ev.activity}</p>
                        </div>

                        {ev.reason && (
                          <p className="text-xs text-[#CBD5E1] leading-relaxed border-l-2 border-[#2585FF]/60 pl-2.5">
                            {ev.reason}
                          </p>
                        )}

                        {ev.objects_detected.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 pt-1">
                            {ev.objects_detected.map((o, i) => (
                              <span
                                key={`${o}-${i}`}
                                className="px-2 py-0.5 rounded bg-[#122943] border border-[#233B56] text-[11px] text-[#A9B8CA]"
                              >
                                {o}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Important Moments + Safety Observations */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
                <div className="p-4 rounded-md bg-[#0D1F35] border border-[#233B56] space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-[#A9B8CA]">
                    Important Moments ({geminiAnalysis.important_moments.length})
                  </h3>
                  {geminiAnalysis.important_moments.length === 0 ? (
                    <p className="text-xs text-[#A9B8CA]">No notable highlight moments flagged.</p>
                  ) : (
                    <ul className="space-y-2">
                      {geminiAnalysis.important_moments.map((m, idx) => (
                        <li key={`${m.timestamp}-${idx}`} className="flex items-start gap-2 text-xs">
                          <button
                            type="button"
                            onClick={() => {
                              replayStopAtRef.current = null;
                              setCurrentTime(Math.max(0, Math.min(duration, m.timestamp_sec)));
                              setIsPlaying(false);
                            }}
                            className="font-mono text-[#45B5FF] hover:underline shrink-0 mt-0.5"
                          >
                            @{m.timestamp}
                          </button>
                          <span className="text-[#F5F8FC] leading-relaxed">{m.description}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="p-4 rounded-md bg-[#0D1F35] border border-[#233B56] space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-[#A9B8CA] flex items-center gap-1.5">
                    <ShieldAlert className="w-3.5 h-3.5 text-[#EAB308]" />
                    Safety Observations ({geminiAnalysis.safety_observations.length})
                  </h3>
                  {geminiAnalysis.safety_observations.length === 0 ? (
                    <p className="text-xs text-[#A9B8CA] flex items-center gap-1.5">
                      <CheckCircle2 className="w-3.5 h-3.5 text-[#22C55E] shrink-0" />
                      No specific safety hazards flagged in this clip.
                    </p>
                  ) : (
                    <ul className="space-y-1.5 text-xs text-[#F5F8FC] list-disc pl-4">
                      {geminiAnalysis.safety_observations.map((obs, idx) => (
                        <li key={idx} className="leading-relaxed">
                          {obs}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </section>
          )}

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
                <p className="text-[#A9B8CA]">Observed Objects</p>
                <p className="text-sm font-mono tabular-nums font-semibold text-[#F5F8FC] mt-1">
                  {selectedVideo.detectionsSummary?.total_detections ??
                    selectedVideo.detections?.length ??
                    relatedJob?.detectedObjectCount ??
                    0}
                </p>
              </div>
              <div>
                <p className="text-[#A9B8CA]">
                  {geminiAnalysis && trackedRoadUsers.length === 0 ? 'AI Timeline Events' : 'Tracked IDs'}
                </p>
                <p className="text-sm font-mono tabular-nums font-semibold text-[#F5F8FC] mt-1">
                  {geminiAnalysis && trackedRoadUsers.length === 0
                    ? geminiAnalysis.events.length
                    : selectedVideo.trajectories?.length ?? relatedJob?.trackingCount ?? 0}
                </p>
              </div>
              <div>
                <p className="text-[#A9B8CA]">Safety Conflicts</p>
                <p className="text-sm font-mono tabular-nums font-semibold text-[#F5F8FC] mt-1">
                  {relatedEvents.length}
                </p>
              </div>
            </div>

            <div className="pt-3 border-t border-[#233B56] text-xs text-[#A9B8CA] space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p>
                  <span className="text-[#F5F8FC] font-medium">Model / Engine:</span>{' '}
                  {relatedJob?.modelVersion || 'No processing job metadata'}
                </p>
                {selectedVideo.width && selectedVideo.height && (
                  <p className="font-mono text-[#A9B8CA]">
                    {selectedVideo.width}×{selectedVideo.height}
                    {selectedVideo.fps ? ` · ${selectedVideo.fps} FPS` : ''}
                  </p>
                )}
              </div>

              {/* Detections Summary by Class */}
              <div data-testid="detections-by-class-grid" className="pt-2 border-t border-[#233B56]/70">
                <p className="text-xs font-medium text-[#F5F8FC] mb-2">
                  Detections by Road-User Class
                </p>
                <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                  {CORE_CV_CLASSES.map((cls) => {
                    const style = CLASS_STYLE[cls];
                    const count = detectionsByClass[cls] ?? 0;
                    return (
                      <div
                        key={cls}
                        className="p-2.5 rounded-md bg-[#0D1F35] border border-[#233B56] flex items-center justify-between gap-1.5"
                      >
                        <span className="flex items-center gap-1.5 text-[11px] text-[#A9B8CA] truncate">
                          <span
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{ backgroundColor: style.stroke }}
                          />
                          {style.label}
                        </span>
                        <span className="font-mono tabular-nums font-semibold text-[#F5F8FC]">
                          {count}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

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

          {/* Tracked Road Users Table */}
          <div
            data-testid="tracked-road-users-table"
            className="bg-[#122943] border border-[#233B56] rounded-lg overflow-hidden"
          >
            <div className="p-4 border-b border-[#233B56] flex items-center justify-between gap-2">
              <div>
                <h2 className="text-base font-semibold text-[#F5F8FC]">
                  Tracked Road Users ({trackedRoadUsers.length})
                </h2>
                <p className="text-xs text-[#A9B8CA]">
                  {geminiAnalysis && trackedRoadUsers.length === 0
                    ? 'Per-frame pixel-space bounding-box tracks are not generated by Gemini multimodal video analysis (see Observed Objects & Timestamped Timeline above).'
                    : 'Object tracks with average confidence and pixel-space speed (click a row to jump to its first frame)'}
                </p>
              </div>
            </div>
            {trackedRoadUsers.length === 0 ? (
              <div className="p-5 text-xs text-[#A9B8CA]">
                {geminiAnalysis
                  ? 'Gemini AI video analysis provides scene-level summaries, estimated object counts, safety observations, and timestamped events rather than per-frame pixel trajectories.'
                  : 'No tracked road users stored for this video yet.'}
              </div>
            ) : (
              <div className="overflow-x-auto max-h-64 overflow-y-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead className="sticky top-0 bg-[#0D1F35] border-b border-[#233B56] text-[#A9B8CA]">
                    <tr>
                      <th className="py-2 px-4 font-medium">Track ID</th>
                      <th className="py-2 px-4 font-medium">Class</th>
                      <th className="py-2 px-4 font-medium text-right">Avg Conf</th>
                      <th className="py-2 px-4 font-medium text-right">Speed (px/s)</th>
                      <th className="py-2 px-4 font-medium text-right">Time Span</th>
                      <th className="py-2 px-4 font-medium">Movement</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#233B56]">
                    {trackedRoadUsers.slice(0, 50).map((tr) => {
                      const style =
                        CLASS_STYLE[tr.objectClass as DetectedObjectClass] ||
                        CLASS_STYLE.other_vehicle;
                      return (
                        <tr
                          key={tr.id}
                          onClick={() => {
                            replayStopAtRef.current = null;
                            setCurrentTime(Math.max(0, Math.min(duration, tr.firstTimeSec)));
                            setIsPlaying(false);
                          }}
                          className="hover:bg-[#0D1F35]/70 cursor-pointer transition-colors"
                        >
                          <td className="py-2 px-4 font-mono text-[#45B5FF] whitespace-nowrap">
                            {tr.id}
                          </td>
                          <td className="py-2 px-4 whitespace-nowrap">
                            <span className="inline-flex items-center gap-1.5 text-[#F5F8FC]">
                              <span
                                className="w-2 h-2 rounded-full"
                                style={{ backgroundColor: style.stroke }}
                              />
                              {style.label}
                            </span>
                          </td>
                          <td className="py-2 px-4 text-right font-mono tabular-nums text-[#F5F8FC]">
                            {Math.round(tr.avgConfidence * 100)}%
                          </td>
                          <td className="py-2 px-4 text-right font-mono tabular-nums text-[#F5F8FC]">
                            {tr.speedPxPerSec !== null ? `${tr.speedPxPerSec.toFixed(1)}` : 'N/A'}
                          </td>
                          <td className="py-2 px-4 text-right font-mono tabular-nums text-[#A9B8CA] whitespace-nowrap">
                            {tr.firstTimeSec.toFixed(1)}s – {tr.lastTimeSec.toFixed(1)}s ({tr.pointsCount} pts)
                          </td>
                          <td className="py-2 px-4 text-[#A9B8CA] truncate max-w-[160px]">
                            {tr.directionLabel}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
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
                <div>
                  <span className="text-[#A9B8CA]">Severity Band:</span>{' '}
                  <span className="font-mono uppercase text-[#F5F8FC]">
                    {activeEvent.severity || activeEvent.riskCategory.toLowerCase()}
                  </span>
                </div>
                <div>
                  <span className="text-[#A9B8CA]">Detection Method:</span>{' '}
                  <span className="font-mono text-[#F5F8FC]">
                    {activeEvent.detectionMethod || 'ttc_proximity'}
                  </span>
                </div>
                <div>
                  <span className="text-[#A9B8CA]">Location (x, y):</span>{' '}
                  <span className="font-mono text-[#F5F8FC]">
                    {activeEvent.locationXy && activeEvent.locationXy.length === 2
                      ? `(${Math.round(activeEvent.locationXy[0])}, ${Math.round(activeEvent.locationXy[1])})`
                      : 'N/A'}
                  </span>
                </div>
                <div>
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

          {/* Documented Conflict Thresholds Returned by CV Service */}
          {selectedVideo.thresholds && (
            <div className="bg-[#122943] border border-[#233B56] rounded-lg p-5 space-y-2.5 text-xs">
              <h3 className="text-sm font-semibold text-[#F5F8FC]">
                Documented Conflict Thresholds
              </h3>
              <div className="grid grid-cols-2 gap-2 font-mono text-[11px] text-[#A9B8CA]">
                {selectedVideo.thresholds.proximity_px !== undefined && (
                  <div>
                    Proximity: <span className="text-[#F5F8FC]">{selectedVideo.thresholds.proximity_px} px</span>
                  </div>
                )}
                {selectedVideo.thresholds.max_ttc_s !== undefined && (
                  <div>
                    Max TTC: <span className="text-[#F5F8FC]">{selectedVideo.thresholds.max_ttc_s}s</span>
                  </div>
                )}
                {selectedVideo.thresholds.max_pet_s !== undefined && (
                  <div>
                    Max PET: <span className="text-[#F5F8FC]">{selectedVideo.thresholds.max_pet_s}s</span>
                  </div>
                )}
                {selectedVideo.thresholds.min_closing_speed_px_per_s !== undefined && (
                  <div>
                    Min Closing: <span className="text-[#F5F8FC]">{selectedVideo.thresholds.min_closing_speed_px_per_s} px/s</span>
                  </div>
                )}
              </div>
              {selectedVideo.thresholds.severity && (
                <div className="pt-2 border-t border-[#233B56] space-y-1 text-[11px] text-[#A9B8CA]">
                  {Object.entries(selectedVideo.thresholds.severity).map(([band, rule]) => (
                    <p key={band}>
                      <span className="font-mono uppercase text-[#F5F8FC]">{band}:</span>{' '}
                      {String(rule)}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
