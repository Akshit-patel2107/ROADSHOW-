import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AlertTriangle, Shield } from 'lucide-react';
import { ErrorBoundary } from './components/ErrorBoundary';
import { RoadshadowProvider, useRoadshadow } from './context/RoadshadowContext';
import { AppShell } from './components/AppShell';
import { AuthScreen } from './components/AuthScreen';
import { ToastContainer } from './components/ToastContainer';
import { sendEmailVerification } from './lib/firebase';
import { DashboardPage } from './pages/DashboardPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { ProjectDetailPage } from './pages/ProjectDetailPage';
import { UploadVideoPage } from './pages/UploadVideoPage';
import { VideoAnalysisPage } from './pages/VideoAnalysisPage';
import { LiveAnalysisPage } from './pages/LiveAnalysisPage';
import { ConflictEventsPage } from './pages/ConflictEventsPage';
import { ConflictFingerprintsPage } from './pages/ConflictFingerprintsPage';
import { JunctionImprovementLabPage } from './pages/JunctionImprovementLabPage';
import { RiskMapPage } from './pages/RiskMapPage';
import { LocationsPage } from './pages/LocationsPage';
import { CamerasPage } from './pages/CamerasPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { RecommendationsPage } from './pages/RecommendationsPage';
import { ReportsPage } from './pages/ReportsPage';
import { DemoModePage } from './pages/DemoModePage';
import { NotificationsPage } from './pages/NotificationsPage';
import { UserManagementPage } from './pages/UserManagementPage';
import { SettingsPage } from './pages/SettingsPage';
import { HelpDocsPage } from './pages/HelpDocsPage';

function RoadshadowAppContent() {
  const {
    authLoading,
    currentUser,
    firebaseUser,
    isDemoMode,
    enterDemoMode,
    pushToast,
  } = useRoadshadow();

  if (authLoading) {
    return (
      <div className="min-h-screen bg-[#071426] text-[#F5F8FC] flex flex-col items-center justify-center p-6">
        <div className="w-10 h-10 rounded-md bg-[#2585FF] flex items-center justify-center mb-4">
          <Shield className="w-5 h-5 text-white" aria-hidden="true" />
        </div>
        <p className="text-sm font-medium text-[#F5F8FC]">Initializing ROADSHADOW Workspace</p>
        <p className="text-xs text-[#A9B8CA] mt-1">Verifying session and database configuration...</p>
      </div>
    );
  }

  if (!currentUser && !isDemoMode) {
    return (
      <>
        <AuthScreen />
        <ToastContainer />
      </>
    );
  }

  const needsEmailVerification =
    !isDemoMode && Boolean(firebaseUser) && !firebaseUser?.emailVerified;

  const handleResendVerification = async () => {
    if (!firebaseUser) return;
    try {
      await sendEmailVerification(firebaseUser);
      pushToast({
        type: 'success',
        title: 'Verification Email Resent',
        description: `Check ${firebaseUser.email || 'your inbox'} and reload once verified.`,
      });
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Unable to Resend Verification',
        description: err instanceof Error ? err.message : 'Please try again shortly.',
      });
    }
  };

  return (
    <>
      <AppShell>
        {needsEmailVerification && (
          <div
            role="alert"
            className="mb-6 p-4 rounded-lg bg-[#122943] border border-[#EAB308]/50 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
          >
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-[#EAB308] shrink-0 mt-0.5" aria-hidden="true" />
              <div className="text-sm">
                <p className="font-semibold text-[#F5F8FC]">Email Verification Required for Cloud Firestore Access</p>
                <p className="text-xs text-[#A9B8CA] mt-0.5">
                  Please verify your email address and reload this page to read or write production safety records, or switch to Demonstration Mode to evaluate immediately.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => void handleResendVerification()}
                className="px-3 py-1.5 text-xs font-medium bg-[#0D1F35] hover:bg-[#071426] text-[#F5F8FC] border border-[#233B56] rounded-md"
              >
                Resend Link
              </button>
              <button
                type="button"
                onClick={() => enterDemoMode('ADMINISTRATOR')}
                className="px-3 py-1.5 text-xs font-medium bg-[#2585FF] hover:bg-[#1C74E8] text-white rounded-md"
              >
                Open Demo Mode
              </button>
            </div>
          </div>
        )}

        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:projectId" element={<ProjectDetailPage />} />
          <Route path="/upload" element={<UploadVideoPage />} />
          <Route path="/video-analysis" element={<VideoAnalysisPage />} />
          <Route path="/video-analysis/:videoId" element={<VideoAnalysisPage />} />
          <Route path="/live-analysis" element={<LiveAnalysisPage />} />
          <Route path="/events" element={<ConflictEventsPage />} />
          <Route path="/fingerprints" element={<ConflictFingerprintsPage />} />
          <Route path="/improvement-lab" element={<JunctionImprovementLabPage />} />
          <Route path="/risk-map" element={<RiskMapPage />} />
          <Route path="/locations" element={<LocationsPage />} />
          <Route path="/cameras" element={<CamerasPage />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
          <Route path="/recommendations" element={<RecommendationsPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/demo" element={<DemoModePage />} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/users" element={<UserManagementPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/help" element={<HelpDocsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppShell>
      <ToastContainer />
    </>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <RoadshadowProvider>
        <BrowserRouter>
          <RoadshadowAppContent />
        </BrowserRouter>
      </RoadshadowProvider>
    </ErrorBoundary>
  );
}
