import React, { useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Archive,
  Bell,
  CheckCircle2,
  FolderKanban,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Server,
  Sliders,
  Trash2,
  User,
  XCircle,
} from 'lucide-react';
import { useRoadshadow } from '../context/RoadshadowContext';
import { ConfirmDialog } from '../components/ToastContainer';
import { canPerformAction } from '../engine/validation';
import type { Project } from '../types/roadshadow';

export function SettingsPage() {
  const {
    currentUser,
    isDemoMode,
    projects,
    settings,
    serverHealth,
    refreshServerHealth,
    updateCurrentUserProfile,
    requestPasswordReset,
    createProject,
    updateProject,
    deleteProject,
    updateWorkspaceSettings,
    pushToast,
  } = useRoadshadow();

  const canManageProjects = currentUser
    ? canPerformAction(currentUser.role, 'manage_projects')
    : false;
  const canManageSettings = currentUser
    ? canPerformAction(currentUser.role, 'manage_settings')
    : false;

  const [checkingCvHealth, setCheckingCvHealth] = useState(false);

  // Profile state
  const [displayName, setDisplayName] = useState(currentUser?.displayName ?? '');
  const [photoURL, setPhotoURL] = useState(currentUser?.photoURL ?? '');
  const [notifyCritical, setNotifyCritical] = useState(
    currentUser?.notifyCriticalEvents ?? true
  );
  const [notifyJob, setNotifyJob] = useState(currentUser?.notifyJobCompletion ?? true);
  const [notifyWeekly, setNotifyWeekly] = useState(
    currentUser?.notifyWeeklySummary ?? false
  );
  const [savingProfile, setSavingProfile] = useState(false);

  // Risk scoring settings state
  const [lowMax, setLowMax] = useState(settings.riskBands.lowMax);
  const [mediumMax, setMediumMax] = useState(settings.riskBands.mediumMax);
  const [highMax, setHighMax] = useState(settings.riskBands.highMax);
  const [maxUploadMb, setMaxUploadMb] = useState(settings.maxUploadMb);
  const [savingRisk, setSavingRisk] = useState(false);

  // Project CRUD state
  const [projectFormOpen, setProjectFormOpen] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [projName, setProjName] = useState('');
  const [projDesc, setProjDesc] = useState('');
  const [projStartDate, setProjStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [projEndDate, setProjEndDate] = useState('');
  const [projSubmitting, setProjSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);

  useEffect(() => {
    if (currentUser) {
      setDisplayName(currentUser.displayName);
      setPhotoURL(currentUser.photoURL ?? '');
      setNotifyCritical(currentUser.notifyCriticalEvents);
      setNotifyJob(currentUser.notifyJobCompletion);
      setNotifyWeekly(currentUser.notifyWeeklySummary);
    }
  }, [currentUser]);

  useEffect(() => {
    setLowMax(settings.riskBands.lowMax);
    setMediumMax(settings.riskBands.mediumMax);
    setHighMax(settings.riskBands.highMax);
    setMaxUploadMb(settings.maxUploadMb);
  }, [settings]);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!displayName.trim()) {
      pushToast({ type: 'error', title: 'Display name is required.' });
      return;
    }
    setSavingProfile(true);
    try {
      await updateCurrentUserProfile({
        displayName: displayName.trim(),
        photoURL: photoURL.trim() || undefined,
        notifyCriticalEvents: notifyCritical,
        notifyJobCompletion: notifyJob,
        notifyWeeklySummary: notifyWeekly,
      });
    } finally {
      setSavingProfile(false);
    }
  };

  const handlePasswordReset = async () => {
    if (!currentUser?.email) return;
    if (isDemoMode) {
      pushToast({
        type: 'info',
        title: 'Password Reset Unavailable in Demo Mode',
        description: 'Sign in with a live Firebase Email/Password account to trigger password reset emails.',
      });
      return;
    }
    try {
      await requestPasswordReset(currentUser.email);
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Reset Request Failed',
        description: err instanceof Error ? err.message : 'Unable to send reset link.',
      });
    }
  };

  const openNewProjectForm = () => {
    setEditingProjectId(null);
    setProjName('');
    setProjDesc('');
    setProjStartDate(new Date().toISOString().slice(0, 10));
    setProjEndDate('');
    setProjectFormOpen(true);
  };

  const openEditProjectForm = (p: Project) => {
    setEditingProjectId(p.id);
    setProjName(p.name);
    setProjDesc(p.description);
    setProjStartDate(p.startDate);
    setProjEndDate(p.endDate ?? '');
    setProjectFormOpen(true);
  };

  const handleProjectSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projName.trim() || !projDesc.trim()) {
      pushToast({
        type: 'error',
        title: 'Incomplete Project Form',
        description: 'Project name and description are required.',
      });
      return;
    }
    setProjSubmitting(true);
    try {
      if (editingProjectId) {
        await updateProject(editingProjectId, {
          name: projName.trim(),
          description: projDesc.trim(),
          startDate: projStartDate,
          endDate: projEndDate || undefined,
        });
      } else {
        await createProject({
          name: projName.trim(),
          description: projDesc.trim(),
          startDate: projStartDate,
          endDate: projEndDate || undefined,
          status: 'active',
        });
      }
      setProjectFormOpen(false);
    } finally {
      setProjSubmitting(false);
    }
  };

  const handleSaveRiskSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!(lowMax < mediumMax && mediumMax < highMax && highMax < 100 && lowMax >= 5)) {
      pushToast({
        type: 'error',
        title: 'Invalid Risk Thresholds',
        description: 'Ensure 5 <= Low Max < Medium Max < High Max < 100.',
      });
      return;
    }
    setSavingRisk(true);
    try {
      await updateWorkspaceSettings({
        riskBands: { lowMax, mediumMax, highMax },
        maxUploadMb: Math.max(10, Math.min(2000, maxUploadMb)),
      });
    } finally {
      setSavingRisk(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="border-b border-[#233B56] pb-5">
        <h1 className="text-2xl font-bold tracking-tight text-[#F5F8FC]">
          Settings &amp; Project Administration
        </h1>
        <p className="text-sm text-[#A9B8CA] mt-1">
          Verify computer vision service health, manage your profile, safety study projects, and provisional risk scoring band boundaries.
        </p>
      </div>

      {/* 0. Gemini AI Video Analysis Engine Health Check (/api/health) */}
      <section
        data-testid="cv-service-health-section"
        className="bg-[#122943] border border-[#233B56] rounded-lg p-5 space-y-4"
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[#233B56] pb-3.5">
          <div>
            <h2 className="text-base font-semibold text-[#F5F8FC] flex items-center gap-2">
              <Server className="w-4 h-4 text-[#45B5FF]" aria-hidden="true" />
              Gemini AI Video Analysis Engine Health (<span className="font-mono text-[#45B5FF]">/api/health</span>)
            </h2>
            <p className="text-xs text-[#A9B8CA] mt-0.5">
              Server-side connectivity check for multimodal video analysis powered by{' '}
              <span className="font-mono text-[#F5F8FC]">@google/genai</span> and{' '}
              <span className="font-mono text-[#F5F8FC]">GEMINI_API_KEY</span>.
            </p>
          </div>
          <button
            type="button"
            data-testid="run-cv-health-check-btn"
            disabled={checkingCvHealth}
            onClick={async () => {
              setCheckingCvHealth(true);
              try {
                const fresh = await refreshServerHealth(true);
                pushToast({
                  type:
                    fresh.cvAdapter.status === 'available'
                      ? 'success'
                      : fresh.cvAdapter.status === 'unavailable'
                        ? 'error'
                        : 'warning',
                  title:
                    fresh.cvAdapter.status === 'available'
                      ? 'Gemini AI Engine Ready'
                      : fresh.cvAdapter.status === 'unavailable'
                        ? 'Gemini API Connection Issue'
                        : 'GEMINI_API_KEY Not Configured',
                  description: fresh.cvAdapter.message,
                });
              } finally {
                setCheckingCvHealth(false);
              }
            }}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium bg-[#2585FF] hover:bg-[#1C74E8] disabled:opacity-60 text-white rounded-md transition-colors self-start sm:self-auto whitespace-nowrap"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${checkingCvHealth ? 'animate-spin' : ''}`} aria-hidden="true" />
            {checkingCvHealth ? 'Checking AI Engine...' : 'Run Health Check'}
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
          <div className="p-3 rounded-md bg-[#0D1F35] border border-[#233B56]">
            <p className="text-[#A9B8CA]">Engine Status</p>
            <p
              data-testid="cv-health-status-value"
              className={`mt-1.5 font-mono font-semibold flex items-center gap-1.5 ${
                serverHealth.cvAdapter.status === 'available'
                  ? 'text-[#22C55E]'
                  : serverHealth.cvAdapter.status === 'unavailable'
                    ? 'text-[#E5484D]'
                    : 'text-[#EAB308]'
              }`}
            >
              {serverHealth.cvAdapter.status === 'available' ? (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  AVAILABLE
                </>
              ) : serverHealth.cvAdapter.status === 'unavailable' ? (
                <>
                  <XCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  UNAVAILABLE
                </>
              ) : (
                <>
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  NOT CONFIGURED
                </>
              )}
            </p>
          </div>

          <div className="p-3 rounded-md bg-[#0D1F35] border border-[#233B56]">
            <p className="text-[#A9B8CA]">Active Model</p>
            <p className="mt-1.5 font-mono text-[#F5F8FC] truncate">
              {serverHealth.cvAdapter.modelVersion || 'Not configured'}
            </p>
          </div>

          <div className="p-3 rounded-md bg-[#0D1F35] border border-[#233B56]">
            <p className="text-[#A9B8CA]">API Latency &amp; Mode</p>
            <p className="mt-1.5 font-mono tabular-nums text-[#F5F8FC]">
              {serverHealth.cvAdapter.latencyMs !== null && serverHealth.cvAdapter.latencyMs !== undefined
                ? `${serverHealth.cvAdapter.latencyMs} ms`
                : 'Ready'}
              {' · Async Jobs'}
            </p>
          </div>

          <div className="p-3 rounded-md bg-[#0D1F35] border border-[#233B56]">
            <p className="text-[#A9B8CA]">Supported Formats</p>
            <p className="mt-1.5 font-mono text-[#F5F8FC]">
              MP4 · MOV · WebM ({serverHealth.maxUploadMb} MB)
            </p>
          </div>
        </div>

        <div className="p-3.5 rounded-md bg-[#0D1F35] border border-[#233B56] space-y-2 text-xs">
          <div className="flex items-start gap-2">
            <Activity className="w-4 h-4 text-[#45B5FF] shrink-0 mt-0.5" aria-hidden="true" />
            <p className="text-[#F5F8FC] leading-relaxed">
              {serverHealth.cvAdapter.message ||
                'Run a health check to verify live server-side Gemini API readiness.'}
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 pl-6 text-[11px] text-[#A9B8CA]">
            <span>
              Server-side only: <span className="font-mono">GEMINI_API_KEY</span> is read strictly from backend environment variables and never exposed to the browser.
            </span>
            {serverHealth.cvAdapter.checkedAt && (
              <span className="font-mono tabular-nums">
                Last checked: {new Date(serverHealth.cvAdapter.checkedAt).toLocaleTimeString()}
              </span>
            )}
          </div>
        </div>
      </section>

      {/* 1. Profile & Notification Preferences */}
      <section className="bg-[#122943] border border-[#233B56] rounded-lg p-5 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[#233B56] pb-3.5">
          <h2 className="text-base font-semibold text-[#F5F8FC] flex items-center gap-2">
            <User className="w-4 h-4 text-[#45B5FF]" aria-hidden="true" />
            Profile &amp; Notification Preferences
          </h2>
          <button
            type="button"
            onClick={() => void handlePasswordReset()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#0D1F35] hover:bg-[#071426] text-[#F5F8FC] border border-[#233B56] rounded-md transition-colors self-start sm:self-auto"
          >
            <KeyRound className="w-3.5 h-3.5 text-[#45B5FF]" aria-hidden="true" />
            Send Password Reset Email
          </button>
        </div>

        <form onSubmit={(e) => void handleSaveProfile(e)} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="profile-name" className="block text-xs font-medium text-[#A9B8CA] mb-1.5">
                Display Name
              </label>
              <input
                id="profile-name"
                type="text"
                required
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="w-full bg-[#071426] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC] focus:outline-none focus:ring-2 focus:ring-[#2585FF]"
              />
            </div>

            <div>
              <label htmlFor="profile-email" className="block text-xs font-medium text-[#A9B8CA] mb-1.5">
                Account Email (Read-Only)
              </label>
              <input
                id="profile-email"
                type="email"
                readOnly
                value={currentUser?.email ?? ''}
                className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#A9B8CA] cursor-not-allowed"
              />
            </div>

            <div>
              <label htmlFor="profile-avatar" className="block text-xs font-medium text-[#A9B8CA] mb-1.5">
                Avatar Image URL (Optional)
              </label>
              <input
                id="profile-avatar"
                type="url"
                value={photoURL}
                onChange={(e) => setPhotoURL(e.target.value)}
                placeholder="https://..."
                className="w-full bg-[#071426] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC] placeholder:text-[#A9B8CA]/60 focus:outline-none focus:ring-2 focus:ring-[#2585FF]"
              />
            </div>

            <div>
              <label htmlFor="profile-role" className="block text-xs font-medium text-[#A9B8CA] mb-1.5">
                Assigned Role
              </label>
              <input
                id="profile-role"
                type="text"
                readOnly
                value={currentUser?.role ?? 'VIEWER'}
                className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm font-mono text-[#45B5FF] cursor-not-allowed"
              />
            </div>
          </div>

          <div className="pt-2 space-y-2.5">
            <p className="text-xs font-medium text-[#A9B8CA] flex items-center gap-1.5">
              <Bell className="w-3.5 h-3.5 text-[#45B5FF]" aria-hidden="true" />
              Alert Delivery Preferences
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <label className="flex items-start gap-2.5 p-3 rounded-md bg-[#0D1F35] border border-[#233B56] cursor-pointer">
                <input
                  type="checkbox"
                  checked={notifyCritical}
                  onChange={(e) => setNotifyCritical(e.target.checked)}
                  className="mt-0.5 rounded border-[#233B56] accent-[#2585FF]"
                />
                <span className="text-xs text-[#F5F8FC]">
                  Critical Risk Events
                  <span className="block text-[#A9B8CA] mt-0.5">
                    Notify when a new Critical near-miss is flagged.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2.5 p-3 rounded-md bg-[#0D1F35] border border-[#233B56] cursor-pointer">
                <input
                  type="checkbox"
                  checked={notifyJob}
                  onChange={(e) => setNotifyJob(e.target.checked)}
                  className="mt-0.5 rounded border-[#233B56] accent-[#2585FF]"
                />
                <span className="text-xs text-[#F5F8FC]">
                  Video Job Completion
                  <span className="block text-[#A9B8CA] mt-0.5">
                    Notify when CV processing finishes or fails.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2.5 p-3 rounded-md bg-[#0D1F35] border border-[#233B56] cursor-pointer">
                <input
                  type="checkbox"
                  checked={notifyWeekly}
                  onChange={(e) => setNotifyWeekly(e.target.checked)}
                  className="mt-0.5 rounded border-[#233B56] accent-[#2585FF]"
                />
                <span className="text-xs text-[#F5F8FC]">
                  Weekly Safety Digest
                  <span className="block text-[#A9B8CA] mt-0.5">
                    Receive summary alerts on recurring fingerprints.
                  </span>
                </span>
              </label>
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={savingProfile}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-[#2585FF] hover:bg-[#1C74E8] text-white rounded-md disabled:opacity-60 transition-colors"
            >
              <Save className="w-4 h-4" aria-hidden="true" />
              {savingProfile ? 'Saving...' : 'Save Profile & Preferences'}
            </button>
          </div>
        </form>
      </section>

      {/* 2. Project Management CRUD (Part 7) */}
      <section className="bg-[#122943] border border-[#233B56] rounded-lg p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[#233B56] pb-3.5">
          <div>
            <h2 className="text-base font-semibold text-[#F5F8FC] flex items-center gap-2">
              <FolderKanban className="w-4 h-4 text-[#45B5FF]" aria-hidden="true" />
              Safety Study Projects ({projects.length})
            </h2>
            <p className="text-xs text-[#A9B8CA] mt-0.5">
              Organize municipal pilots, school-zone studies, and corridor audits. Deleting a project cascades strictly to its scoped locations, cameras, videos, events, and reports.
            </p>
          </div>

          {canManageProjects && (
            <button
              type="button"
              onClick={openNewProjectForm}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium bg-[#2585FF] hover:bg-[#1C74E8] text-white rounded-md transition-colors self-start sm:self-auto"
            >
              <Plus className="w-4 h-4" aria-hidden="true" />
              New Project
            </button>
          )}
        </div>

        {projectFormOpen && canManageProjects && (
          <form
            onSubmit={(e) => void handleProjectSubmit(e)}
            className="p-4 rounded-md bg-[#0D1F35] border border-[#2585FF]/50 space-y-3"
          >
            <h3 className="text-sm font-semibold text-[#F5F8FC]">
              {editingProjectId ? 'Edit Safety Study Project' : 'Create New Safety Study Project'}
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="md:col-span-2">
                <label htmlFor="proj-name" className="block text-xs font-medium text-[#A9B8CA] mb-1">
                  Project Name
                </label>
                <input
                  id="proj-name"
                  type="text"
                  required
                  value={projName}
                  onChange={(e) => setProjName(e.target.value)}
                  placeholder="e.g., Vadodara Ring Road Junction Safety Audit"
                  className="w-full bg-[#071426] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC] focus:outline-none focus:ring-2 focus:ring-[#2585FF]"
                />
              </div>
              <div>
                <label htmlFor="proj-start" className="block text-xs font-medium text-[#A9B8CA] mb-1">
                  Start Date
                </label>
                <input
                  id="proj-start"
                  type="date"
                  required
                  value={projStartDate}
                  onChange={(e) => setProjStartDate(e.target.value)}
                  className="w-full bg-[#071426] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC] focus:outline-none focus:ring-2 focus:ring-[#2585FF]"
                />
              </div>
              <div className="md:col-span-2">
                <label htmlFor="proj-desc" className="block text-xs font-medium text-[#A9B8CA] mb-1">
                  Study Description &amp; Objectives
                </label>
                <input
                  id="proj-desc"
                  type="text"
                  required
                  value={projDesc}
                  onChange={(e) => setProjDesc(e.target.value)}
                  placeholder="Scope, target corridors, and municipal stakeholders..."
                  className="w-full bg-[#071426] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC] focus:outline-none focus:ring-2 focus:ring-[#2585FF]"
                />
              </div>
              <div>
                <label htmlFor="proj-end" className="block text-xs font-medium text-[#A9B8CA] mb-1">
                  End Date (Optional)
                </label>
                <input
                  id="proj-end"
                  type="date"
                  value={projEndDate}
                  onChange={(e) => setProjEndDate(e.target.value)}
                  className="w-full bg-[#071426] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC] focus:outline-none focus:ring-2 focus:ring-[#2585FF]"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setProjectFormOpen(false)}
                className="px-3.5 py-1.5 text-xs font-medium text-[#A9B8CA] hover:text-[#F5F8FC] bg-[#071426] border border-[#233B56] rounded-md"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={projSubmitting}
                className="px-4 py-1.5 text-xs font-medium bg-[#2585FF] hover:bg-[#1C74E8] text-white rounded-md disabled:opacity-60"
              >
                {projSubmitting ? 'Saving...' : editingProjectId ? 'Save Project Changes' : 'Create Project'}
              </button>
            </div>
          </form>
        )}

        <div className="space-y-2.5">
          {projects.map((p) => (
            <div
              key={p.id}
              className="p-4 rounded-md bg-[#0D1F35] border border-[#233B56] flex flex-col md:flex-row md:items-center justify-between gap-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-sm font-semibold text-[#F5F8FC]">{p.name}</h3>
                  <span
                    className={`text-[11px] font-mono px-1.5 py-0.5 rounded border ${
                      p.status === 'active'
                        ? 'border-[#22C55E]/40 bg-[#22C55E]/10 text-[#22C55E]'
                        : 'border-[#A9B8CA]/40 bg-[#071426] text-[#A9B8CA]'
                    }`}
                  >
                    {p.status.toUpperCase()}
                  </span>
                </div>
                <p className="text-xs text-[#A9B8CA] mt-1">{p.description}</p>
                <p className="text-[11px] font-mono text-[#A9B8CA]/80 mt-1">
                  Period: {p.startDate} {p.endDate ? `to ${p.endDate}` : '— Ongoing'}
                </p>
              </div>

              {canManageProjects && (
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => openEditProjectForm(p)}
                    aria-label={`Edit project ${p.name}`}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-[#122943] hover:bg-[#193656] text-[#F5F8FC] border border-[#233B56] rounded-md"
                  >
                    <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void updateProject(p.id, {
                        status: p.status === 'active' ? 'archived' : 'active',
                      })
                    }
                    aria-label={
                      p.status === 'active'
                        ? `Archive project ${p.name}`
                        : `Restore project ${p.name}`
                    }
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-[#122943] hover:bg-[#193656] text-[#A9B8CA] hover:text-[#F5F8FC] border border-[#233B56] rounded-md"
                  >
                    {p.status === 'active' ? (
                      <>
                        <Archive className="w-3.5 h-3.5" aria-hidden="true" />
                        Archive
                      </>
                    ) : (
                      <>
                        <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                        Restore
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleteTarget(p)}
                    aria-label={`Delete project ${p.name}`}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-[#E5484D]/15 hover:bg-[#E5484D]/25 text-[#E5484D] border border-[#E5484D]/35 rounded-md"
                  >
                    <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                    Delete
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* 3. Provisional Risk Scoring Band Configuration */}
      <section className="bg-[#122943] border border-[#233B56] rounded-lg p-5 space-y-4">
        <div className="border-b border-[#233B56] pb-3.5">
          <h2 className="text-base font-semibold text-[#F5F8FC] flex items-center gap-2">
            <Sliders className="w-4 h-4 text-[#45B5FF]" aria-hidden="true" />
            Provisional Risk Band Thresholds &amp; Upload Limits
          </h2>
          <p className="text-xs text-[#A9B8CA] mt-0.5">
            Adjust upper bounds for Low, Medium, and High risk triage bands (0–100 provisional index; Critical covers scores above High Max).
          </p>
        </div>

        <form onSubmit={(e) => void handleSaveRiskSettings(e)} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <label htmlFor="band-low" className="block text-xs font-medium text-[#22C55E] mb-1">
                Low Risk Max (0 – N)
              </label>
              <input
                id="band-low"
                type="number"
                min={5}
                max={60}
                disabled={!canManageSettings}
                value={lowMax}
                onChange={(e) => setLowMax(Number(e.target.value))}
                className="w-full bg-[#071426] border border-[#233B56] rounded-md px-3 py-2 text-sm font-mono text-[#F5F8FC] disabled:opacity-60"
              />
            </div>
            <div>
              <label htmlFor="band-medium" className="block text-xs font-medium text-[#EAB308] mb-1">
                Medium Risk Max ({lowMax + 1} – N)
              </label>
              <input
                id="band-medium"
                type="number"
                min={lowMax + 1}
                max={80}
                disabled={!canManageSettings}
                value={mediumMax}
                onChange={(e) => setMediumMax(Number(e.target.value))}
                className="w-full bg-[#071426] border border-[#233B56] rounded-md px-3 py-2 text-sm font-mono text-[#F5F8FC] disabled:opacity-60"
              />
            </div>
            <div>
              <label htmlFor="band-high" className="block text-xs font-medium text-[#F97316] mb-1">
                High Risk Max ({mediumMax + 1} – N)
              </label>
              <input
                id="band-high"
                type="number"
                min={mediumMax + 1}
                max={95}
                disabled={!canManageSettings}
                value={highMax}
                onChange={(e) => setHighMax(Number(e.target.value))}
                className="w-full bg-[#071426] border border-[#233B56] rounded-md px-3 py-2 text-sm font-mono text-[#F5F8FC] disabled:opacity-60"
              />
            </div>
            <div>
              <label htmlFor="max-upload-mb" className="block text-xs font-medium text-[#A9B8CA] mb-1">
                Max Video Upload Size (MB)
              </label>
              <input
                id="max-upload-mb"
                type="number"
                min={10}
                max={2000}
                disabled={!canManageSettings}
                value={maxUploadMb}
                onChange={(e) => setMaxUploadMb(Number(e.target.value))}
                className="w-full bg-[#071426] border border-[#233B56] rounded-md px-3 py-2 text-sm font-mono text-[#F5F8FC] disabled:opacity-60"
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-4">
            <p className="text-xs text-[#A9B8CA]">
              Critical band automatically covers <span className="font-mono text-[#E5484D]">{highMax + 1} – 100</span>.
            </p>
            {canManageSettings && (
              <button
                type="submit"
                disabled={savingRisk}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-[#2585FF] hover:bg-[#1C74E8] text-white rounded-md disabled:opacity-60 transition-colors"
              >
                <Save className="w-4 h-4" aria-hidden="true" />
                {savingRisk ? 'Saving...' : 'Save Configuration'}
              </button>
            )}
          </div>
        </form>
      </section>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={`Delete Project "${deleteTarget?.name ?? ''}"?`}
        description="Cascade Deletion Policy: Confirming will permanently remove this project along with all locations, cameras, uploaded videos, conflict events, recommendations, and reports strictly scoped to this project ID. Records in other projects are unaffected."
        confirmLabel="Delete Project & Scoped Data"
        destructive
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) {
            void deleteProject(deleteTarget.id);
          }
          setDeleteTarget(null);
        }}
      />
    </div>
  );
}
