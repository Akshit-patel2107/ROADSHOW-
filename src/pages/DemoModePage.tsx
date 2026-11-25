import {
  Activity,
  CheckCircle2,
  Database,
  PlaySquare,
  RotateCcw,
  Shield,
  UserCheck,
  Video,
  MapPin,
  AlertTriangle,
  Fingerprint,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useRoadshadow } from '../context/RoadshadowContext';
import type { UserRole } from '../types/roadshadow';

const ROLE_OPTIONS: Array<{
  role: UserRole;
  title: string;
  summary: string;
}> = [
  {
    role: 'ADMINISTRATOR',
    title: 'Administrator',
    summary: 'Full access to projects, locations, cameras, video uploads, role management, and risk configuration.',
  },
  {
    role: 'ANALYST',
    title: 'Safety Analyst',
    summary: 'Can upload footage, validate conflict events, investigate fingerprints, and generate AI recommendations & reports.',
  },
  {
    role: 'VIEWER',
    title: 'Department Viewer',
    summary: 'Read-only access to dashboards, risk maps, analytics, and exported audit reports without modifying records.',
  },
];

export function DemoModePage() {
  const {
    isDemoMode,
    currentUser,
    firebaseUser,
    enterDemoMode,
    exitDemoMode,
    switchDemoRole,
    resetDemoDataset,
    projects,
    locations,
    videos,
    conflictEvents,
    conflictFingerprints,
    recommendations,
    reports,
  } = useRoadshadow();
  const navigate = useNavigate();

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-[#233B56] pb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[#F5F8FC]">
            Demonstration Mode
          </h1>
          <p className="text-sm text-[#A9B8CA] mt-1 max-w-3xl">
            Explore ROADSHADOW with the Anand Road Safety Pilot sample dataset, or switch back to your authenticated Cloud Firestore workspace. Sample data is always explicitly labelled and never presented as live camera tracking.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          {isDemoMode ? (
            <>
              <button
                type="button"
                onClick={resetDemoDataset}
                className="inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium bg-[#122943] hover:bg-[#193656] text-[#F5F8FC] border border-[#233B56] rounded-md transition-colors"
              >
                <RotateCcw className="w-4 h-4 text-[#45B5FF]" aria-hidden="true" />
                Reset Sample Data
              </button>
              <button
                type="button"
                onClick={() => {
                  exitDemoMode();
                  if (!firebaseUser) {
                    navigate('/');
                  }
                }}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-[#2585FF] hover:bg-[#1C74E8] text-white rounded-md transition-colors"
              >
                <Database className="w-4 h-4" aria-hidden="true" />
                {firebaseUser ? 'Return to Live Firestore Workspace' : 'Exit Demo & Sign In'}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => enterDemoMode('ADMINISTRATOR')}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-[#2585FF] hover:bg-[#1C74E8] text-white rounded-md transition-colors"
            >
              <PlaySquare className="w-4 h-4" aria-hidden="true" />
              Activate Demonstration Mode
            </button>
          )}
        </div>
      </div>

      {/* Active Workspace Status Banner */}
      <section
        aria-label="Workspace mode status"
        className="bg-[#122943] border border-[#233B56] rounded-lg p-5 flex flex-col md:flex-row md:items-center justify-between gap-4"
      >
        <div className="flex items-start gap-3.5">
          <div className="w-10 h-10 rounded-md bg-[#0D1F35] border border-[#233B56] flex items-center justify-center shrink-0">
            {isDemoMode ? (
              <Activity className="w-5 h-5 text-[#45B5FF]" aria-hidden="true" />
            ) : (
              <Database className="w-5 h-5 text-[#22C55E]" aria-hidden="true" />
            )}
          </div>
          <div>
            <div className="flex items-center gap-2.5 flex-wrap">
              <h2 className="text-base font-semibold text-[#F5F8FC]">
                {isDemoMode ? 'Demonstration Workspace Active' : 'Live Cloud Firestore Workspace Active'}
              </h2>
              <span
                className={`text-xs font-mono px-2 py-0.5 rounded border ${
                  isDemoMode
                    ? 'border-[#2585FF]/40 bg-[#2585FF]/15 text-[#45B5FF]'
                    : 'border-[#22C55E]/40 bg-[#22C55E]/15 text-[#22C55E]'
                }`}
              >
                {isDemoMode ? 'DEMONSTRATION' : 'LIVE FIRESTORE'}
              </span>
            </div>
            <p className="text-sm text-[#A9B8CA] mt-1">
              {isDemoMode
                ? 'Changes made in Demonstration Mode are held in browser memory for evaluation and do not modify production Firestore collections.'
                : 'All projects, locations, uploaded videos, analyst validations, and audit records are persisted in your Cloud Firestore database.'}
            </p>
          </div>
        </div>
      </section>

      {/* Role Switcher in Demo Mode */}
      <section className="bg-[#122943] border border-[#233B56] rounded-lg p-5 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-[#F5F8FC] flex items-center gap-2">
              <UserCheck className="w-4 h-4 text-[#45B5FF]" aria-hidden="true" />
              Role-Based Access Testing
            </h2>
            <p className="text-xs text-[#A9B8CA] mt-0.5">
              {isDemoMode
                ? 'Switch between Administrator, Safety Analyst, and Department Viewer roles to inspect RBAC controls across the platform.'
                : 'Activate Demonstration Mode to preview different permission tiers without changing your live account role.'}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {ROLE_OPTIONS.map((opt) => {
            const isActive = isDemoMode && currentUser?.role === opt.role;
            return (
              <div
                key={opt.role}
                className={`p-4 rounded-md border flex flex-col justify-between gap-3 ${
                  isActive
                    ? 'bg-[#0D1F35] border-[#2585FF]'
                    : 'bg-[#071426] border-[#233B56]'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-[#F5F8FC]">{opt.title}</h3>
                    {isActive && (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-[#45B5FF]">
                        <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                        Active
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-[#A9B8CA] mt-1.5 leading-relaxed">{opt.summary}</p>
                </div>

                <button
                  type="button"
                  disabled={!isDemoMode || isActive}
                  onClick={() => switchDemoRole(opt.role)}
                  className={`w-full px-3 py-2 text-xs font-medium rounded-md border transition-colors ${
                    isActive
                      ? 'bg-[#2585FF]/15 border-[#2585FF]/40 text-[#45B5FF] cursor-default'
                      : isDemoMode
                        ? 'bg-[#122943] hover:bg-[#193656] border-[#233B56] text-[#F5F8FC]'
                        : 'bg-[#0D1F35] border-[#233B56] text-[#A9B8CA]/60 cursor-not-allowed'
                  }`}
                >
                  {isActive ? 'Current Role' : `Preview as ${opt.title}`}
                </button>
              </div>
            );
          })}
        </div>
      </section>

      {/* Dataset Provenance & Included Pilot Studies */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[#122943] border border-[#233B56] rounded-lg p-5 space-y-4">
          <h2 className="text-base font-semibold text-[#F5F8FC] flex items-center gap-2">
            <Shield className="w-4 h-4 text-[#45B5FF]" aria-hidden="true" />
            Pilot Dataset Provenance
          </h2>
          <p className="text-sm text-[#A9B8CA] leading-relaxed">
            The bundled demonstration workspace models three Indian urban and semi-urban corridor studies in Anand, Gujarat so municipal officers and traffic researchers can immediately evaluate near-miss review, conflict fingerprinting, geospatial risk mapping, and Gemini safety recommendations:
          </p>
          <ul className="space-y-2.5 text-sm text-[#F5F8FC]">
            <li className="p-3 rounded-md bg-[#0D1F35] border border-[#233B56]">
              <p className="font-medium">Anand Road Safety Pilot</p>
              <p className="text-xs text-[#A9B8CA] mt-0.5">
                Ganesh Chokdi Intersection, Vallabh Vidyanagar Bus Stand Road, and NH-48 Highway Merge Corridor.
              </p>
            </li>
            <li className="p-3 rounded-md bg-[#0D1F35] border border-[#233B56]">
              <p className="font-medium">School Zone Safety Study</p>
              <p className="text-xs text-[#A9B8CA] mt-0.5">
                Vidya Vihar School Crossing pedestrian versus two-wheeler &amp; car peak dismissal conflicts.
              </p>
            </li>
            <li className="p-3 rounded-md bg-[#0D1F35] border border-[#233B56]">
              <p className="font-medium">Hospital Entrance Traffic Study</p>
              <p className="text-xs text-[#A9B8CA] mt-0.5">
                Shree Krishna Hospital Main Gate sudden braking and auto-rickshaw curb-merge interactions.
              </p>
            </li>
          </ul>
        </div>

        <div className="bg-[#122943] border border-[#233B56] rounded-lg p-5 space-y-4">
          <h2 className="text-base font-semibold text-[#F5F8FC]">
            Loaded Workspace Inventory
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {[
              { label: 'Projects', count: projects.length, icon: Database },
              { label: 'Locations', count: locations.length, icon: MapPin },
              { label: 'Videos', count: videos.length, icon: Video },
              { label: 'Conflict Events', count: conflictEvents.length, icon: AlertTriangle },
              { label: 'Fingerprints', count: conflictFingerprints.length, icon: Fingerprint },
              { label: 'Recommendations & Reports', count: recommendations.length + reports.length, icon: CheckCircle2 },
            ].map((item) => {
              const Icon = item.icon;
              return (
                <div
                  key={item.label}
                  className="p-3.5 rounded-md bg-[#0D1F35] border border-[#233B56]"
                >
                  <div className="flex items-center justify-between text-[#A9B8CA]">
                    <Icon className="w-4 h-4 text-[#45B5FF]" aria-hidden="true" />
                  </div>
                  <p className="text-xl font-bold font-mono tabular-nums text-[#F5F8FC] mt-2">
                    {item.count}
                  </p>
                  <p className="text-xs text-[#A9B8CA] mt-0.5">{item.label}</p>
                </div>
              );
            })}
          </div>

          <div className="p-3.5 rounded-md bg-[#071426] border border-[#233B56] text-xs text-[#A9B8CA] leading-relaxed">
            <strong className="text-[#F5F8FC]">Transparency Notice:</strong> Precomputed Anand pilot records are strictly isolated inside Demonstration Mode. Uploading a new video invokes the real backend validation (ffprobe), thumbnail extraction, and storage pipeline, and forwards footage to the configured external CV worker (<span className="font-mono">CV_SERVICE_URL</span>) — honestly reporting Real CV Analysis as unavailable if no worker is connected, without fabricating fake detections.
          </div>
        </div>
      </section>
    </div>
  );
}
