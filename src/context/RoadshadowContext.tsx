import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  Timestamp,
} from 'firebase/firestore';
import {
  auth,
  createUserWithEmailAndPassword,
  db,
  googleProvider,
  handleFirestoreError,
  OperationType,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
} from '../lib/firebase';
import type {
  ActiveCameraSource,
  AppNotification,
  AuditLogEntry,
  Camera,
  ConflictEvent,
  ConflictFingerprint,
  ConflictType,
  ProcessingJob,
  Project,
  RiskBandConfig,
  RoadLocation,
  SafetyRecommendation,
  SafetyReport,
  UserProfile,
  UserRole,
  ValidationStatus,
  VideoRecord,
  WorkspaceSettings,
} from '../types/roadshadow';
import { DEFAULT_RISK_BANDS } from '../engine/riskScoring';
import { buildConflictFingerprints } from '../engine/conflictFingerprint';
import { sanitizeFirestoreId } from '../engine/validation';
import {
  DEMO_AUDIT_LOGS,
  DEMO_CAMERAS,
  DEMO_EVENTS,
  DEMO_JOBS,
  DEMO_LOCATIONS,
  DEMO_NOTIFICATIONS,
  DEMO_PROJECTS,
  DEMO_RECOMMENDATIONS,
  DEMO_REPORTS,
  DEMO_USERS,
  DEMO_VIDEOS,
} from '../data/demoDataset';

import { roadshadowFetch } from '../lib/apiClient';

export interface ToastMessage {
  id: string;
  type: 'success' | 'error' | 'info' | 'warning';
  title: string;
  description?: string;
}

export interface ServerHealthStatus {
  maxUploadMb: number;
  cvAdapter: {
    status: 'available' | 'unavailable' | 'not_configured';
    mode: 'CV_SERVICE' | 'UNAVAILABLE' | 'DEVELOPMENT_FALLBACK';
    externalWorkerConfigured: boolean;
    workerReachable: boolean;
    rtspIngestionReady: boolean;
    modelVersion?: string | null;
    latencyMs?: number | null;
    message?: string;
    checkedAt?: string;
  };
  sumoConfigured: boolean;
  geminiConfigured: boolean;
}

const STORAGE_KEYS = {
  demoMode: 'roadshadow_demo_mode',
  selectedProject: 'roadshadow_selected_project_id',
  demoState: 'roadshadow_demo_state_v2',
  cameraSources: 'roadshadow_camera_sources_v2',
};

interface RoadshadowContextValue {
  // Auth & Workspace Mode
  authLoading: boolean;
  firebaseUser: FirebaseUser | null;
  currentUser: UserProfile | null;
  isDemoMode: boolean;
  enterDemoMode: (role?: UserRole) => void;
  exitDemoMode: () => void;
  switchDemoRole: (role: UserRole) => void;
  resetDemoDataset: () => void;
  loginWithGoogle: () => Promise<void>;
  loginWithEmail: (email: string, password: string) => Promise<void>;
  registerWithEmail: (displayName: string, email: string, password: string) => Promise<void>;
  requestPasswordReset: (email: string) => Promise<void>;
  logout: () => Promise<void>;
  updateCurrentUserProfile: (updates: {
    displayName?: string;
    photoURL?: string;
    notifyCriticalEvents?: boolean;
    notifyJobCompletion?: boolean;
    notifyWeeklySummary?: boolean;
  }) => Promise<void>;

  // Global navigation / filtering state
  selectedProjectId: string;
  setSelectedProjectId: (id: string) => void;
  selectedSourceByProject: Record<string, ActiveCameraSource>;
  selectSourceForProject: (projectId: string, source: ActiveCameraSource) => Promise<void>;
  clearSourceForProject: (projectId: string) => void;
  globalSearch: string;
  setGlobalSearch: (q: string) => void;
  serverHealth: ServerHealthStatus;
  refreshServerHealth: (force?: boolean) => Promise<ServerHealthStatus>;

  // Data collections (project-scoped & full)
  projects: Project[];
  locations: RoadLocation[];
  cameras: Camera[];
  videos: VideoRecord[];
  processingJobs: ProcessingJob[];
  conflictEvents: ConflictEvent[];
  conflictFingerprints: ConflictFingerprint[];
  recommendations: SafetyRecommendation[];
  reports: SafetyReport[];
  notifications: AppNotification[];
  users: UserProfile[];
  auditLogs: AuditLogEntry[];
  settings: WorkspaceSettings;

  // Mutations
  createProject: (input: Omit<Project, 'id' | 'ownerId' | 'createdAt' | 'updatedAt'>) => Promise<Project>;
  updateProject: (
    id: string,
    updates: Partial<Pick<Project, 'name' | 'locationSummary' | 'selectedCameraId' | 'description' | 'startDate' | 'endDate' | 'status'>>
  ) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;

  createLocation: (input: Omit<RoadLocation, 'id' | 'ownerId' | 'createdAt' | 'updatedAt'>) => Promise<RoadLocation>;
  updateLocation: (id: string, updates: Partial<RoadLocation>) => Promise<void>;
  deleteLocation: (id: string) => Promise<void>;

  createCamera: (input: Omit<Camera, 'id' | 'ownerId' | 'createdAt' | 'updatedAt'>) => Promise<Camera>;
  updateCamera: (id: string, updates: Partial<Camera>) => Promise<void>;
  deleteCamera: (id: string) => Promise<void>;

  registerUploadedVideoAndResults: (payload: {
    video: VideoRecord;
    job: ProcessingJob;
    events: ConflictEvent[];
    mode?: 'create' | 'update';
  }) => Promise<void>;
  deleteVideo: (videoId: string) => Promise<void>;
  retryVideoAnalysis: (
    videoId: string
  ) => Promise<{ ok: boolean; status: string; error?: string }>;

  reviewConflictEvent: (
    eventId: string,
    updates: {
      validationStatus: ValidationStatus;
      conflictType: ConflictType;
      analystNotes?: string;
    }
  ) => Promise<void>;
  saveEventAiExplanation: (eventId: string, explanationText: string) => void;

  updateFingerprintStatus: (
    fingerprintId: string,
    status: ConflictFingerprint['investigationStatus']
  ) => Promise<void>;

  createRecommendation: (
    input: Omit<SafetyRecommendation, 'id' | 'ownerId' | 'createdAt' | 'updatedAt'>
  ) => Promise<SafetyRecommendation>;
  updateRecommendationStatus: (
    id: string,
    status: SafetyRecommendation['status']
  ) => Promise<void>;

  createReport: (
    input: Omit<SafetyReport, 'id' | 'ownerId' | 'createdAt' | 'updatedAt'>
  ) => Promise<SafetyReport>;

  markNotificationRead: (id: string) => Promise<void>;
  markAllNotificationsRead: () => Promise<void>;
  updateUserRole: (uid: string, role: UserRole) => Promise<void>;
  updateWorkspaceSettings: (next: { riskBands: RiskBandConfig; maxUploadMb: number }) => Promise<void>;

  // Toasts
  toasts: ToastMessage[];
  pushToast: (toast: Omit<ToastMessage, 'id'>) => void;
  dismissToast: (id: string) => void;
}

const RoadshadowContext = createContext<RoadshadowContextValue | null>(null);

function tsToIso(val: unknown): string {
  if (!val) return new Date().toISOString();
  if (val instanceof Timestamp) return val.toDate().toISOString();
  if (typeof val === 'string') return val;
  if (typeof val === 'object' && val !== null && 'seconds' in val) {
    return new Date(Number((val as { seconds: number }).seconds) * 1000).toISOString();
  }
  return new Date().toISOString();
}

const BOOTSTRAPPED_ADMIN_EMAIL = 'akshitpatel2107@gmail.com';

