import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, CheckCircle2, Radio, RefreshCw, ShieldCheck, Upload } from 'lucide-react';
import { useRoadshadow } from '../context/RoadshadowContext';
import { roadshadowFetch } from '../lib/apiClient';

export function LiveAnalysisPage() {
  const {
    cameras,
    locations,
    selectedProjectId,
    serverHealth,
    refreshServerHealth,
    currentUser,
    isDemoMode,
    pushToast,
  } = useRoadshadow();
  const navigate = useNavigate();

  const scopedCameras = useMemo(
    () =>
      cameras.filter((c) =>
        selectedProjectId === 'ALL' ? true : c.projectId === selectedProjectId
      ),
    [cameras, selectedProjectId]
  );

  const [selectedCameraId, setSelectedCameraId] = useState(scopedCameras[0]?.id || cameras[0]?.id || '');
  const [streamHost, setStreamHost] = useState('');
  const [protocol, setProtocol] = useState<'rtsp' | 'rtsps'>('rtsps');
  const [testing, setTesting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    const pool = scopedCameras.length > 0 ? scopedCameras : cameras;
    if (pool.length === 0) return;
    if (!selectedCameraId || !pool.some((c) => c.id === selectedCameraId)) {
      setSelectedCameraId(pool[0].id);
    }
  }, [scopedCameras, cameras, selectedCameraId]);

  const handleValidateRtsp = async (e: React.FormEvent) => {
    e.preventDefault();
    setTestResult(null);
    if (!selectedCameraId || !streamHost.trim()) {
      setTestResult({ ok: false, message: 'Select a camera and enter a permitted RTSP host domain.' });
      return;
    }
    setTesting(true);
    try {
      const resp = await roadshadowFetch('/api/cameras/rtsp-config', {
        method: 'POST',
        isDemoMode,
        demoRole: currentUser?.role,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cameraId: selectedCameraId,
          streamHost: streamHost.trim(),
          protocol,
          streamPort: 554,
          streamPath: '/stream1',
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setTestResult({ ok: false, message: data.error || 'RTSP validation failed.' });
      } else {
        const liveConnected = Boolean(data.liveConnected);
        setTestResult({ ok: liveConnected, message: data.message });
        pushToast({
          type: liveConnected ? 'success' : 'info',
          title: liveConnected ? 'RTSP Stream Connected' : 'RTSP Endpoint Validated (Not Connected)',
          description: data.message,
        });
      }
    } catch {
      setTestResult({ ok: false, message: 'Network error validating RTSP adapter.' });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold text-[#F5F8FC]">Live CCTV &amp; RTSP Analysis Adapter</h1>
        <p className="text-sm text-[#A9B8CA] mt-1">
          Secure server-side RTSP-to-Processing-Service architecture. ROADSHADOW never renders fake live CCTV feeds or exposes camera credentials to browsers.
        </p>
      </div>

      {/* Honest Worker Connection State */}
      <div className="bg-[#122943] border border-[#233B56] rounded-lg p-6 space-y-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-3">
            <Radio
              className={`w-5 h-5 mt-0.5 shrink-0 ${
                serverHealth.cvAdapter.rtspIngestionReady ? 'text-[#22C55E]' : 'text-[#EAB308]'
              }`}
            />
            <div>
              <h2 className="text-base font-semibold text-[#F5F8FC]">
                External CV Stream Ingestion Status:{' '}
                {serverHealth.cvAdapter.rtspIngestionReady
                  ? 'Connected'
                  : serverHealth.cvAdapter.status === 'unavailable'
                    ? 'CV Worker Unreachable'
                    : 'Not Connected (Upload Mode Active)'}
              </h2>
              <p className="text-sm text-[#A9B8CA] mt-1 leading-relaxed">
                {serverHealth.cvAdapter.rtspIngestionReady
                  ? `External Python FastAPI CV Worker is reachable via CV_SERVICE_URL (${serverHealth.cvAdapter.modelVersion || 'YOLO + ByteTrack'}) for authenticated RTSP stream probing and ingestion.`
                  : 'ROADSHADOW runs on uploaded traffic footage (MP4/MOV/WebM) until an external CV worker is connected. Deploy the included Python FastAPI + OpenCV + YOLO/ByteTrack worker (cv_worker/main.py) inside the municipal network and configure CV_SERVICE_URL and CV_SERVICE_API_KEY in server environment variables.'}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={refreshing}
              onClick={async () => {
                setRefreshing(true);
                try {
                  await refreshServerHealth(true);
                } finally {
                  setRefreshing(false);
                }
              }}
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-[#0D1F35] hover:bg-[#173252] border border-[#233B56] text-[#F5F8FC] text-xs font-medium rounded-md whitespace-nowrap"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh Status
            </button>
            <button
              type="button"
              onClick={() => navigate('/upload')}
              className="inline-flex items-center gap-2 px-4 py-2 bg-[#2585FF] hover:bg-[#1C74E8] text-white text-sm font-medium rounded-md whitespace-nowrap"
            >
              <Upload className="w-4 h-4" />
              Analyse Uploaded Video
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 pt-4 border-t border-[#233B56] text-xs">
          {[
            { step: '01. Municipal Camera', detail: 'Authenticated RTSP/RTSPS stream stays inside private NVR subnet.' },
            { step: '02. Python FastAPI Worker', detail: 'cv_worker/main.py decodes frames via OpenCV + YOLO + ByteTrack.' },
            { step: '03. Trajectory Engine', detail: 'Computes pixel/calibrated separation, convergence, and provisional risk.' },
            { step: '04. Cloud Firestore', detail: 'Stores structured conflict events only — never exposing RTSP credentials.' },
          ].map((item) => (
            <div key={item.step} className="p-3 rounded-md bg-[#0D1F35] border border-[#233B56]">
              <p className="font-semibold text-[#F5F8FC]">{item.step}</p>
              <p className="text-[#A9B8CA] mt-1 leading-relaxed">{item.detail}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Secure Server-Side RTSP Policy Validator */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <form
          onSubmit={handleValidateRtsp}
          className="bg-[#122943] border border-[#233B56] rounded-lg p-5 space-y-4"
        >
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-[#45B5FF]" />
            <h2 className="text-base font-semibold text-[#F5F8FC]">
              Validate RTSP Processing Adapter
            </h2>
          </div>
          <p className="text-xs text-[#A9B8CA]">
            Checks camera stream host security policy on the server and actively probes the stream through the CV worker when available — never persisting or returning credentials to client state.
          </p>

          <div>
            <label htmlFor="rtsp-cam" className="block text-xs font-medium text-[#A9B8CA] mb-1.5">
              Registered Camera
            </label>
            <select
              id="rtsp-cam"
              value={selectedCameraId}
              onChange={(e) => setSelectedCameraId(e.target.value)}
              className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC]"
            >
              {(scopedCameras.length > 0 ? scopedCameras : cameras).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.status})
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label htmlFor="rtsp-proto" className="block text-xs font-medium text-[#A9B8CA] mb-1.5">
                Protocol
              </label>
              <select
                id="rtsp-proto"
                value={protocol}
                onChange={(e) => setProtocol(e.target.value as 'rtsp' | 'rtsps')}
                className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC] font-mono"
              >
                <option value="rtsps">rtsps://</option>
                <option value="rtsp">rtsp://</option>
              </select>
            </div>
            <div className="col-span-2">
              <label htmlFor="rtsp-host" className="block text-xs font-medium text-[#A9B8CA] mb-1.5">
                Stream Gateway Hostname
              </label>
              <input
                id="rtsp-host"
                type="text"
                value={streamHost}
                onChange={(e) => setStreamHost(e.target.value)}
                placeholder="cctv-gateway.smartcity.gov.in"
                className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC] font-mono"
              />
            </div>
          </div>

          {testResult && (
            <div
              role="status"
              className={`p-3 rounded-md border text-xs flex items-start gap-2 ${
                testResult.ok
                  ? 'bg-[#22C55E]/10 border-[#22C55E]/40 text-[#F5F8FC]'
                  : 'bg-[#EAB308]/10 border-[#EAB308]/40 text-[#F5F8FC]'
              }`}
            >
              {testResult.ok ? (
                <CheckCircle2 className="w-4 h-4 text-[#22C55E] shrink-0 mt-0.5" />
              ) : (
                <AlertCircle className="w-4 h-4 text-[#EAB308] shrink-0 mt-0.5" />
              )}
              <span className="leading-relaxed">{testResult.message}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={testing}
            className="px-4 py-2 bg-[#2585FF] hover:bg-[#1C74E8] disabled:opacity-50 text-white text-sm font-medium rounded-md"
          >
            {testing ? 'Validating...' : 'Validate & Probe RTSP Adapter'}
          </button>
        </form>

        {/* Registered Cameras Readiness */}
        <div className="bg-[#122943] border border-[#233B56] rounded-lg p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-[#F5F8FC]">
              Camera Stream Readiness ({scopedCameras.length})
            </h2>
            <button
              type="button"
              onClick={() => navigate('/cameras')}
              className="text-xs text-[#45B5FF] hover:underline"
            >
              Manage Cameras
            </button>
          </div>
          {scopedCameras.length === 0 ? (
            <p className="text-xs text-[#A9B8CA] py-4">
              No cameras registered under the currently selected project.
            </p>
          ) : (
            <div className="divide-y divide-[#233B56]">
              {scopedCameras.map((cam) => {
                const loc = locations.find((l) => l.id === cam.locationId);
                return (
                  <div key={cam.id} className="py-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-[#F5F8FC] truncate">{cam.name}</p>
                      <p className="text-xs text-[#A9B8CA] truncate">
                        {loc?.name || cam.locationId} · {cam.resolution} · {cam.status}
                      </p>
                    </div>
                    <span className="text-xs font-mono text-[#A9B8CA] whitespace-nowrap">
                      {cam.rtspAdapterEnabled
                        ? serverHealth.cvAdapter.rtspIngestionReady
                          ? 'RTSP Ready'
                          : 'RTSP Not Connected'
                        : 'Upload Only'}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
