import React, { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bell,
  Camera,
  FileText,
  Fingerprint,
  FlaskConical,
  FolderKanban,
  HelpCircle,
  LayoutDashboard,
  Lightbulb,
  LogOut,
  Map as MapIcon,
  MapPin,
  Menu,
  PlaySquare,
  Radio,
  Search,
  Settings,
  Shield,
  Upload,
  Users,
  Video,
  X,
} from 'lucide-react';
import { useRoadshadow } from '../context/RoadshadowContext';
import { DEMO_IMAGES } from '../data/demoDataset';

interface NavGroup {
  label: string;
  items: Array<{
    to: string;
    label: string;
    icon: typeof LayoutDashboard;
  }>;
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Monitoring & Ingestion',
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard },
      { to: '/projects', label: 'Projects', icon: FolderKanban },
      { to: '/upload', label: 'Upload Video', icon: Upload },
      { to: '/video-analysis', label: 'Video Analysis', icon: Video },
      { to: '/live-analysis', label: 'Live Analysis', icon: Radio },
    ],
  },
  {
    label: 'Safety Intelligence',
    items: [
      { to: '/events', label: 'Conflict Events', icon: AlertTriangle },
      { to: '/fingerprints', label: 'Conflict Fingerprints', icon: Fingerprint },
      { to: '/improvement-lab', label: 'Junction Improvement Lab', icon: FlaskConical },
      { to: '/risk-map', label: 'Risk Map', icon: MapIcon },
      { to: '/analytics', label: 'Analytics', icon: BarChart3 },
      { to: '/recommendations', label: 'Recommendations', icon: Lightbulb },
      { to: '/reports', label: 'Reports', icon: FileText },
    ],
  },
  {
    label: 'Infrastructure',
    items: [
      { to: '/locations', label: 'Locations', icon: MapPin },
      { to: '/cameras', label: 'Camera Management', icon: Camera },
    ],
  },
  {
    label: 'Workspace & Access',
    items: [
      { to: '/demo', label: 'Demonstration Mode', icon: PlaySquare },
      { to: '/notifications', label: 'Notifications', icon: Bell },
      { to: '/users', label: 'User Management', icon: Users },
      { to: '/settings', label: 'Settings', icon: Settings },
      { to: '/help', label: 'Help & Docs', icon: HelpCircle },
    ],
  },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const {
    currentUser,
    isDemoMode,
    projects,
    selectedProjectId,
    setSelectedProjectId,
    globalSearch,
    setGlobalSearch,
    notifications,
    logout,
  } = useRoadshadow();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const navigate = useNavigate();

  const unreadCount = notifications.filter((n) => !n.read).length;

  const sidebarContent = (
    <div className="flex flex-col h-full bg-[#0D1F35] border-r border-[#233B56]">
      <div className="h-16 px-5 flex items-center justify-between border-b border-[#233B56] shrink-0">
        <button
          type="button"
          onClick={() => {
            navigate('/');
            setMobileNavOpen(false);
          }}
          className="flex items-center gap-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2585FF] rounded"
        >
          <span className="w-8 h-8 rounded-md bg-[#2585FF] flex items-center justify-center shrink-0">
            <Shield className="w-4 h-4 text-white" aria-hidden="true" />
          </span>
          <span className="leading-tight">
            <span className="block font-bold tracking-tight text-base text-[#F5F8FC] whitespace-nowrap">
              ROADSHADOW 2.0
            </span>
            <span className="block text-[10px] font-mono text-[#A9B8CA] whitespace-nowrap">
              TEAM ADIT
            </span>
          </span>
        </button>
        <button
          type="button"
          onClick={() => setMobileNavOpen(false)}
          aria-label="Close navigation drawer"
          className="lg:hidden p-1.5 text-[#A9B8CA] hover:text-[#F5F8FC] rounded"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {isDemoMode && (
        <div className="mx-3 mt-3 px-3 py-2 bg-[#122943] border border-[#2585FF]/40 rounded-md">
          <div className="flex items-center gap-1.5 text-xs font-medium text-[#45B5FF]">
            <Activity className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span>Demonstration Dataset</span>
          </div>
          <p className="text-[11px] text-[#A9B8CA] mt-0.5 leading-snug">
            Sample Indian pilot footage &amp; precomputed records.
          </p>
        </div>
      )}

      <nav aria-label="Main navigation" className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            <p className="px-3 mb-1.5 text-[11px] font-medium text-[#A9B8CA]/80">
              {group.label}
            </p>
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      end={item.to === '/'}
                      onClick={() => setMobileNavOpen(false)}
                      className={({ isActive }) =>
                        `flex items-center justify-between gap-2.5 px-3 py-2 rounded-md text-sm font-medium transition-colors whitespace-nowrap ${
                          isActive
                            ? 'bg-[#2585FF]/15 text-[#F5F8FC] border border-[#2585FF]/40'
                            : 'text-[#A9B8CA] hover:text-[#F5F8FC] hover:bg-[#122943]/80 border border-transparent'
                        }`
                      }
                    >
                      <span className="flex items-center gap-2.5 truncate">
                        <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                        <span className="truncate">{item.label}</span>
                      </span>
                      {item.to === '/notifications' && unreadCount > 0 && (
                        <span className="text-xs font-mono tabular-nums text-[#45B5FF]">
                          {unreadCount}
                        </span>
                      )}
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="p-3 border-t border-[#233B56] shrink-0 space-y-2">
        <div className="px-3 py-2 rounded-md bg-[#071426] border border-[#233B56]">
          <p className="text-xs font-medium text-[#F5F8FC] truncate">
            {currentUser?.displayName || 'User'}
          </p>
          <p className="text-[11px] text-[#A9B8CA] truncate mt-0.5">
            {currentUser?.role || 'VIEWER'} · {isDemoMode ? 'Demo Workspace' : 'Cloud Firestore'}
          </p>
        </div>
        <p className="px-1 text-[10px] text-[#A9B8CA]/75 truncate">
          TEAM ADIT · Akshit Patel &amp; Shah Darshil
        </p>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#071426] text-[#F5F8FC] flex">
      {/* Desktop persistent left sidebar */}
      <aside className="hidden lg:block w-64 shrink-0 sticky top-0 h-screen">
        {sidebarContent}
      </aside>

      {/* Mobile collapsible navigation drawer */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-40 lg:hidden flex">
          <div
            className="fixed inset-0 bg-black/65"
            onClick={() => setMobileNavOpen(false)}
            aria-hidden="true"
          />
          <aside className="relative z-10 w-72 max-w-[85vw] h-full">
            {sidebarContent}
          </aside>
        </div>
      )}

      {/* Main viewport column */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="sticky top-0 z-30 h-16 bg-[#0D1F35]/95 backdrop-blur border-b border-[#233B56] px-3 sm:px-4 lg:px-6 flex items-center justify-between gap-2 sm:gap-4">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              aria-label="Open navigation menu"
              className="lg:hidden p-2 text-[#A9B8CA] hover:text-[#F5F8FC] rounded-md border border-[#233B56] bg-[#122943] shrink-0"
            >
              <Menu className="w-5 h-5" />
            </button>

            <span className="hidden sm:inline lg:hidden font-bold tracking-tight text-sm text-[#F5F8FC] whitespace-nowrap shrink-0">
              ROADSHADOW
            </span>

            {/* Current Project Switcher */}
            <div className="flex items-center gap-2 min-w-0 flex-1 sm:flex-initial">
              <label htmlFor="header-project-select" className="sr-only">
                Active project
              </label>
              <select
                id="header-project-select"
                value={selectedProjectId}
                onChange={(e) => setSelectedProjectId(e.target.value)}
                className="bg-[#122943] border border-[#233B56] text-[#F5F8FC] text-xs sm:text-sm rounded-md px-2.5 sm:px-3 py-1.5 w-full max-w-[190px] sm:max-w-[260px] truncate focus:outline-none focus:ring-2 focus:ring-[#2585FF]"
              >
                <option value="ALL">All Active Projects ({projects.length})</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.status === 'archived' ? ' (Archived)' : ''}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Search & Header Utility Controls */}
          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <div className="relative hidden md:block w-56 lg:w-72">
              <Search
                className="w-4 h-4 text-[#A9B8CA] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                aria-hidden="true"
              />
              <input
                type="search"
                value={globalSearch}
                onChange={(e) => setGlobalSearch(e.target.value)}
                placeholder="Search locations, events, videos..."
                aria-label="Global workspace search"
                className="w-full bg-[#071426] border border-[#233B56] rounded-md pl-9 pr-3 py-1.5 text-sm text-[#F5F8FC] placeholder:text-[#A9B8CA]/70 focus:outline-none focus:ring-2 focus:ring-[#2585FF]"
              />
            </div>

            <button
              type="button"
              onClick={() => navigate('/notifications')}
              aria-label={`Notifications (${unreadCount} unread)`}
              className="relative p-2 text-[#A9B8CA] hover:text-[#F5F8FC] bg-[#122943] border border-[#233B56] rounded-md transition-colors"
            >
              <Bell className="w-4 h-4" />
              {unreadCount > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 text-[10px] font-mono tabular-nums font-semibold bg-[#E5484D] text-white rounded flex items-center justify-center">
                  {unreadCount}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => navigate('/help')}
              aria-label="Help and documentation"
              className="hidden sm:inline-flex p-2 text-[#A9B8CA] hover:text-[#F5F8FC] bg-[#122943] border border-[#233B56] rounded-md transition-colors"
            >
              <HelpCircle className="w-4 h-4" />
            </button>

            <button
              type="button"
              onClick={() => navigate('/settings')}
              aria-label="Workspace settings"
              className="hidden sm:inline-flex p-2 text-[#A9B8CA] hover:text-[#F5F8FC] bg-[#122943] border border-[#233B56] rounded-md transition-colors"
            >
              <Settings className="w-4 h-4" />
            </button>

            {/* User profile menu */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setProfileMenuOpen((v) => !v)}
                aria-expanded={profileMenuOpen}
                aria-label="User account menu"
                className="flex items-center gap-2 pl-1.5 pr-2.5 py-1 bg-[#122943] border border-[#233B56] rounded-md hover:border-[#2585FF]/60 transition-colors"
              >
                <img
                  src={currentUser?.photoURL || DEMO_IMAGES.avatar}
                  alt={currentUser?.displayName || 'Account avatar'}
                  referrerPolicy="no-referrer"
                  className="w-7 h-7 rounded object-cover bg-[#071426]"
                />
                <span className="hidden xl:inline text-xs font-medium text-[#F5F8FC] max-w-[120px] truncate">
                  {currentUser?.displayName || 'Account'}
                </span>
              </button>

              {profileMenuOpen && (
                <div className="absolute right-0 mt-2 w-60 bg-[#122943] border border-[#233B56] rounded-lg shadow-xl py-1.5 z-50">
                  <div className="px-3.5 py-2 border-b border-[#233B56]">
                    <p className="text-sm font-medium text-[#F5F8FC] truncate">
                      {currentUser?.displayName}
                    </p>
                    <p className="text-xs text-[#A9B8CA] truncate">{currentUser?.email}</p>
                    <p className="text-[11px] font-mono text-[#45B5FF] mt-1">
                      Role: {currentUser?.role}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setProfileMenuOpen(false);
                      navigate('/settings');
                    }}
                    className="w-full text-left px-3.5 py-2 text-sm text-[#F5F8FC] hover:bg-[#0D1F35] flex items-center gap-2"
                  >
                    <Settings className="w-4 h-4 text-[#A9B8CA]" />
                    Profile &amp; Settings
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setProfileMenuOpen(false);
                      navigate('/demo');
                    }}
                    className="w-full text-left px-3.5 py-2 text-sm text-[#F5F8FC] hover:bg-[#0D1F35] flex items-center gap-2"
                  >
                    <PlaySquare className="w-4 h-4 text-[#A9B8CA]" />
                    Demonstration Mode
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setProfileMenuOpen(false);
                      void logout();
                    }}
                    className="w-full text-left px-3.5 py-2 text-sm text-[#E5484D] hover:bg-[#0D1F35] flex items-center gap-2 border-t border-[#233B56] mt-1"
                  >
                    <LogOut className="w-4 h-4" />
                    {isDemoMode ? 'Exit Demonstration Mode' : 'Sign Out'}
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-[1600px] w-full mx-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