export function RoadshadowProvider({ children }: { children: React.ReactNode }) {
  const [authLoading, setAuthLoading] = useState(true);
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [isDemoMode, setIsDemoMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    const params = new URLSearchParams(window.location.search);
    if (params.get('autostart') === '1' || params.get('demo') === '1') {
      localStorage.setItem('roadshadow_demo_mode', 'true');
      return true;
    }
    return localStorage.getItem('roadshadow_demo_mode') === 'true';
  });

  const [selectedProjectId, setSelectedProjectIdState] = useState<string>(() => {
    if (typeof window === 'undefined') return 'ALL';
    return localStorage.getItem(STORAGE_KEYS.selectedProject) || 'ALL';
  });

  const setSelectedProjectId = useCallback((id: string) => {
    setSelectedProjectIdState(id);
    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEYS.selectedProject, id);
    }
  }, []);

  const [selectedSourceByProject, setSelectedSourceByProject] = useState<
    Record<string, ActiveCameraSource>
  >(() => {
    if (typeof window === 'undefined') return {};
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.cameraSources);
      return raw ? (JSON.parse(raw) as Record<string, ActiveCameraSource>) : {};
    } catch {
      return {};
    }
  });

  const [globalSearch, setGlobalSearch] = useState('');
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [serverHealth, setServerHealth] = useState<ServerHealthStatus>({
    maxUploadMb: 250,
    cvAdapter: {
      status: 'not_configured',
      mode: 'UNAVAILABLE',
      externalWorkerConfigured: false,
      workerReachable: false,
      rtspIngestionReady: false,
      modelVersion: null,
      latencyMs: null,
      message: 'Checking computer vision service status...',
    },
    sumoConfigured: false,
    geminiConfigured: false,
  });

  // Domain states
  const [projects, setProjects] = useState<Project[]>([]);
  const [locations, setLocations] = useState<RoadLocation[]>([]);
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [videos, setVideos] = useState<VideoRecord[]>([]);
  const [processingJobs, setProcessingJobs] = useState<ProcessingJob[]>([]);
  const [conflictEvents, setConflictEvents] = useState<ConflictEvent[]>([]);
  const [fingerprintStatuses, setFingerprintStatuses] = useState<
    Record<string, ConflictFingerprint['investigationStatus']>
  >(() => {
    if (typeof window === 'undefined') return {};
    try {
      const raw = localStorage.getItem('roadshadow_fp_statuses_v2');
      return raw ? (JSON.parse(raw) as Record<string, ConflictFingerprint['investigationStatus']>) : {};
    } catch {
      return {};
    }
  });
  const [recommendations, setRecommendations] = useState<SafetyRecommendation[]>([]);
  const [reports, setReports] = useState<SafetyReport[]>([]);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [settings, setSettings] = useState<WorkspaceSettings>({
    riskBands: DEFAULT_RISK_BANDS,
    maxUploadMb: 250,
  });
  const [demoHydrated, setDemoHydrated] = useState(false);

  const pushToast = useCallback((toast: Omit<ToastMessage, 'id'>) => {
    const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    setToasts((prev) => [...prev.slice(-3), { ...toast, id }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((item) => item.id !== id));
    }, 4500);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const refreshServerHealth = useCallback(async (force = false): Promise<ServerHealthStatus> => {
    try {
      const res = await fetch(force ? '/api/health?refresh=1' : '/api/health');
      if (res.ok) {
        const data = await res.json();
        if (data?.cvAdapter) {
          const next: ServerHealthStatus = {
            maxUploadMb: data.maxUploadMb ?? 250,
            cvAdapter: {
              status: data.cvAdapter.status || (data.cvAdapter.externalWorkerConfigured ? 'available' : 'not_configured'),
              mode: data.cvAdapter.mode || 'UNAVAILABLE',
              externalWorkerConfigured: Boolean(data.cvAdapter.externalWorkerConfigured),
              workerReachable: Boolean(data.cvAdapter.workerReachable),
              rtspIngestionReady: Boolean(data.cvAdapter.rtspIngestionReady),
              modelVersion: data.cvAdapter.modelVersion ?? null,
              latencyMs: data.cvAdapter.latencyMs ?? null,
              message: data.cvAdapter.message,
              checkedAt: data.cvAdapter.checkedAt,
            },
            sumoConfigured: Boolean(data.sumoAdapter?.configured),
            geminiConfigured: Boolean(data.geminiConfigured),
          };
          setServerHealth(next);
          setSettings((prev) => ({ ...prev, maxUploadMb: next.maxUploadMb }));
          return next;
        }
      }
    } catch {
      // Keep current state if offline
    }
    return serverHealth;
  }, [serverHealth]);

  // Poll backend health once on boot
  useEffect(() => {
    void refreshServerHealth(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadDemoDataset = useCallback((role: UserRole = 'ADMINISTRATOR', forceReset = false) => {
    const baseUser = DEMO_USERS.find((u) => u.role === role) ?? DEMO_USERS[0];
    setCurrentUser(baseUser);
    setUsers(DEMO_USERS);

    if (!forceReset && typeof window !== 'undefined') {
      try {
        const cachedRaw = localStorage.getItem(STORAGE_KEYS.demoState);
        if (cachedRaw) {
          const cached = JSON.parse(cachedRaw) as {
            projects?: Project[];
            locations?: RoadLocation[];
            cameras?: Camera[];
            videos?: VideoRecord[];
            processingJobs?: ProcessingJob[];
            conflictEvents?: ConflictEvent[];
            recommendations?: SafetyRecommendation[];
            reports?: SafetyReport[];
            notifications?: AppNotification[];
            auditLogs?: AuditLogEntry[];
          };
          setProjects(cached.projects?.length ? cached.projects : DEMO_PROJECTS);
          setLocations(cached.locations?.length ? cached.locations : DEMO_LOCATIONS);
          setCameras(cached.cameras?.length ? cached.cameras : DEMO_CAMERAS);
          setVideos(cached.videos?.length ? cached.videos : DEMO_VIDEOS);
          setProcessingJobs(cached.processingJobs?.length ? cached.processingJobs : DEMO_JOBS);
          setConflictEvents(cached.conflictEvents?.length ? cached.conflictEvents : DEMO_EVENTS);
          setRecommendations(
            cached.recommendations?.length ? cached.recommendations : DEMO_RECOMMENDATIONS
          );
          setReports(cached.reports?.length ? cached.reports : DEMO_REPORTS);
          setNotifications(cached.notifications?.length ? cached.notifications : DEMO_NOTIFICATIONS);
          setAuditLogs(cached.auditLogs?.length ? cached.auditLogs : DEMO_AUDIT_LOGS);
          setDemoHydrated(true);
          return;
        }
      } catch {
        // Fall through to clean defaults
      }
    }

    setProjects(DEMO_PROJECTS);
    setLocations(DEMO_LOCATIONS);
    setCameras(DEMO_CAMERAS);
    setVideos(DEMO_VIDEOS);
    setProcessingJobs(DEMO_JOBS);
    setConflictEvents(DEMO_EVENTS);
    setRecommendations(DEMO_RECOMMENDATIONS);
    setReports(DEMO_REPORTS);
    setNotifications(DEMO_NOTIFICATIONS);
    setAuditLogs(DEMO_AUDIT_LOGS);
    if (forceReset) {
      setSelectedProjectId('ALL');
      if (typeof window !== 'undefined') {
        localStorage.removeItem(STORAGE_KEYS.demoState);
        localStorage.removeItem(STORAGE_KEYS.cameraSources);
      }
      setSelectedSourceByProject({});
    }
    setDemoHydrated(true);
  }, [setSelectedProjectId]);

  // Persist Demo Mode workspace changes across page reloads so created projects & uploaded videos remain selectable!
  useEffect(() => {
    if (!isDemoMode || !demoHydrated || typeof window === 'undefined') return;
    try {
      // Strip heavy detection arrays from localStorage cache for demo videos if quota is tight,
      // while preserving all uploaded video metadata & compact trajectories
      const compactVideos = videos.map((v) =>
        v.isDemonstration ? { ...v, detections: undefined, trajectories: undefined } : v
      );
      localStorage.setItem(
        STORAGE_KEYS.demoState,
        JSON.stringify({
          projects,
          locations,
          cameras,
          videos: compactVideos.map((v) => {
            if (v.isDemonstration) {
              const orig = DEMO_VIDEOS.find((dv) => dv.id === v.id);
              return orig ? { ...v, detections: undefined, trajectories: undefined } : v;
            }
            return v;
          }),
          processingJobs,
          conflictEvents,
          recommendations,
          reports,
          notifications,
          auditLogs: auditLogs.slice(0, 60),
        })
      );
    } catch {
      // Ignore storage quota overflow gracefully
    }
  }, [
    isDemoMode,
    demoHydrated,
    projects,
    locations,
    cameras,
    videos,
    processingJobs,
    conflictEvents,
    recommendations,
    reports,
    notifications,
    auditLogs,
  ]);

  // Re-attach precomputed detections for demonstration clips restored from compact cache
  const hydratedVideos = useMemo(() => {
    return videos.map((v) => {
      if (v.isDemonstration && (!v.detections || v.detections.length === 0)) {
        const orig = DEMO_VIDEOS.find((dv) => dv.id === v.id);
        if (orig) {
          return { ...v, detections: orig.detections, trajectories: orig.trajectories };
        }
      }
      return v;
    });
  }, [videos]);

  // Keep selectedProjectId valid if the selected project was deleted
  useEffect(() => {
    if (selectedProjectId !== 'ALL' && projects.length > 0) {
      const exists = projects.some((p) => p.id === selectedProjectId);
      if (!exists) {
        setSelectedProjectId('ALL');
      }
    }
  }, [projects, selectedProjectId, setSelectedProjectId]);

  const enterDemoMode = useCallback(
    (role: UserRole = 'ADMINISTRATOR') => {
      localStorage.setItem(STORAGE_KEYS.demoMode, 'true');
      setIsDemoMode(true);
      loadDemoDataset(role, false);
      pushToast({
        type: 'info',
        title: 'Demonstration Mode Active',
        description: 'Loaded Anand Road Safety Pilot sample dataset. All demo data is clearly labelled.',
      });
    },
    [loadDemoDataset, pushToast]
  );

  const exitDemoMode = useCallback(() => {
    localStorage.removeItem(STORAGE_KEYS.demoMode);
    setIsDemoMode(false);
    setDemoHydrated(false);
    if (!firebaseUser) {
      setCurrentUser(null);
      setProjects([]);
      setLocations([]);
      setCameras([]);
      setVideos([]);
      setProcessingJobs([]);
      setConflictEvents([]);
      setRecommendations([]);
      setReports([]);
      setNotifications([]);
      setUsers([]);
      setAuditLogs([]);
    }
  }, [firebaseUser]);

  const switchDemoRole = useCallback(
    (role: UserRole) => {
      if (!isDemoMode) return;
      const found = DEMO_USERS.find((u) => u.role === role);
      if (found) {
        setCurrentUser(found);
        pushToast({
          type: 'info',
          title: `Switched Demo Role to ${role}`,
          description: `Active permissions now mirror ${found.displayName} (${role}).`,
        });
      }
    },
    [isDemoMode, pushToast]
  );

  const resetDemoDataset = useCallback(() => {
    if (!isDemoMode) return;
    loadDemoDataset(currentUser?.role ?? 'ADMINISTRATOR', true);
    pushToast({
      type: 'success',
      title: 'Demonstration Dataset Reset',
      description: 'Restored original pilot records.',
    });
  }, [isDemoMode, currentUser?.role, loadDemoDataset, pushToast]);

  // Listen to Firebase Auth state
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (fbUser) => {
      setFirebaseUser(fbUser);
      if (fbUser && !isDemoMode) {
        try {
          const isBootAdmin =
            fbUser.email?.toLowerCase() === BOOTSTRAPPED_ADMIN_EMAIL &&
            fbUser.emailVerified;
          const userRef = doc(db, 'users', fbUser.uid);
          const privRef = doc(db, 'users', fbUser.uid, 'private', 'profile');

          let role: UserRole = isBootAdmin ? 'ADMINISTRATOR' : 'ANALYST';
          let displayName = fbUser.displayName || fbUser.email?.split('@')[0] || 'Road Safety Analyst';
          let photoURL = fbUser.photoURL || undefined;
          let notifyCriticalEvents = true;
          let notifyJobCompletion = true;
          let notifyWeeklySummary = false;

          if (fbUser.emailVerified) {
            const snap = await getDoc(userRef);
            if (!snap.exists()) {
              await setDoc(userRef, {
                uid: fbUser.uid,
                displayName: displayName.slice(0, 120),
                photoURL: photoURL ?? '',
                role,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
              });
            } else {
              const d = snap.data();
              role = (d.role as UserRole) || role;
              displayName = (d.displayName as string) || displayName;
              photoURL = (d.photoURL as string) || photoURL;
            }

            const privSnap = await getDoc(privRef);
            if (!privSnap.exists()) {
              await setDoc(privRef, {
                uid: fbUser.uid,
                email: fbUser.email || 'unknown@roadshadow.app',
                notifyCriticalEvents: true,
                notifyJobCompletion: true,
                notifyWeeklySummary: false,
                updatedAt: serverTimestamp(),
              });
            } else {
              const pd = privSnap.data();
              notifyCriticalEvents = Boolean(pd.notifyCriticalEvents);
              notifyJobCompletion = Boolean(pd.notifyJobCompletion);
              notifyWeeklySummary = Boolean(pd.notifyWeeklySummary);
            }
          }

          const nowIso = new Date().toISOString();
          setCurrentUser({
            uid: fbUser.uid,
            displayName,
            email: fbUser.email || '',
            photoURL,
            role,
            notifyCriticalEvents,
            notifyJobCompletion,
            notifyWeeklySummary,
            createdAt: nowIso,
            updatedAt: nowIso,
          });
        } catch (err) {
          console.error('Failed to initialize Firebase user profile:', err);
        }
      } else if (!fbUser && isDemoMode) {
        loadDemoDataset('ADMINISTRATOR');
      } else if (!fbUser && !isDemoMode) {
        setCurrentUser(null);
      }
      setAuthLoading(false);
    });
    return () => unsub();
  }, [isDemoMode, loadDemoDataset]);

  // Attach Live Firestore Listeners ONLY when authenticated & verified (and not in Demo Mode)
  useEffect(() => {
    if (isDemoMode || !firebaseUser || !firebaseUser.emailVerified) {
      return;
    }

    const uid = firebaseUser.uid;
    const unsubs: Array<() => void> = [];

    const bindOwnerCollection = <T extends { id: string }>(
      colName: string,
      setter: React.Dispatch<React.SetStateAction<T[]>>,
      ownerField = 'ownerId'
    ) => {
      const q = query(collection(db, colName), where(ownerField, '==', uid));
      const unsub = onSnapshot(
        q,
        (snapshot) => {
          const rows = snapshot.docs.map((d) => {
            const raw = d.data();
            return {
              ...raw,
              id: d.id,
              createdAt: tsToIso(raw.createdAt),
              updatedAt: tsToIso(raw.updatedAt),
            } as unknown as T;
          });
          setter(rows);
        },
        (error) => {
          handleFirestoreError(error, OperationType.LIST, colName);
        }
      );
      unsubs.push(unsub);
    };

    bindOwnerCollection<Project>('projects', setProjects);
    bindOwnerCollection<RoadLocation>('locations', setLocations);
    bindOwnerCollection<Camera>('cameras', setCameras);
    bindOwnerCollection<VideoRecord>('videos', setVideos);
    bindOwnerCollection<ProcessingJob>('processingJobs', setProcessingJobs);
    // Normalize optional event fields on Firestore load
    unsubs.push(
      onSnapshot(
        query(collection(db, 'conflictEvents'), where('ownerId', '==', uid)),
        (snapshot) => {
          setConflictEvents(
            snapshot.docs.map((d) => {
              const raw = d.data();
              const createdAt = tsToIso(raw.createdAt);
              return {
                ...raw,
                id: d.id,
                occurredAt: typeof raw.occurredAt === 'string' && raw.occurredAt ? raw.occurredAt : createdAt,
                movementDirection: typeof raw.movementDirection === 'string' ? raw.movementDirection : 'Intersecting movement',
                involvedTrackIds: Array.isArray(raw.involvedTrackIds) ? raw.involvedTrackIds : [],
                createdAt,
                updatedAt: tsToIso(raw.updatedAt),
              } as unknown as ConflictEvent;
            })
          );
        },
        (error) => handleFirestoreError(error, OperationType.LIST, 'conflictEvents')
      )
    );
    bindOwnerCollection<SafetyRecommendation>('recommendations', setRecommendations);
    // Normalize reports with safe metricsSnapshot fallback so legacy docs never crash ReportsPage
    unsubs.push(
      onSnapshot(
        query(collection(db, 'reports'), where('ownerId', '==', uid)),
        (snapshot) => {
          setReports(
            snapshot.docs.map((d) => {
              const raw = d.data();
              const snap = (raw.metricsSnapshot || {}) as Partial<SafetyReport['metricsSnapshot']>;
              return {
                ...raw,
                id: d.id,
                includedLocationIds: Array.isArray(raw.includedLocationIds) ? raw.includedLocationIds : [],
                metricsSnapshot: {
                  videosAnalyzed: Number(snap.videosAnalyzed ?? 0),
                  totalEvents: Number(snap.totalEvents ?? 0),
                  criticalEvents: Number(snap.criticalEvents ?? 0),
                  highEvents: Number(snap.highEvents ?? 0),
                  verifiedEvents: Number(snap.verifiedEvents ?? 0),
                  fingerprintsIdentified: Number(snap.fingerprintsIdentified ?? 0),
                },
                createdAt: tsToIso(raw.createdAt),
                updatedAt: tsToIso(raw.updatedAt),
              } as unknown as SafetyReport;
            })
          );
        },
        (error) => handleFirestoreError(error, OperationType.LIST, 'reports')
      )
    );
    bindOwnerCollection<AppNotification>('notifications', setNotifications, 'userId');

    // Load saved workspace settings from Firestore
    const settingId = sanitizeFirestoreId(`cfg_${uid}`);
    unsubs.push(
      onSnapshot(
        doc(db, 'settings', settingId),
        (snap) => {
          if (!snap.exists()) return;
          const d = snap.data();
          if (typeof d.lowMax === 'number' && typeof d.mediumMax === 'number' && typeof d.highMax === 'number') {
            setSettings({
              riskBands: {
                lowMax: d.lowMax,
                mediumMax: d.mediumMax,
                highMax: d.highMax,
              },
              maxUploadMb: typeof d.maxUploadMb === 'number' ? d.maxUploadMb : 250,
            });
          }
        },
        () => {
          // Ignore if no custom settings saved yet
        }
      )
    );

    // Users list (owner or admin)
    const usersQuery =
      firebaseUser.email?.toLowerCase() === BOOTSTRAPPED_ADMIN_EMAIL
        ? query(collection(db, 'users'))
        : query(collection(db, 'users'), where('uid', '==', uid));
    unsubs.push(
      onSnapshot(
        usersQuery,
        (snap) => {
          setUsers(
            snap.docs.map((d) => {
              const raw = d.data();
              return {
                uid: d.id,
                displayName: String(raw.displayName || 'User'),
                email: d.id === uid ? firebaseUser.email || '' : 'Protected (PII Isolated)',
                photoURL: raw.photoURL ? String(raw.photoURL) : undefined,
                role: (raw.role as UserRole) || 'VIEWER',
                notifyCriticalEvents: true,
                notifyJobCompletion: true,
                notifyWeeklySummary: false,
                createdAt: tsToIso(raw.createdAt),
                updatedAt: tsToIso(raw.updatedAt),
              };
            })
          );
        },
        (err) => handleFirestoreError(err, OperationType.LIST, 'users')
      )
    );

    if (firebaseUser.email?.toLowerCase() === BOOTSTRAPPED_ADMIN_EMAIL) {
      unsubs.push(
        onSnapshot(
          collection(db, 'auditLogs'),
          (snap) => {
            setAuditLogs(
              snap.docs.map((d) => {
                const raw = d.data();
                return {
                  id: d.id,
                  actorId: String(raw.actorId || ''),
                  actorName: String(raw.actorId || 'System'),
                  actorRole: (raw.actorRole as UserRole) || 'ANALYST',
                  action: String(raw.action || ''),
                  targetType: String(raw.targetType || ''),
                  targetId: String(raw.targetId || ''),
                  details: String(raw.details || ''),
                  createdAt: tsToIso(raw.createdAt),
                };
              })
            );
          },
          (err) => handleFirestoreError(err, OperationType.LIST, 'auditLogs')
        )
      );
    }

    return () => {
      for (const u of unsubs) u();
    };
  }, [firebaseUser, isDemoMode]);

  // Derived Conflict Fingerprints calculated dynamically from actual stored conflict events
  const conflictFingerprints = useMemo(
    () => buildConflictFingerprints(conflictEvents, locations, fingerprintStatuses),
    [conflictEvents, locations, fingerprintStatuses]
  );

  // Append an audit entry
  const recordAudit = useCallback(
    async (action: string, targetType: string, targetId: string, details: string) => {
      if (!currentUser) return;
      const nowIso = new Date().toISOString();
      const id = sanitizeFirestoreId(`aud_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
      const entry: AuditLogEntry = {
        id,
        actorId: currentUser.uid,
        actorName: currentUser.displayName,
        actorRole: currentUser.role,
        action,
        targetType,
        targetId,
        details: details.slice(0, 500),
        createdAt: nowIso,
      };
      if (isDemoMode) {
        setAuditLogs((prev) => [entry, ...prev]);
        return;
      }
      if (!firebaseUser?.emailVerified) return;
      try {
        await setDoc(doc(db, 'auditLogs', id), {
          actorId: currentUser.uid,
          actorRole: currentUser.role,
          action: action.slice(0, 120),
          targetType: targetType.slice(0, 80),
          targetId: targetId.slice(0, 128),
          details: details.slice(0, 500),
          createdAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, `auditLogs/${id}`);
      }
    },
    [currentUser, isDemoMode, firebaseUser]
  );

  // --- Auth Workflows ---
  const loginWithGoogle = useCallback(async () => {
    localStorage.removeItem('roadshadow_demo_mode');
    setIsDemoMode(false);
    await signInWithPopup(auth, googleProvider);
    pushToast({ type: 'success', title: 'Signed in with Google' });
  }, [pushToast]);

  const loginWithEmail = useCallback(
    async (email: string, password: string) => {
      localStorage.removeItem('roadshadow_demo_mode');
      setIsDemoMode(false);
      const cred = await signInWithEmailAndPassword(auth, email, password);
      if (!cred.user.emailVerified) {
        pushToast({
          type: 'warning',
          title: 'Email Verification Required',
          description: 'Please verify your email address before modifying Firestore project data.',
        });
      } else {
        pushToast({ type: 'success', title: 'Signed in successfully' });
      }
    },
    [pushToast]
  );

  const registerWithEmail = useCallback(
    async (displayName: string, email: string, password: string) => {
      localStorage.removeItem('roadshadow_demo_mode');
      setIsDemoMode(false);
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(cred.user, { displayName });
      await sendEmailVerification(cred.user);
      pushToast({
        type: 'info',
        title: 'Account Created — Verify Email',
        description: 'A verification link has been sent to your email address.',
      });
    },
    [pushToast]
  );

  const requestPasswordReset = useCallback(
    async (email: string) => {
      await sendPasswordResetEmail(auth, email);
      pushToast({
        type: 'success',
        title: 'Password Reset Email Sent',
        description: `Check ${email} for secure password reset instructions.`,
      });
    },
    [pushToast]
  );

  const logout = useCallback(async () => {
    if (isDemoMode) {
      exitDemoMode();
      pushToast({ type: 'info', title: 'Exited Demonstration Mode' });
      return;
    }
    await signOut(auth);
    setCurrentUser(null);
    pushToast({ type: 'info', title: 'Signed out of ROADSHADOW' });
  }, [isDemoMode, exitDemoMode, pushToast]);

  const updateCurrentUserProfile = useCallback(
    async (updates: {
      displayName?: string;
      photoURL?: string;
      notifyCriticalEvents?: boolean;
      notifyJobCompletion?: boolean;
      notifyWeeklySummary?: boolean;
    }) => {
      if (!currentUser) return;
      const updatedUser: UserProfile = {
        ...currentUser,
        ...updates,
        updatedAt: new Date().toISOString(),
      };
      setCurrentUser(updatedUser);
      setUsers((prev) => prev.map((u) => (u.uid === currentUser.uid ? updatedUser : u)));

      if (!isDemoMode && firebaseUser?.emailVerified) {
        try {
          if (updates.displayName !== undefined || updates.photoURL !== undefined) {
            await updateDoc(doc(db, 'users', currentUser.uid), {
              displayName: (updates.displayName ?? currentUser.displayName).slice(0, 120),
              photoURL: (updates.photoURL ?? currentUser.photoURL ?? '').slice(0, 512),
              updatedAt: serverTimestamp(),
            });
          }
          await updateDoc(doc(db, 'users', currentUser.uid, 'private', 'profile'), {
            email: currentUser.email,
            notifyCriticalEvents: updatedUser.notifyCriticalEvents,
            notifyJobCompletion: updatedUser.notifyJobCompletion,
            notifyWeeklySummary: updatedUser.notifyWeeklySummary,
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `users/${currentUser.uid}`);
        }
      }
      pushToast({ type: 'success', title: 'Profile & Preferences Saved' });
    },
    [currentUser, isDemoMode, firebaseUser, pushToast]
  );

  // --- Project CRUD (BUG 1 Fix: atomic creation, immediate selection, never fake success on DB error) ---
  const createProject = useCallback(
    async (input: Omit<Project, 'id' | 'ownerId' | 'createdAt' | 'updatedAt'>) => {
      if (!currentUser) throw new Error('Authentication required.');
      const id = sanitizeFirestoreId(`proj_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
      const nowIso = new Date().toISOString();
      const record: Project = {
        ...input,
        id,
        ownerId: currentUser.uid,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      if (isDemoMode) {
        setProjects((prev) => [record, ...prev]);
      } else {
        try {
          await setDoc(doc(db, 'projects', id), {
            ownerId: currentUser.uid,
            name: input.name.slice(0, 120),
            ...(input.locationSummary ? { locationSummary: input.locationSummary.slice(0, 200) } : {}),
            ...(input.selectedCameraId ? { selectedCameraId: input.selectedCameraId.slice(0, 128) } : {}),
            description: input.description.slice(0, 1000),
            startDate: input.startDate.slice(0, 32),
            ...(input.endDate ? { endDate: input.endDate.slice(0, 32) } : {}),
            status: input.status,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          // Optimistically add immediately so selection works without waiting for snapshot latency
          setProjects((prev) => [record, ...prev.filter((p) => p.id !== id)]);
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, `projects/${id}`);
          throw err;
        }
      }
      setSelectedProjectId(record.id);
      await recordAudit('PROJECT_CREATED', 'Project', id, `Created project "${input.name}".`);
      pushToast({ type: 'success', title: 'Project Created & Selected', description: input.name });
      return record;
    },
    [currentUser, isDemoMode, setSelectedProjectId, recordAudit, pushToast]
  );

  const updateProject = useCallback(
    async (
      id: string,
      updates: Partial<
        Pick<
          Project,
          'name' | 'locationSummary' | 'selectedCameraId' | 'description' | 'startDate' | 'endDate' | 'status'
        >
      >
    ) => {
      if (isDemoMode) {
        setProjects((prev) =>
          prev.map((p) => (p.id === id ? { ...p, ...updates, updatedAt: new Date().toISOString() } : p))
        );
      } else {
        try {
          const allowed: Record<string, unknown> = { updatedAt: serverTimestamp() };
          if (updates.name !== undefined && updates.name.trim().length >= 2) {
            allowed.name = updates.name.trim().slice(0, 120);
          }
          if (updates.locationSummary !== undefined) {
            allowed.locationSummary = updates.locationSummary.trim().slice(0, 200);
          }
          if (updates.selectedCameraId !== undefined) {
            allowed.selectedCameraId = updates.selectedCameraId.slice(0, 128);
          }
          if (updates.description !== undefined) {
            allowed.description = updates.description.slice(0, 1000);
          }
          if (updates.startDate !== undefined && updates.startDate.trim().length >= 4) {
            allowed.startDate = updates.startDate.trim().slice(0, 32);
          }
          if (updates.endDate !== undefined) {
            allowed.endDate = updates.endDate.trim().slice(0, 32);
          }
          if (updates.status === 'active' || updates.status === 'archived') {
            allowed.status = updates.status;
          }
          await updateDoc(doc(db, 'projects', id), allowed);
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `projects/${id}`);
          throw err;
        }
      }
      await recordAudit('PROJECT_UPDATED', 'Project', id, `Updated project fields: ${Object.keys(updates).join(', ')}.`);
      pushToast({ type: 'success', title: 'Project Updated' });
    },
    [isDemoMode, recordAudit, pushToast]
  );

  // --- Per-Project Road Camera / Footage Source Selection (BUG 2 Fix) ---
  const selectSourceForProject = useCallback(
    async (projectId: string, source: ActiveCameraSource) => {
      const key = projectId || 'ALL';
      setSelectedSourceByProject((prev) => {
        const next = { ...prev, [key]: source };
        if (typeof window !== 'undefined') {
          localStorage.setItem(STORAGE_KEYS.cameraSources, JSON.stringify(next));
        }
        return next;
      });

      if (key !== 'ALL' && source.cameraId) {
        setProjects((prev) =>
          prev.map((p) =>
            p.id === key
              ? { ...p, selectedCameraId: source.cameraId, updatedAt: new Date().toISOString() }
              : p
          )
        );
        if (!isDemoMode && firebaseUser?.emailVerified) {
          try {
            await updateDoc(doc(db, 'projects', key), {
              selectedCameraId: source.cameraId.slice(0, 128),
              updatedAt: serverTimestamp(),
            });
          } catch {
            // Non-blocking sync; local selection already saved
          }
        }
      }
    },
    [isDemoMode, firebaseUser]
  );

  const clearSourceForProject = useCallback((projectId: string) => {
    const key = projectId || 'ALL';
    setSelectedSourceByProject((prev) => {
      const next = { ...prev };
      delete next[key];
      if (typeof window !== 'undefined') {
        localStorage.setItem(STORAGE_KEYS.cameraSources, JSON.stringify(next));
      }
      return next;
    });
  }, []);

  const deleteProject = useCallback(
    async (id: string) => {
      // Documented Cascade Policy: delete only child locations, cameras, videos, events, recommendations, reports belonging strictly to this projectId
      if (isDemoMode) {
        setProjects((prev) => prev.filter((p) => p.id !== id));
        setLocations((prev) => prev.filter((l) => l.projectId !== id));
        setCameras((prev) => prev.filter((c) => c.projectId !== id));
        setVideos((prev) => prev.filter((v) => v.projectId !== id));
        setProcessingJobs((prev) => prev.filter((j) => j.projectId !== id));
        setConflictEvents((prev) => prev.filter((e) => e.projectId !== id));
        setRecommendations((prev) => prev.filter((r) => r.projectId !== id));
        setReports((prev) => prev.filter((r) => r.projectId !== id));
      } else {
        try {
          const batch = writeBatch(db);
          batch.delete(doc(db, 'projects', id));
          for (const l of locations.filter((item) => item.projectId === id)) {
            batch.delete(doc(db, 'locations', l.id));
          }
          for (const c of cameras.filter((item) => item.projectId === id)) {
            batch.delete(doc(db, 'cameras', c.id));
          }
          for (const v of videos.filter((item) => item.projectId === id)) {
            batch.delete(doc(db, 'videos', v.id));
          }
          for (const j of processingJobs.filter((item) => item.projectId === id)) {
            batch.delete(doc(db, 'processingJobs', j.id));
          }
          for (const ev of conflictEvents.filter((item) => item.projectId === id)) {
            batch.delete(doc(db, 'conflictEvents', ev.id));
          }
          for (const r of recommendations.filter((item) => item.projectId === id)) {
            batch.delete(doc(db, 'recommendations', r.id));
          }
          for (const rep of reports.filter((item) => item.projectId === id)) {
            batch.delete(doc(db, 'reports', rep.id));
          }
          await batch.commit();
        } catch (err) {
          handleFirestoreError(err, OperationType.DELETE, `projects/${id}`);
        }
      }
      if (selectedProjectId === id) setSelectedProjectId('ALL');
      await recordAudit('PROJECT_DELETED', 'Project', id, 'Deleted project and strictly scoped child entities.');
      pushToast({ type: 'info', title: 'Project Deleted' });
    },
    [
      isDemoMode,
      locations,
      cameras,
      videos,
      processingJobs,
      conflictEvents,
      recommendations,
      reports,
      selectedProjectId,
      setSelectedProjectId,
      recordAudit,
      pushToast,
    ]
  );

  // --- Locations CRUD ---
  const createLocation = useCallback(
    async (input: Omit<RoadLocation, 'id' | 'ownerId' | 'createdAt' | 'updatedAt'>) => {
      if (!currentUser) throw new Error('Authentication required.');
      const id = sanitizeFirestoreId(`loc_${Date.now()}`);
      const nowIso = new Date().toISOString();
      const record: RoadLocation = {
        ...input,
        id,
        ownerId: currentUser.uid,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      if (isDemoMode) {
        setLocations((prev) => [record, ...prev]);
      } else {
        try {
          await setDoc(doc(db, 'locations', id), {
            projectId: input.projectId,
            ownerId: currentUser.uid,
            name: input.name.slice(0, 140),
            address: input.address.slice(0, 260),
            city: input.city.slice(0, 100),
            state: input.state.slice(0, 100),
            country: input.country.slice(0, 100),
            latitude: Number(input.latitude),
            longitude: Number(input.longitude),
            locationType: input.locationType,
            description: input.description.slice(0, 1000),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, `locations/${id}`);
        }
      }
      await recordAudit('LOCATION_CREATED', 'Location', id, `Registered location "${input.name}".`);
      pushToast({ type: 'success', title: 'Location Added', description: input.name });
      return record;
    },
    [currentUser, isDemoMode, recordAudit, pushToast]
  );

  const updateLocation = useCallback(
    async (id: string, updates: Partial<RoadLocation>) => {
      if (isDemoMode) {
        setLocations((prev) =>
          prev.map((l) => (l.id === id ? { ...l, ...updates, updatedAt: new Date().toISOString() } : l))
        );
      } else {
        try {
          const allowed: Record<string, unknown> = { updatedAt: serverTimestamp() };
          for (const key of ['name', 'address', 'city', 'state', 'country', 'latitude', 'longitude', 'locationType', 'description'] as const) {
            if (updates[key] !== undefined) allowed[key] = updates[key];
          }
          await updateDoc(doc(db, 'locations', id), allowed);
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `locations/${id}`);
        }
      }
      pushToast({ type: 'success', title: 'Location Updated' });
    },
    [isDemoMode, pushToast]
  );

  const deleteLocation = useCallback(
    async (id: string) => {
      if (isDemoMode) {
        setLocations((prev) => prev.filter((l) => l.id !== id));
      } else {
        try {
          await deleteDoc(doc(db, 'locations', id));
        } catch (err) {
          handleFirestoreError(err, OperationType.DELETE, `locations/${id}`);
        }
      }
      await recordAudit('LOCATION_DELETED', 'Location', id, 'Removed location record.');
      pushToast({ type: 'info', title: 'Location Removed' });
    },
    [isDemoMode, recordAudit, pushToast]
  );

  // --- Cameras CRUD ---
  const createCamera = useCallback(
    async (input: Omit<Camera, 'id' | 'ownerId' | 'createdAt' | 'updatedAt'>) => {
      if (!currentUser) throw new Error('Authentication required.');
      const id = sanitizeFirestoreId(`cam_${Date.now()}`);
      const nowIso = new Date().toISOString();
      const record: Camera = {
        ...input,
        id,
        ownerId: currentUser.uid,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      if (isDemoMode) {
        setCameras((prev) => [record, ...prev]);
      } else {
        try {
          await setDoc(doc(db, 'cameras', id), {
            projectId: input.projectId,
            locationId: input.locationId,
            ownerId: currentUser.uid,
            name: input.name.slice(0, 120),
            cameraType: input.cameraType.slice(0, 80),
            direction: input.direction.slice(0, 80),
            resolution: input.resolution.slice(0, 40),
            ...(input.frameRate ? { frameRate: Number(input.frameRate) } : {}),
            ...(input.installationDate ? { installationDate: input.installationDate.slice(0, 32) } : {}),
            status: input.status,
            description: input.description.slice(0, 800),
            rtspAdapterEnabled: Boolean(input.rtspAdapterEnabled),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, `cameras/${id}`);
        }
      }
      await recordAudit('CAMERA_CREATED', 'Camera', id, `Added camera "${input.name}".`);
      pushToast({ type: 'success', title: 'Camera Registered', description: input.name });
      return record;
    },
    [currentUser, isDemoMode, recordAudit, pushToast]
  );

  const updateCamera = useCallback(
    async (id: string, updates: Partial<Camera>) => {
      if (isDemoMode) {
        setCameras((prev) =>
          prev.map((c) => (c.id === id ? { ...c, ...updates, updatedAt: new Date().toISOString() } : c))
        );
      } else {
        try {
          const allowed: Record<string, unknown> = { updatedAt: serverTimestamp() };
          for (const key of ['locationId', 'name', 'cameraType', 'direction', 'resolution', 'frameRate', 'installationDate', 'status', 'description', 'rtspAdapterEnabled'] as const) {
            if (updates[key] !== undefined) allowed[key] = updates[key];
          }
          await updateDoc(doc(db, 'cameras', id), allowed);
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `cameras/${id}`);
        }
      }
      pushToast({ type: 'success', title: 'Camera Updated' });
    },
    [isDemoMode, pushToast]
  );

  const deleteCamera = useCallback(
    async (id: string) => {
      if (isDemoMode) {
        setCameras((prev) => prev.filter((c) => c.id !== id));
      } else {
        try {
          await deleteDoc(doc(db, 'cameras', id));
        } catch (err) {
          handleFirestoreError(err, OperationType.DELETE, `cameras/${id}`);
        }
      }
      await recordAudit('CAMERA_DELETED', 'Camera', id, 'Removed camera record.');
      pushToast({ type: 'info', title: 'Camera Removed' });
    },
    [isDemoMode, recordAudit, pushToast]
  );

  // --- Video Upload + Processing Job + Detected Events Registration ---
  const registerUploadedVideoAndResults = useCallback(
    async (payload: {
      video: VideoRecord;
      job: ProcessingJob;
      events: ConflictEvent[];
      mode?: 'create' | 'update';
    }) => {
      const { video, job, events, mode = 'create' } = payload;
      setVideos((prev) => [video, ...prev.filter((v) => v.id !== video.id)]);
      setProcessingJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]);
      if (events.length > 0) {
        setConflictEvents((prev) => {
          const newIds = new Set(events.map((e) => e.id));
          return [...events, ...prev.filter((e) => !newIds.has(e.id))];
        });
      }

      const notifSeverity: AppNotification['severity'] =
        job.status === 'Failed'
          ? 'warning'
          : job.status === 'Cancelled'
            ? 'info'
            : events.some((e) => e.riskCategory === 'Critical')
              ? 'critical'
              : 'success';

      const notifMessage =
        job.status === 'Failed'
          ? job.errorMessage || 'CV analysis could not run. The uploaded video remains safely stored in your project.'
          : job.status === 'Cancelled'
            ? 'Analysis job was cancelled. The uploaded video remains saved in your project.'
            : `${events.length} potential conflict event(s) identified via ${job.modelVersion}.`;

      const notif: AppNotification = {
        id: sanitizeFirestoreId(`notif_${Date.now()}`),
        userId: video.ownerId,
        title: `Analysis ${job.status}: ${video.title}`,
        message: notifMessage.slice(0, 500),
        severity: notifSeverity,
        read: false,
        linkPath: `/video-analysis/${video.id}`,
        createdAt: new Date().toISOString(),
      };
      setNotifications((prev) => [notif, ...prev]);

      if (!isDemoMode && firebaseUser?.emailVerified) {
        const safeOwnerId = firebaseUser.uid;
        const safeVideoId = sanitizeFirestoreId(video.id);
        const safeProjectId = sanitizeFirestoreId(video.projectId);
        const safeLocationId = sanitizeFirestoreId(video.locationId);
        const safeCameraId = sanitizeFirestoreId(video.cameraId);
        const rawTitle = (video.title || video.fileName || 'Traffic Footage').trim();
        const safeTitle = (rawTitle.length >= 2 ? rawTitle : `Clip ${rawTitle || 'Video'}`).slice(0, 160);
        const safeFileName = (video.fileName || 'traffic_video.mp4').trim().slice(0, 200);
        const allowedMimes: Array<VideoRecord['mimeType']> = ['video/mp4', 'video/quicktime', 'video/webm'];
        const safeMimeType = allowedMimes.includes(video.mimeType) ? video.mimeType : 'video/mp4';
        const safeFileSize = Number.isFinite(video.fileSizeBytes)
          ? Math.min(1073741824, Math.max(0, Math.round(video.fileSizeBytes)))
          : 0;
        const safeDuration = Number.isFinite(video.durationSec)
          ? Math.min(86400, Math.max(0, Number(video.durationSec)))
          : 0;
        const allowedStatuses: Array<VideoRecord['status']> = [
          'Draft',
          'Uploading',
          'Uploaded',
          'Queued',
          'Processing',
          'Completed',
          'Failed',
          'Cancelled',
        ];
        const safeStatus = allowedStatuses.includes(video.status) ? video.status : 'Uploaded';
        const safeRecordingDate =
          video.recordingDate && video.recordingDate.trim().length >= 4
            ? video.recordingDate.trim().slice(0, 32)
            : new Date().toISOString().slice(0, 10);
        const safeRecordingTime =
          video.recordingTime && video.recordingTime.trim().length >= 4
            ? video.recordingTime.trim().slice(0, 32)
            : '08:45';
        const safeRoadType =
          video.roadType && video.roadType.trim().length >= 2
            ? video.roadType.trim().slice(0, 80)
            : 'Intersection';
        const safeWidth =
          typeof video.width === 'number' && Number.isFinite(video.width)
            ? Math.min(16384, Math.max(0, Math.round(video.width)))
            : undefined;
        const safeHeight =
          typeof video.height === 'number' && Number.isFinite(video.height)
            ? Math.min(16384, Math.max(0, Math.round(video.height)))
            : undefined;
        const safeFps =
          typeof video.fps === 'number' && Number.isFinite(video.fps)
            ? Math.min(240, Math.max(0, Number(video.fps)))
            : undefined;
        const safeLat =
          typeof video.latitude === 'number' &&
          Number.isFinite(video.latitude) &&
          video.latitude >= -90 &&
          video.latitude <= 90
            ? video.latitude
            : undefined;
        const safeLng =
          typeof video.longitude === 'number' &&
          Number.isFinite(video.longitude) &&
          video.longitude >= -180 &&
          video.longitude <= 180
            ? video.longitude
            : undefined;

        try {
          if (mode === 'update') {
            await updateDoc(doc(db, 'videos', safeVideoId), {
              status: safeStatus,
              durationSec: safeDuration,
              ...(video.posterUrl ? { posterUrl: video.posterUrl.slice(0, 512) } : {}),
              ...(safeWidth !== undefined ? { width: safeWidth } : {}),
              ...(safeHeight !== undefined ? { height: safeHeight } : {}),
              ...(safeFps !== undefined ? { fps: safeFps } : {}),
              errorMessage: video.errorMessage ? video.errorMessage.slice(0, 600) : '',
              updatedAt: serverTimestamp(),
            });
          } else {
            await setDoc(doc(db, 'videos', safeVideoId), {
              projectId: safeProjectId,
              locationId: safeLocationId,
              cameraId: safeCameraId,
              ownerId: safeOwnerId,
              title: safeTitle,
              fileName: safeFileName,
              mimeType: safeMimeType,
              fileSizeBytes: safeFileSize,
              fileUrl: (video.fileUrl || '/api/uploads/files/unknown.mp4').slice(0, 512),
              ...(video.posterUrl ? { posterUrl: video.posterUrl.slice(0, 512) } : {}),
              ...(safeWidth !== undefined ? { width: safeWidth } : {}),
              ...(safeHeight !== undefined ? { height: safeHeight } : {}),
              ...(safeFps !== undefined ? { fps: safeFps } : {}),
              ...(video.errorMessage ? { errorMessage: video.errorMessage.slice(0, 600) } : {}),
              recordingDate: safeRecordingDate,
              recordingTime: safeRecordingTime,
              ...(safeLat !== undefined ? { latitude: safeLat } : {}),
              ...(safeLng !== undefined ? { longitude: safeLng } : {}),
              roadType: safeRoadType,
              description: (video.description || '').slice(0, 1000),
              durationSec: safeDuration,
              status: safeStatus,
              isDemonstration: Boolean(video.isDemonstration),
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          }
        } catch (err) {
          handleFirestoreError(
            err,
            mode === 'update' ? OperationType.UPDATE : OperationType.CREATE,
            `videos/${safeVideoId}`
          );
          throw err;
        }

        const safeJobId = sanitizeFirestoreId(job.id);
        const allowedJobStatuses: Array<ProcessingJob['status']> = [
          'Queued',
          'Processing',
          'Completed',
          'Failed',
          'Cancelled',
        ];
        const safeJobStatus = allowedJobStatuses.includes(job.status) ? job.status : 'Failed';
        const allowedEngineModes: Array<ProcessingJob['engineMode']> = [
          'CV_SERVICE',
          'DEVELOPMENT_FALLBACK',
          'DEMONSTRATION',
        ];
        const safeEngineMode = allowedEngineModes.includes(job.engineMode)
          ? job.engineMode
          : 'CV_SERVICE';
        const rawModelVer = (job.modelVersion || 'CV Worker').trim();
        const safeModelVer = (rawModelVer.length >= 2 ? rawModelVer : 'CV Worker').slice(0, 120);
        const safeWarnings = Array.isArray(job.warnings)
          ? job.warnings
              .filter((w): w is string => typeof w === 'string' && w.length > 0)
              .slice(0, 20)
          : [];

        try {
          await setDoc(doc(db, 'processingJobs', safeJobId), {
            videoId: safeVideoId,
            projectId: safeProjectId,
            ownerId: safeOwnerId,
            status: safeJobStatus,
            progress: Number.isFinite(job.progress)
              ? Math.min(100, Math.max(0, Number(job.progress)))
              : 0,
            engineMode: safeEngineMode,
            modelVersion: safeModelVer,
            analyzedFrames: Number.isFinite(job.analyzedFrames)
              ? Math.max(0, Math.round(job.analyzedFrames))
              : 0,
            processingTimeMs: Number.isFinite(job.processingTimeMs)
              ? Math.max(0, Math.round(job.processingTimeMs))
              : 0,
            detectedObjectCount: Number.isFinite(job.detectedObjectCount)
              ? Math.max(0, Math.round(job.detectedObjectCount))
              : 0,
            trackingCount: Number.isFinite(job.trackingCount)
              ? Math.max(0, Math.round(job.trackingCount))
              : 0,
            conflictCount: Number.isFinite(job.conflictCount)
              ? Math.max(0, Math.round(job.conflictCount))
              : 0,
            warnings: safeWarnings,
            ...(job.errorMessage ? { errorMessage: job.errorMessage.slice(0, 600) } : {}),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, `processingJobs/${safeJobId}`);
          throw err;
        }

        for (const ev of events) {
          const safeEventId = sanitizeFirestoreId(ev.id);
          try {
            await setDoc(doc(db, 'conflictEvents', safeEventId), {
              videoId: safeVideoId,
              projectId: safeProjectId,
              locationId: safeLocationId,
              ownerId: safeOwnerId,
              timestampSec: Number.isFinite(ev.timestampSec) ? Math.max(0, ev.timestampSec) : 0,
              frameNumber: Number.isFinite(ev.frameNumber) ? Math.max(0, Math.round(ev.frameNumber)) : 0,
              occurredAt: (ev.occurredAt || new Date().toISOString()).slice(0, 64),
              conflictType: ev.conflictType,
              originalConflictType: ev.originalConflictType,
              riskScore: Number.isFinite(ev.riskScore)
                ? Math.min(100, Math.max(0, Number(ev.riskScore)))
                : 0,
              riskCategory: ev.riskCategory,
              ...(ev.interactionTier ? { interactionTier: ev.interactionTier } : {}),
              detectionConfidence: Number.isFinite(ev.detectionConfidence)
                ? Math.min(1, Math.max(0, Number(ev.detectionConfidence)))
                : 0,
              measurementQuality: ev.measurementQuality,
              estimatedTtcSec: ev.estimatedTtcSec ?? null,
              ...(ev.estimatedPetSec !== undefined ? { estimatedPetSec: ev.estimatedPetSec } : {}),
              ...(ev.evasiveManeuverDetected !== undefined
                ? { evasiveManeuverDetected: ev.evasiveManeuverDetected }
                : {}),
              estimatedMinSeparationPx: ev.estimatedMinSeparationPx ?? null,
              relativeSpeedPxPerSec: ev.relativeSpeedPxPerSec ?? null,
              trajectoryConvergenceDeg: ev.trajectoryConvergenceDeg ?? null,
              ...(ev.movementDirection ? { movementDirection: ev.movementDirection.slice(0, 120) } : {}),
              roadUsers: (ev.roadUsers || []).slice(0, 10),
              involvedTrackIds: (ev.involvedTrackIds || []).slice(0, 10),
              contributingFactors: (ev.contributingFactors || []).slice(0, 12),
              measurementLimitations: (ev.measurementLimitations || []).slice(0, 12),
              evidenceSummary: (ev.evidenceSummary || 'Detected road-user conflict').slice(0, 1000),
              validationStatus: ev.validationStatus,
              isDemonstration: Boolean(ev.isDemonstration),
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          } catch (err) {
            handleFirestoreError(err, OperationType.CREATE, `conflictEvents/${safeEventId}`);
            throw err;
          }
        }
      }

      await recordAudit(
        'VIDEO_PROCESSED',
        'Video',
        video.id,
        `Job ${job.id} finished with status ${job.status} (${job.engineMode}, ${events.length} conflict events).`
      );
    },
    [isDemoMode, firebaseUser, recordAudit]
  );

  // --- Remove Video + Scoped Jobs + Scoped Events + Server File ---
  const deleteVideo = useCallback(
    async (videoId: string) => {
      const target = videos.find((v) => v.id === videoId);
      if (!target) return;

      // Best-effort remove physical uploaded file on server if stored in /api/uploads/files/
      if (target.fileUrl.startsWith('/api/uploads/files/')) {
        const encodedName = target.fileUrl.slice('/api/uploads/files/'.length);
        try {
          await roadshadowFetch(`/api/uploads/files/${encodedName}`, {
            method: 'DELETE',
            isDemoMode,
            demoRole: currentUser?.role,
          });
        } catch {
          // Non-fatal if file already cleaned up
        }
      }

      if (isDemoMode) {
        setVideos((prev) => prev.filter((v) => v.id !== videoId));
        setProcessingJobs((prev) => prev.filter((j) => j.videoId !== videoId));
        setConflictEvents((prev) => prev.filter((e) => e.videoId !== videoId));
      } else if (firebaseUser?.emailVerified) {
        try {
          const batch = writeBatch(db);
          batch.delete(doc(db, 'videos', videoId));
          for (const j of processingJobs.filter((item) => item.videoId === videoId)) {
            batch.delete(doc(db, 'processingJobs', j.id));
          }
          for (const ev of conflictEvents.filter((item) => item.videoId === videoId)) {
            batch.delete(doc(db, 'conflictEvents', ev.id));
          }
          await batch.commit();
        } catch (err) {
          handleFirestoreError(err, OperationType.DELETE, `videos/${videoId}`);
          throw err;
        }
      }

      await recordAudit('VIDEO_DELETED', 'Video', videoId, `Removed video "${target.title}" and scoped jobs/events.`);
      pushToast({ type: 'info', title: 'Video Removed', description: target.title });
    },
    [videos, processingJobs, conflictEvents, isDemoMode, currentUser?.role, firebaseUser, recordAudit, pushToast]
  );

  // --- Retry CV Analysis on an Existing Uploaded Video Without Re-Uploading ---
  const retryVideoAnalysis = useCallback(
    async (videoId: string): Promise<{ ok: boolean; status: string; error?: string }> => {
      const target = videos.find((v) => v.id === videoId);
      if (!target || !currentUser) {
        return { ok: false, status: 'Failed', error: 'Video record not found.' };
      }
      if (!target.fileUrl.startsWith('/api/uploads/files/')) {
        return {
          ok: false,
          status: 'Failed',
          error: 'Retry is only available for videos uploaded to server storage.',
        };
      }

      try {
        const res = await roadshadowFetch('/api/processing/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          isDemoMode,
          demoRole: currentUser.role,
          body: JSON.stringify({
            videoId: target.id,
            projectId: target.projectId,
            locationId: target.locationId,
            fileUrl: target.fileUrl,
            durationSec: target.durationSec || 0,
            occurredAtIso: `${target.recordingDate}T${target.recordingTime}:00.000Z`,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          const msg = data.error || 'Could not start analysis job.';
          pushToast({ type: 'error', title: 'Retry Failed', description: msg });
          return { ok: false, status: 'Failed', error: msg };
        }

        const jobId = data.job.id as string;
        let finalJob = data.job;
        for (let attempt = 0; attempt < 180; attempt += 1) {
          await new Promise((r) => setTimeout(r, 1000));
          const poll = await roadshadowFetch(`/api/processing/jobs/${jobId}`, {
            isDemoMode,
            demoRole: currentUser.role,
          });
          if (!poll.ok) continue;
          const polled = await poll.json();
          finalJob = polled.job;
          if (
            finalJob.status === 'Completed' ||
            finalJob.status === 'Failed' ||
            finalJob.status === 'Cancelled'
          ) {
            break;
          }
        }

        const nowIso = new Date().toISOString();
        const updatedVideo: VideoRecord = {
          ...target,
          status: finalJob.status,
          errorMessage: finalJob.errorMessage,
          detections: finalJob.resultPayload?.detections ?? target.detections,
          trajectories: finalJob.resultPayload?.trajectories ?? target.trajectories,
          updatedAt: nowIso,
        };
        const jobRecord: ProcessingJob = {
          id: finalJob.id,
          videoId: target.id,
          projectId: target.projectId,
          ownerId: currentUser.uid,
          status: finalJob.status,
          progress: finalJob.progress ?? 0,
          engineMode: finalJob.engineMode || 'CV_SERVICE',
          modelVersion: finalJob.modelVersion || 'CV Worker',
          analyzedFrames: finalJob.analyzedFrames || 0,
          processingTimeMs: finalJob.processingTimeMs || 0,
          detectedObjectCount: finalJob.detectedObjectCount || 0,
          trackingCount: finalJob.trackingCount || 0,
          conflictCount: finalJob.conflictCount || 0,
          warnings: finalJob.warnings || [],
          errorMessage: finalJob.errorMessage,
          createdAt: finalJob.createdAt || nowIso,
          updatedAt: nowIso,
        };

        await registerUploadedVideoAndResults({
          video: updatedVideo,
          job: jobRecord,
          events: finalJob.resultPayload?.events || [],
          mode: 'update',
        });

        if (finalJob.status === 'Completed') {
          pushToast({
            type: 'success',
            title: 'Analysis Completed',
            description: `${finalJob.conflictCount || 0} conflict event(s) detected.`,
          });
          return { ok: true, status: 'Completed' };
        }
        pushToast({
          type: 'warning',
          title: 'CV Analysis Unavailable',
          description: finalJob.errorMessage || 'External CV worker could not process this video.',
        });
        return { ok: false, status: finalJob.status, error: finalJob.errorMessage };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Retry request failed.';
        pushToast({ type: 'error', title: 'Retry Error', description: msg });
        return { ok: false, status: 'Failed', error: msg };
      }
    },
    [videos, currentUser, isDemoMode, registerUploadedVideoAndResults, pushToast]
  );

  // --- Human Validation of Conflict Events (Never overwrites originalConflictType!) ---
  const reviewConflictEvent = useCallback(
    async (
      eventId: string,
      updates: {
        validationStatus: ValidationStatus;
        conflictType: ConflictType;
        analystNotes?: string;
      }
    ) => {
      if (!currentUser) return;
      const nowIso = new Date().toISOString();
      setConflictEvents((prev) =>
        prev.map((ev) =>
          ev.id === eventId
            ? {
                ...ev,
                validationStatus: updates.validationStatus,
                conflictType: updates.conflictType,
                analystNotes: updates.analystNotes,
                reviewedBy: currentUser.displayName,
                updatedAt: nowIso,
              }
            : ev
        )
      );

      if (!isDemoMode && firebaseUser?.emailVerified) {
        try {
          await updateDoc(doc(db, 'conflictEvents', eventId), {
            validationStatus: updates.validationStatus,
            conflictType: updates.conflictType,
            analystNotes: (updates.analystNotes || '').slice(0, 1000),
            reviewedBy: currentUser.displayName.slice(0, 128),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `conflictEvents/${eventId}`);
        }
      }

      await recordAudit(
        'EVENT_REVIEWED',
        'ConflictEvent',
        eventId,
        `Updated validation status to "${updates.validationStatus}" and classification to "${updates.conflictType}".`
      );
      pushToast({
        type: 'success',
        title: 'Event Validation Saved',
        description: `Status set to ${updates.validationStatus}. Original AI output preserved.`,
      });
    },
    [currentUser, isDemoMode, firebaseUser, recordAudit, pushToast]
  );

  const saveEventAiExplanation = useCallback(
    (eventId: string, explanationText: string) => {
      setConflictEvents((prev) =>
        prev.map((ev) => (ev.id === eventId ? { ...ev, aiExplanation: explanationText } : ev))
      );
      if (!isDemoMode && firebaseUser?.emailVerified) {
        updateDoc(doc(db, 'conflictEvents', eventId), {
          aiExplanation: explanationText.slice(0, 3000),
          updatedAt: serverTimestamp(),
        }).catch(() => {
          // Non-fatal persistence warning
        });
      }
    },
    [isDemoMode, firebaseUser]
  );

  // --- Conflict Fingerprint Investigation Status ---
  const updateFingerprintStatus = useCallback(
    async (
      fingerprintId: string,
      status: ConflictFingerprint['investigationStatus']
    ) => {
      setFingerprintStatuses((prev) => {
        const next = { ...prev, [fingerprintId]: status };
        if (typeof window !== 'undefined') {
          localStorage.setItem('roadshadow_fp_statuses_v2', JSON.stringify(next));
        }
        return next;
      });
      await recordAudit(
        'FINGERPRINT_STATUS_UPDATED',
        'ConflictFingerprint',
        fingerprintId,
        `Changed investigation status to "${status}".`
      );
      pushToast({
        type: 'success',
        title: 'Fingerprint Status Updated',
        description: `Pattern marked as ${status}.`,
      });
    },
    [recordAudit, pushToast]
  );

  // --- Recommendations ---
  const createRecommendation = useCallback(
    async (input: Omit<SafetyRecommendation, 'id' | 'ownerId' | 'createdAt' | 'updatedAt'>) => {
      if (!currentUser) throw new Error('Authentication required.');
      const id = sanitizeFirestoreId(`rec_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`);
      const nowIso = new Date().toISOString();
      const record: SafetyRecommendation = {
        ...input,
        id,
        ownerId: currentUser.uid,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      if (isDemoMode) {
        setRecommendations((prev) => [record, ...prev]);
      } else {
        try {
          await setDoc(doc(db, 'recommendations', id), {
            projectId: input.projectId,
            locationId: input.locationId,
            ...(input.fingerprintId ? { fingerprintId: input.fingerprintId } : {}),
            ownerId: currentUser.uid,
            title: input.title.slice(0, 180),
            category: input.category,
            priority: input.priority,
            rationale: input.rationale.slice(0, 1500),
            evidenceSummary: input.evidenceSummary.slice(0, 1000),
            implementationSteps: input.implementationSteps.slice(0, 12),
            status: input.status,
            generatedByAi: Boolean(input.generatedByAi),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, `recommendations/${id}`);
        }
      }
      await recordAudit('RECOMMENDATION_CREATED', 'SafetyRecommendation', id, input.title);
      pushToast({ type: 'success', title: 'Recommendation Saved', description: input.title });
      return record;
    },
    [currentUser, isDemoMode, recordAudit, pushToast]
  );

  const updateRecommendationStatus = useCallback(
    async (id: string, status: SafetyRecommendation['status']) => {
      setRecommendations((prev) =>
        prev.map((r) => (r.id === id ? { ...r, status, updatedAt: new Date().toISOString() } : r))
      );
      if (!isDemoMode && firebaseUser?.emailVerified) {
        try {
          await updateDoc(doc(db, 'recommendations', id), {
            status,
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `recommendations/${id}`);
        }
      }
      await recordAudit('RECOMMENDATION_UPDATED', 'SafetyRecommendation', id, `Status -> ${status}`);
      pushToast({ type: 'success', title: 'Recommendation Updated', description: `Status: ${status}` });
    },
    [isDemoMode, firebaseUser, recordAudit, pushToast]
  );

  // --- Reports ---
  const createReport = useCallback(
    async (input: Omit<SafetyReport, 'id' | 'ownerId' | 'createdAt' | 'updatedAt'>) => {
      if (!currentUser) throw new Error('Authentication required.');
      const id = sanitizeFirestoreId(`rep_${Date.now()}`);
      const nowIso = new Date().toISOString();
      const record: SafetyReport = {
        ...input,
        id,
        ownerId: currentUser.uid,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      if (isDemoMode) {
        setReports((prev) => [record, ...prev]);
      } else {
        try {
          await setDoc(doc(db, 'reports', id), {
            projectId: input.projectId,
            ownerId: currentUser.uid,
            title: input.title.slice(0, 180),
            reportType: input.reportType,
            dateRangeStart: input.dateRangeStart,
            dateRangeEnd: input.dateRangeEnd,
            summary: input.summary.slice(0, 4000),
            ...(input.aiExecutiveSummary ? { aiExecutiveSummary: input.aiExecutiveSummary.slice(0, 4000) } : {}),
            includedLocationIds: input.includedLocationIds.slice(0, 50),
            metricsSnapshot: input.metricsSnapshot,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, `reports/${id}`);
        }
      }
      await recordAudit('REPORT_CREATED', 'SafetyReport', id, input.title);
      pushToast({ type: 'success', title: 'Report Generated', description: input.title });
      return record;
    },
    [currentUser, isDemoMode, recordAudit, pushToast]
  );

  // --- Notifications ---
  const markNotificationRead = useCallback(
    async (id: string) => {
      setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
      if (!isDemoMode && firebaseUser?.emailVerified) {
        try {
          await updateDoc(doc(db, 'notifications', id), { read: true });
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `notifications/${id}`);
        }
      }
    },
    [isDemoMode, firebaseUser]
  );

  const markAllNotificationsRead = useCallback(async () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    if (!isDemoMode && firebaseUser?.emailVerified) {
      const batch = writeBatch(db);
      for (const n of notifications.filter((item) => !item.read)) {
        batch.update(doc(db, 'notifications', n.id), { read: true });
      }
      try {
        await batch.commit();
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, 'notifications');
      }
    }
    pushToast({ type: 'info', title: 'All Notifications Marked Read' });
  }, [isDemoMode, firebaseUser, notifications, pushToast]);

  // --- User Management (RBAC) ---
  const updateUserRole = useCallback(
    async (uid: string, role: UserRole) => {
      if (currentUser?.role !== 'ADMINISTRATOR') {
        pushToast({ type: 'error', title: 'Permission Denied', description: 'Only administrators can change user roles.' });
        return;
      }
      setUsers((prev) => prev.map((u) => (u.uid === uid ? { ...u, role } : u)));
      if (!isDemoMode && firebaseUser?.emailVerified) {
        try {
          await updateDoc(doc(db, 'users', uid), {
            role,
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `users/${uid}`);
        }
      }
      await recordAudit('USER_ROLE_CHANGED', 'User', uid, `Updated role to ${role}.`);
      pushToast({ type: 'success', title: 'User Role Updated', description: `Role changed to ${role}.` });
    },
    [currentUser?.role, isDemoMode, firebaseUser, recordAudit, pushToast]
  );

  // --- Workspace Settings ---
  const updateWorkspaceSettings = useCallback(
    async (next: { riskBands: RiskBandConfig; maxUploadMb: number }) => {
      setSettings(next);
      if (!isDemoMode && currentUser && firebaseUser?.emailVerified) {
        const settingId = sanitizeFirestoreId(`cfg_${currentUser.uid}`);
        try {
          await setDoc(doc(db, 'settings', settingId), {
            ownerId: currentUser.uid,
            lowMax: next.riskBands.lowMax,
            mediumMax: next.riskBands.mediumMax,
            highMax: next.riskBands.highMax,
            maxUploadMb: next.maxUploadMb,
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.WRITE, `settings/${settingId}`);
        }
      }
      await recordAudit('SETTINGS_UPDATED', 'WorkspaceSetting', 'workspace', 'Updated provisional risk bands and upload limits.');
      pushToast({ type: 'success', title: 'Workspace Settings Saved' });
    },
    [isDemoMode, currentUser, firebaseUser, recordAudit, pushToast]
  );

  const value: RoadshadowContextValue = {
    authLoading,
    firebaseUser,
    currentUser,
    isDemoMode,
    enterDemoMode,
    exitDemoMode,
    switchDemoRole,
    resetDemoDataset,
    loginWithGoogle,
    loginWithEmail,
    registerWithEmail,
    requestPasswordReset,
    logout,
    updateCurrentUserProfile,
    selectedProjectId,
    setSelectedProjectId,
    selectedSourceByProject,
    selectSourceForProject,
    clearSourceForProject,
    globalSearch,
    setGlobalSearch,
    serverHealth,
    refreshServerHealth,
    projects,
    locations,
    cameras,
    videos: hydratedVideos,
    processingJobs,
    conflictEvents,
    conflictFingerprints,
    recommendations,
    reports,
    notifications,
    users,
    auditLogs,
    settings,
    createProject,
    updateProject,
    deleteProject,
    createLocation,
    updateLocation,
    deleteLocation,
    createCamera,
    updateCamera,
    deleteCamera,
    registerUploadedVideoAndResults,
    deleteVideo,
    retryVideoAnalysis,
    reviewConflictEvent,
    saveEventAiExplanation,
    updateFingerprintStatus,
    createRecommendation,
    updateRecommendationStatus,
    createReport,
    markNotificationRead,
    markAllNotificationsRead,
    updateUserRole,
    updateWorkspaceSettings,
    toasts,
    pushToast,
    dismissToast,
  };

  return (
    <RoadshadowContext.Provider value={value}>
      {children}
    </RoadshadowContext.Provider>
  );
}

export function useRoadshadow(): RoadshadowContextValue {
  const ctx = useContext(RoadshadowContext);
  if (!ctx) {
    throw new Error('useRoadshadow must be used within RoadshadowProvider');
  }
  return ctx;
}
