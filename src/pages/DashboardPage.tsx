import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AlertOctagon,
  AlertTriangle,
  ArrowRight,
  Clock,
  FileText,
  Fingerprint,
  Info,
  MapPin,
  ShieldCheck,
  Upload,
  Users,
  Video,
} from 'lucide-react';
import { useRoadshadow } from '../context/RoadshadowContext';
import { getRiskColorHex, RiskIndicator } from '../components/RiskBadge';
import { buildConflictFingerprints } from '../engine/conflictFingerprint';
import type { RiskCategory } from '../types/roadshadow';

type TrendGranularity = 'daily' | 'weekly' | 'monthly';

export function DashboardPage() {
  const {
    selectedProjectId,
    globalSearch,
    isDemoMode,
    videos,
    conflictEvents,
    locations,
    processingJobs,
    reports,
    projects,
  } = useRoadshadow();
  const navigate = useNavigate();

  const [dateRangeDays, setDateRangeDays] = useState<'all' | '7' | '14' | '30'>('all');
  const [trendView, setTrendView] = useState<TrendGranularity>('daily');

  const scopedVideos = useMemo(
    () =>
      videos.filter((v) =>
        selectedProjectId === 'ALL' ? true : v.projectId === selectedProjectId
      ),
    [videos, selectedProjectId]
  );

  const scopedLocations = useMemo(
    () =>
      locations.filter((l) =>
        selectedProjectId === 'ALL' ? true : l.projectId === selectedProjectId
      ),
    [locations, selectedProjectId]
  );

  const scopedJobs = useMemo(
    () =>
      processingJobs.filter((j) =>
        selectedProjectId === 'ALL' ? true : j.projectId === selectedProjectId
      ),
    [processingJobs, selectedProjectId]
  );

  const scopedReports = useMemo(
    () =>
      reports.filter((r) =>
        selectedProjectId === 'ALL' ? true : r.projectId === selectedProjectId
      ),
    [reports, selectedProjectId]
  );

  const scopedEvents = useMemo(() => {
    const q = globalSearch.trim().toLowerCase();
    const nowMs = Date.now();
    const maxAgeMs =
      dateRangeDays === 'all' ? Infinity : Number(dateRangeDays) * 24 * 60 * 60 * 1000;

    return conflictEvents.filter((ev) => {
      if (selectedProjectId !== 'ALL' && ev.projectId !== selectedProjectId) return false;
      if (maxAgeMs !== Infinity) {
        const t = new Date(ev.occurredAt).getTime();
        if (!Number.isNaN(t) && Math.abs(nowMs - t) > maxAgeMs) return false;
      }
      if (q) {
        const locName = locations.find((l) => l.id === ev.locationId)?.name.toLowerCase() ?? '';
        const match =
          ev.conflictType.toLowerCase().includes(q) ||
          ev.evidenceSummary.toLowerCase().includes(q) ||
          locName.includes(q);
        if (!match) return false;
      }
      return true;
    });
  }, [conflictEvents, selectedProjectId, dateRangeDays, globalSearch, locations]);

  // KPI calculations strictly from real database/active workspace records
  const fingerprints = useMemo(
    () => buildConflictFingerprints(scopedEvents, scopedLocations),
    [scopedEvents, scopedLocations]
  );

  const kpis = useMemo(() => {
    const nonFalse = scopedEvents.filter((e) => e.validationStatus !== 'False positive');
    const trackedFromVideos = scopedVideos.reduce(
      (sum, v) => sum + (v.trajectories?.length ?? 0),
      0
    );
    const completedJobs = scopedJobs.filter((j) => j.status === 'Completed');
    const trackedFromJobs = completedJobs.reduce((sum, j) => sum + (j.trackingCount ?? 0), 0);
    const timedJobs = completedJobs.filter((j) => (j.processingTimeMs ?? 0) > 0);
    const avgProcessingSec =
      timedJobs.length > 0
        ? Number(
            (
              timedJobs.reduce((sum, j) => sum + j.processingTimeMs, 0) /
              timedJobs.length /
              1000
            ).toFixed(1)
          )
        : null;

    return {
      totalVideos: scopedVideos.filter((v) => v.status === 'Completed').length,
      totalStoredVideos: scopedVideos.length,
      totalEvents: nonFalse.length,
      critical: nonFalse.filter((e) => e.riskCategory === 'Critical').length,
      high: nonFalse.filter((e) => e.riskCategory === 'High').length,
      medium: nonFalse.filter((e) => e.riskCategory === 'Medium').length,
      low: nonFalse.filter((e) => e.riskCategory === 'Low').length,
      activeLocations: scopedLocations.length,
      pendingReviews: scopedEvents.filter((e) => e.validationStatus === 'Pending review').length,
      trackedRoadUsers: Math.max(trackedFromVideos, trackedFromJobs),
      fingerprintCount: fingerprints.length,
      avgProcessingSec,
    };
  }, [scopedEvents, scopedVideos, scopedLocations, scopedJobs, fingerprints]);

  // Vehicle & Road-User Category Distribution across tracked trajectories & events
  const vehicleCategoryData = useMemo(() => {
    const labels: Record<string, string> = {
      car: 'Cars',
      motorcycle: 'Motorcycles',
      scooter: 'Scooters',
      auto_rickshaw: 'Auto-Rickshaws',
      bus: 'Buses',
      truck: 'Trucks',
      bicycle: 'Bicycles',
      person: 'Pedestrians',
      other_vehicle: 'Other',
    };
    const counts = new Map<string, number>();
    for (const v of scopedVideos) {
      for (const traj of v.trajectories || []) {
        counts.set(traj.objectClass, (counts.get(traj.objectClass) ?? 0) + 1);
      }
    }
    if (counts.size === 0) {
      for (const ev of scopedEvents) {
        for (const u of ev.roadUsers) {
          counts.set(u, (counts.get(u) ?? 0) + 1);
        }
      }
    }
    return Array.from(counts.entries())
      .map(([cls, count]) => ({
        category: labels[cls] || cls,
        count,
      }))
      .sort((a, b) => b.count - a.count);
  }, [scopedVideos, scopedEvents]);

  // 1, 2, 3. Daily / Weekly / Monthly conflict trend
  const trendData = useMemo(() => {
    const map = new Map<string, number>();
    for (const ev of scopedEvents) {
      const d = new Date(ev.occurredAt);
      if (Number.isNaN(d.getTime())) continue;
      let key = '';
      if (trendView === 'daily') {
        key = d.toISOString().slice(5, 10); // MM-DD
      } else if (trendView === 'weekly') {
        const weekNum = Math.ceil(d.getDate() / 7);
        key = `${d.toLocaleString('en-US', { month: 'short' })} W${weekNum}`;
      } else {
        key = d.toLocaleString('en-US', { month: 'short', year: '2-digit' });
      }
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, events]) => ({ label, events }));
  }, [scopedEvents, trendView]);

  // 4. Risk category distribution
  const riskDistData = useMemo(
    () =>
      (['Critical', 'High', 'Medium', 'Low'] as RiskCategory[]).map((cat) => ({
        name: cat,
        value: scopedEvents.filter((e) => e.riskCategory === cat).length,
        color: getRiskColorHex(cat),
      })),
    [scopedEvents]
  );

  // 5. Conflict type distribution
  const conflictTypeData = useMemo(() => {
    const counts = new Map<string, number>();
    for (const ev of scopedEvents) {
      counts.set(ev.conflictType, (counts.get(ev.conflictType) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([type, count]) => ({
        type: type.length > 24 ? `${type.slice(0, 22)}…` : type,
        fullType: type,
        count,
      }))
      .sort((a, b) => b.count - a.count);
  }, [scopedEvents]);

  // 6. Road-user interaction distribution
  const roadUserData = useMemo(() => {
    const counts = new Map<string, number>();
    for (const ev of scopedEvents) {
      const combo = [...new Set(ev.roadUsers)]
        .sort()
        .map((u) => u.replace('_', ' '))
        .join(' + ');
      counts.set(combo, (counts.get(combo) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([combo, count]) => ({ combo, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);
  }, [scopedEvents]);

  // 7. Location comparison & High-risk locations table
  const locationSummary = useMemo(() => {
    const map = new Map<
      string,
      {
        locationId: string;
        name: string;
        city: string;
        count: number;
        highestRisk: RiskCategory;
        dominantConflict: string;
        lastAnalyzed: string;
        typeCounts: Record<string, number>;
      }
    >();

    const riskRank: Record<RiskCategory, number> = {
      Low: 1,
      Medium: 2,
      High: 3,
      Critical: 4,
    };

    for (const loc of scopedLocations) {
      map.set(loc.id, {
        locationId: loc.id,
        name: loc.name,
        city: loc.city,
        count: 0,
        highestRisk: 'Low',
        dominantConflict: 'None recorded',
        lastAnalyzed: loc.updatedAt,
        typeCounts: {},
      });
    }

    for (const ev of scopedEvents) {
      const row = map.get(ev.locationId);
      if (!row) continue;
      row.count += 1;
      if (riskRank[ev.riskCategory] > riskRank[row.highestRisk]) {
        row.highestRisk = ev.riskCategory;
      }
      row.typeCounts[ev.conflictType] = (row.typeCounts[ev.conflictType] ?? 0) + 1;
      if (ev.occurredAt > row.lastAnalyzed) row.lastAnalyzed = ev.occurredAt;
    }

    return Array.from(map.values())
      .map((row) => {
        const sortedTypes = Object.entries(row.typeCounts).sort((a, b) => b[1] - a[1]);
        return {
          ...row,
          dominantConflict: sortedTypes[0]?.[0] ?? 'No conflicts recorded',
          shortName: row.name.length > 20 ? `${row.name.slice(0, 18)}…` : row.name,
        };
      })
      .sort((a, b) => b.count - a.count);
  }, [scopedLocations, scopedEvents]);

  // 8. Time-of-day analysis
  const timeOfDayData = useMemo(() => {
    const slots = [
      { label: '06–09', min: 6, max: 9, count: 0 },
      { label: '09–12', min: 9, max: 12, count: 0 },
      { label: '12–15', min: 12, max: 15, count: 0 },
      { label: '15–18', min: 15, max: 18, count: 0 },
      { label: '18–21', min: 18, max: 21, count: 0 },
      { label: '21–06', min: 21, max: 24, count: 0 },
    ];
    for (const ev of scopedEvents) {
      const h = new Date(ev.occurredAt).getHours();
      if (Number.isNaN(h)) continue;
      const slot =
        slots.find((s) => h >= s.min && h < s.max) ?? slots[slots.length - 1];
      slot.count += 1;
    }
    return slots;
  }, [scopedEvents]);

  const activeProjectName =
    selectedProjectId === 'ALL'
      ? 'All Active Projects'
      : projects.find((p) => p.id === selectedProjectId)?.name || 'Selected Project';

  // Empty State when there is no actual data in live workspace
  if (scopedVideos.length === 0 && scopedEvents.length === 0) {
    return (
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-[#F5F8FC]">Safety Intelligence Dashboard</h1>
            <p className="text-sm text-[#A9B8CA] mt-1">
              {activeProjectName} · No analysed footage recorded yet
            </p>
          </div>
          <button
            type="button"
            onClick={() => navigate('/upload')}
            className="inline-flex items-center gap-2 px-4 py-2 bg-[#2585FF] hover:bg-[#1C74E8] text-white text-sm font-medium rounded-md transition-colors whitespace-nowrap shrink-0"
          >
            <Upload className="w-4 h-4" />
            Upload First Video
          </button>
        </div>

        <div className="bg-[#122943] border border-[#233B56] rounded-lg p-10 text-center max-w-2xl mx-auto">
          <div className="w-12 h-12 rounded-lg bg-[#0D1F35] border border-[#233B56] flex items-center justify-center mx-auto text-[#45B5FF]">
            <Video className="w-6 h-6" />
          </div>
          <h2 className="text-lg font-semibold text-[#F5F8FC] mt-4">
            No Traffic Videos Analysed Yet
          </h2>
          <p className="text-sm text-[#A9B8CA] mt-2 leading-relaxed max-w-lg mx-auto">
            ROADSHADOW never displays fabricated totals as live data. Start by creating a project and road location, uploading your first MP4/MOV/WebM traffic clip, or switching to Demonstration Mode to inspect the Anand pilot dataset.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => navigate('/upload')}
              className="inline-flex items-center gap-2 px-4 py-2 bg-[#2585FF] hover:bg-[#1C74E8] text-white text-sm font-medium rounded-md transition-colors"
            >
              <Upload className="w-4 h-4" />
              Upload Traffic Footage
            </button>
            <button
              type="button"
              onClick={() => navigate('/locations')}
              className="inline-flex items-center gap-2 px-4 py-2 bg-[#0D1F35] hover:bg-[#173252] border border-[#233B56] text-[#F5F8FC] text-sm font-medium rounded-md transition-colors"
            >
              <MapPin className="w-4 h-4" />
              Register Road Location
            </button>
            <button
              type="button"
              onClick={() => navigate('/demo')}
              className="inline-flex items-center gap-2 px-4 py-2 bg-[#0D1F35] hover:bg-[#173252] border border-[#2585FF]/40 text-[#45B5FF] text-sm font-medium rounded-md transition-colors"
            >
              Open Demonstration Mode
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page Title + Date Filter Controls */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[#F5F8FC]">Safety Intelligence Dashboard</h1>
          <p className="text-sm text-[#A9B8CA] mt-1">
            {activeProjectName}
            <span aria-hidden="true"> · </span>
            <span>{isDemoMode ? 'Demonstration Dataset (Anand Pilot)' : 'Live Cloud Firestore Records'}</span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label="Date range filter"
            className="inline-flex items-center bg-[#0D1F35] border border-[#233B56] rounded-md p-0.5"
          >
            {(
              [
                { id: 'all', label: 'All Dates' },
                { id: '30', label: '30 Days' },
                { id: '14', label: '14 Days' },
                { id: '7', label: '7 Days' },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setDateRangeDays(opt.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                  dateRangeDays === opt.id
                    ? 'bg-[#2585FF] text-white'
                    : 'text-[#A9B8CA] hover:text-[#F5F8FC]'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => navigate('/upload')}
            className="inline-flex items-center gap-2 px-4 py-2 bg-[#2585FF] hover:bg-[#1C74E8] text-white text-xs sm:text-sm font-medium rounded-md transition-colors whitespace-nowrap shrink-0"
          >
            <Upload className="w-4 h-4" />
            Upload Video
          </button>
        </div>
      </div>

      {/* 6.1 Summary KPI Grid (10 real operational metrics) */}
      <section aria-label="Key safety metrics" className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        <div className="bg-[#122943] border border-[#233B56] rounded-lg p-4">
          <div className="flex items-center justify-between text-xs text-[#A9B8CA]">
            <span>Videos Analysed</span>
            <Video className="w-4 h-4 text-[#45B5FF]" aria-hidden="true" />
          </div>
          <p className="text-2xl font-bold font-mono tabular-nums text-[#F5F8FC] mt-2">
            {kpis.totalVideos}
          </p>
          <p className="text-[11px] font-mono text-[#A9B8CA] mt-0.5">
            {kpis.totalStoredVideos} stored ·{' '}
            {kpis.avgProcessingSec !== null ? `avg ${kpis.avgProcessingSec}s` : 'avg N/A'}
          </p>
        </div>

        <div className="bg-[#122943] border border-[#233B56] rounded-lg p-4">
          <div className="flex items-center justify-between text-xs text-[#A9B8CA]">
            <span>Tracked Road Users</span>
            <Users className="w-4 h-4 text-[#45B5FF]" aria-hidden="true" />
          </div>
          <p className="text-2xl font-bold font-mono tabular-nums text-[#F5F8FC] mt-2">
            {kpis.trackedRoadUsers}
          </p>
        </div>

        <div className="bg-[#122943] border border-[#233B56] rounded-lg p-4">
          <div className="flex items-center justify-between text-xs text-[#A9B8CA]">
            <span>Conflict Events</span>
            <AlertTriangle className="w-4 h-4 text-[#45B5FF]" aria-hidden="true" />
          </div>
          <p className="text-2xl font-bold font-mono tabular-nums text-[#F5F8FC] mt-2">
            {kpis.totalEvents}
          </p>
        </div>

        <div className="bg-[#122943] border border-[#233B56] rounded-lg p-4">
          <div className="flex items-center justify-between text-xs text-[#A9B8CA]">
            <span>Conflict Fingerprints</span>
            <Fingerprint className="w-4 h-4 text-[#45B5FF]" aria-hidden="true" />
          </div>
          <p className="text-2xl font-bold font-mono tabular-nums text-[#F5F8FC] mt-2">
            {kpis.fingerprintCount}
          </p>
        </div>

        <div className="bg-[#122943] border border-[#233B56] rounded-lg p-4">
          <div className="flex items-center justify-between text-xs text-[#E5484D]">
            <span>Critical Risk</span>
            <AlertOctagon className="w-4 h-4" aria-hidden="true" />
          </div>
          <p className="text-2xl font-bold font-mono tabular-nums text-[#F5F8FC] mt-2">
            {kpis.critical}
          </p>
        </div>

        <div className="bg-[#122943] border border-[#233B56] rounded-lg p-4">
          <div className="flex items-center justify-between text-xs text-[#F97316]">
            <span>High Risk</span>
            <AlertTriangle className="w-4 h-4" aria-hidden="true" />
          </div>
          <p className="text-2xl font-bold font-mono tabular-nums text-[#F5F8FC] mt-2">
            {kpis.high}
          </p>
        </div>

        <div className="bg-[#122943] border border-[#233B56] rounded-lg p-4">
          <div className="flex items-center justify-between text-xs text-[#EAB308]">
            <span>Medium Risk</span>
            <Info className="w-4 h-4" aria-hidden="true" />
          </div>
          <p className="text-2xl font-bold font-mono tabular-nums text-[#F5F8FC] mt-2">
            {kpis.medium}
          </p>
        </div>

        <div className="bg-[#122943] border border-[#233B56] rounded-lg p-4">
          <div className="flex items-center justify-between text-xs text-[#22C55E]">
            <span>Low Risk</span>
            <ShieldCheck className="w-4 h-4" aria-hidden="true" />
          </div>
          <p className="text-2xl font-bold font-mono tabular-nums text-[#F5F8FC] mt-2">
            {kpis.low}
          </p>
        </div>

        <div className="bg-[#122943] border border-[#233B56] rounded-lg p-4">
          <div className="flex items-center justify-between text-xs text-[#A9B8CA]">
            <span>Monitored Sites</span>
            <MapPin className="w-4 h-4 text-[#45B5FF]" aria-hidden="true" />
          </div>
          <p className="text-2xl font-bold font-mono tabular-nums text-[#F5F8FC] mt-2">
            {kpis.activeLocations}
          </p>
        </div>

        <div className="bg-[#122943] border border-[#233B56] rounded-lg p-4">
          <div className="flex items-center justify-between text-xs text-[#A9B8CA]">
            <span>Pending Reviews</span>
            <Clock className="w-4 h-4 text-[#EAB308]" aria-hidden="true" />
          </div>
          <p className="text-2xl font-bold font-mono tabular-nums text-[#F5F8FC] mt-2">
            {kpis.pendingReviews}
          </p>
        </div>
      </section>

      {/* 6.2 Charts Section — Row 1: Trend (Daily/Weekly/Monthly) + Risk Category Distribution */}
      <section className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2 bg-[#122943] border border-[#233B56] rounded-lg p-5">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div>
              <h2 className="text-base font-semibold text-[#F5F8FC]">Conflict Event Trend</h2>
              <p className="text-xs text-[#A9B8CA]">
                Switch between daily, weekly, and monthly observed conflict counts
              </p>
            </div>
            <div
              role="group"
              aria-label="Trend granularity"
              className="inline-flex bg-[#0D1F35] border border-[#233B56] rounded-md p-0.5"
            >
              {(['daily', 'weekly', 'monthly'] as const).map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => setTrendView(g)}
                  className={`px-2.5 py-1 text-xs font-medium rounded capitalize transition-colors ${
                    trendView === g
                      ? 'bg-[#2585FF] text-white'
                      : 'text-[#A9B8CA] hover:text-[#F5F8FC]'
                  }`}
                >
                  {g}
                </button>
              ))}
            </div>
          </div>

          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trendData} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#233B56" />
                <XAxis dataKey="label" stroke="#A9B8CA" fontSize={12} />
                <YAxis allowDecimals={false} stroke="#A9B8CA" fontSize={12} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0D1F35',
                    borderColor: '#233B56',
                    color: '#F5F8FC',
                    fontSize: '12px',
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="events"
                  name="Potential Conflicts"
                  stroke="#2585FF"
                  fill="#2585FF"
                  fillOpacity={0.2}
                  strokeWidth={2}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-[#122943] border border-[#233B56] rounded-lg p-5 flex flex-col">
          <div>
            <h2 className="text-base font-semibold text-[#F5F8FC]">Risk Category Distribution</h2>
            <p className="text-xs text-[#A9B8CA]">
              Provisional risk bands (not accident probability)
            </p>
          </div>

          <div className="h-52 w-full mt-2">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={riskDistData}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={48}
                  outerRadius={78}
                  paddingAngle={2}
                  isAnimationActive={false}
                >
                  {riskDistData.map((entry) => (
                    <Cell key={entry.name} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0D1F35',
                    borderColor: '#233B56',
                    color: '#F5F8FC',
                    fontSize: '12px',
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>

          <div className="grid grid-cols-2 gap-2 mt-auto pt-2 border-t border-[#233B56]">
            {riskDistData.map((item) => (
              <div key={item.name} className="flex items-center justify-between text-xs">
                <RiskIndicator category={item.name as RiskCategory} compact />
                <span className="font-mono tabular-nums text-[#F5F8FC]">{item.value}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 6.2 Charts Section — Row 2: Conflict Types, Road-User Interactions, Location Comparison, Time-of-Day */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[#122943] border border-[#233B56] rounded-lg p-5">
          <h2 className="text-base font-semibold text-[#F5F8FC]">Conflict Type Distribution</h2>
          <p className="text-xs text-[#A9B8CA] mb-4">
            Frequency by detected interaction classification
          </p>
          <div className="h-60 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={conflictTypeData}
                layout="vertical"
                margin={{ top: 4, right: 16, left: 8, bottom: 4 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#233B56" horizontal={false} />
                <XAxis type="number" allowDecimals={false} stroke="#A9B8CA" fontSize={12} />
                <YAxis type="category" dataKey="type" stroke="#A9B8CA" fontSize={11} width={168} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0D1F35',
                    borderColor: '#233B56',
                    color: '#F5F8FC',
                    fontSize: '12px',
                  }}
                />
                <Bar dataKey="count" name="Events" fill="#2585FF" radius={[0, 4, 4, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-[#122943] border border-[#233B56] rounded-lg p-5">
          <h2 className="text-base font-semibold text-[#F5F8FC]">Road-User Interaction Distribution</h2>
          <p className="text-xs text-[#A9B8CA] mb-4">
            Primary road-user pairings involved in candidate near-misses
          </p>
          <div className="h-60 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={roadUserData} margin={{ top: 4, right: 12, left: -16, bottom: 16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#233B56" />
                <XAxis dataKey="combo" stroke="#A9B8CA" fontSize={11} interval={0} angle={-12} textAnchor="end" />
                <YAxis allowDecimals={false} stroke="#A9B8CA" fontSize={12} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0D1F35',
                    borderColor: '#233B56',
                    color: '#F5F8FC',
                    fontSize: '12px',
                  }}
                />
                <Bar dataKey="count" name="Interactions" fill="#45B5FF" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-[#122943] border border-[#233B56] rounded-lg p-5">
          <h2 className="text-base font-semibold text-[#F5F8FC]">Location Comparison</h2>
          <p className="text-xs text-[#A9B8CA] mb-4">
            Observed candidate conflict count across monitored sites
          </p>
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={locationSummary} margin={{ top: 4, right: 12, left: -16, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#233B56" />
                <XAxis dataKey="shortName" stroke="#A9B8CA" fontSize={11} />
                <YAxis allowDecimals={false} stroke="#A9B8CA" fontSize={12} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0D1F35',
                    borderColor: '#233B56',
                    color: '#F5F8FC',
                    fontSize: '12px',
                  }}
                />
                <Bar dataKey="count" name="Events" fill="#F97316" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-[#122943] border border-[#233B56] rounded-lg p-5">
          <h2 className="text-base font-semibold text-[#F5F8FC]">Time-of-Day Analysis</h2>
          <p className="text-xs text-[#A9B8CA] mb-4">
            Conflict concentration across 3-hour urban traffic periods
          </p>
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={timeOfDayData} margin={{ top: 4, right: 12, left: -16, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#233B56" />
                <XAxis dataKey="label" stroke="#A9B8CA" fontSize={12} />
                <YAxis allowDecimals={false} stroke="#A9B8CA" fontSize={12} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0D1F35',
                    borderColor: '#233B56',
                    color: '#F5F8FC',
                    fontSize: '12px',
                  }}
                />
                <Bar dataKey="count" name="Events" fill="#2585FF" radius={[4, 4, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>

      {/* Road-User & Vehicle Category Distribution + Video Evidence Thumbnails */}
      <section className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        <div className="xl:col-span-5 bg-[#122943] border border-[#233B56] rounded-lg p-5">
          <h2 className="text-base font-semibold text-[#F5F8FC]">Vehicle &amp; Road-User Category Mix</h2>
          <p className="text-xs text-[#A9B8CA] mb-4">
            Tracked road-user classes across analysed clips (Indian mixed-traffic taxonomy)
          </p>
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={vehicleCategoryData} margin={{ top: 4, right: 12, left: -16, bottom: 16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#233B56" />
                <XAxis dataKey="category" stroke="#A9B8CA" fontSize={11} interval={0} angle={-15} textAnchor="end" />
                <YAxis allowDecimals={false} stroke="#A9B8CA" fontSize={12} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0D1F35',
                    borderColor: '#233B56',
                    color: '#F5F8FC',
                    fontSize: '12px',
                  }}
                />
                <Bar dataKey="count" name="Tracked Count" fill="#22C55E" radius={[4, 4, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="xl:col-span-7 bg-[#122943] border border-[#233B56] rounded-lg p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold text-[#F5F8FC]">Video Evidence Thumbnails</h2>
              <p className="text-xs text-[#A9B8CA]">
                Open any analysed video clip to inspect bounding boxes, trajectories, and PET/TTC metrics
              </p>
            </div>
            <button
              type="button"
              onClick={() => navigate('/video-analysis')}
              className="text-xs font-medium text-[#45B5FF] hover:underline whitespace-nowrap"
            >
              Video Analysis
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {scopedVideos.slice(0, 6).map((vid) => {
              const vidEventCount = scopedEvents.filter((e) => e.videoId === vid.id).length;
              return (
                <button
                  key={vid.id}
                  type="button"
                  onClick={() => navigate(`/video-analysis/${vid.id}`)}
                  className="text-left rounded-md overflow-hidden bg-[#0D1F35] border border-[#233B56] hover:border-[#2585FF] transition-colors group"
                >
                  <div className="relative aspect-[16/9] bg-[#071426] overflow-hidden">
                    {vid.posterUrl ? (
                      <img
                        src={vid.posterUrl}
                        alt={vid.title}
                        referrerPolicy="no-referrer"
                        className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-[#45B5FF]">
                        <Video className="w-6 h-6" />
                      </div>
                    )}
                    <span className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded bg-[#071426]/85 text-[10px] font-mono tabular-nums text-[#F5F8FC]">
                      {vid.durationSec}s · {vid.status === 'Failed' ? 'CV Failed' : `${vidEventCount} ev`}
                    </span>
                  </div>
                  <div className="p-2.5">
                    <p className="text-xs font-medium text-[#F5F8FC] truncate">{vid.title}</p>
                    <p className="text-[11px] font-mono text-[#A9B8CA] mt-0.5">
                      {vid.recordingDate} · {vid.recordingTime}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* 6.4 High-Risk Locations Table + 6.3 Recent Activity */}
      <section className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2 bg-[#122943] border border-[#233B56] rounded-lg overflow-hidden">
          <div className="p-5 border-b border-[#233B56] flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-[#F5F8FC]">Monitored High-Risk Locations</h2>
              <p className="text-xs text-[#A9B8CA]">
                Select any road location to inspect site coordinates, cameras, and conflict evidence
              </p>
            </div>
            <button
              type="button"
              onClick={() => navigate('/risk-map')}
              className="text-xs font-medium text-[#45B5FF] hover:underline whitespace-nowrap"
            >
              Open Risk Map
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#233B56] bg-[#0D1F35] text-xs text-[#A9B8CA]">
                  <th className="py-3 px-4 font-medium">Location</th>
                  <th className="py-3 px-4 font-medium text-right">Events</th>
                  <th className="py-3 px-4 font-medium">Dominant Conflict</th>
                  <th className="py-3 px-4 font-medium">Peak Risk</th>
                  <th className="py-3 px-4 font-medium">Last Analysed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#233B56] text-sm">
                {locationSummary.map((loc) => (
                  <tr
                    key={loc.locationId}
                    className="hover:bg-[#0D1F35]/60 transition-colors"
                  >
                    <td className="py-3 px-4">
                      <button
                        type="button"
                        onClick={() => navigate(`/locations?selected=${loc.locationId}`)}
                        className="text-left font-medium text-[#F5F8FC] hover:text-[#45B5FF] transition-colors"
                      >
                        {loc.name}
                      </button>
                      <p className="text-xs text-[#A9B8CA]">{loc.city}</p>
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-[#F5F8FC]">
                      {loc.count}
                    </td>
                    <td className="py-3 px-4 text-xs text-[#A9B8CA]">{loc.dominantConflict}</td>
                    <td className="py-3 px-4">
                      <RiskIndicator category={loc.highestRisk} compact />
                    </td>
                    <td className="py-3 px-4 text-xs font-mono tabular-nums text-[#A9B8CA] whitespace-nowrap">
                      {loc.lastAnalyzed.slice(0, 10)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* 6.3 Recent Activity */}
        <div className="bg-[#122943] border border-[#233B56] rounded-lg p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-[#F5F8FC]">Recent Activity</h2>
            <button
              type="button"
              onClick={() => navigate('/events')}
              className="text-xs font-medium text-[#45B5FF] hover:underline"
            >
              All Events
            </button>
          </div>

          <div className="space-y-3">
            {scopedJobs.slice(0, 2).map((job) => {
              const vid = scopedVideos.find((v) => v.id === job.videoId);
              return (
                <button
                  key={job.id}
                  type="button"
                  onClick={() => navigate(`/video-analysis/${job.videoId}`)}
                  className="w-full text-left p-3 rounded-md bg-[#0D1F35] border border-[#233B56] hover:border-[#2585FF]/60 transition-colors"
                >
                  <div className="flex items-center justify-between text-xs text-[#A9B8CA]">
                    <span>Video Processing · {job.status}</span>
                    <span className="font-mono tabular-nums">{job.conflictCount} events</span>
                  </div>
                  <p className="text-sm font-medium text-[#F5F8FC] mt-1 truncate">
                    {vid?.title || job.videoId}
                  </p>
                </button>
              );
            })}

            {scopedEvents.slice(0, 3).map((ev) => (
              <button
                key={ev.id}
                type="button"
                onClick={() => navigate(`/events?eventId=${ev.id}`)}
                className="w-full text-left p-3 rounded-md bg-[#0D1F35] border border-[#233B56] hover:border-[#2585FF]/60 transition-colors"
              >
                <div className="flex items-center justify-between gap-2">
                  <RiskIndicator category={ev.riskCategory} score={ev.riskScore} compact />
                  <span className="text-[11px] text-[#A9B8CA]">{ev.validationStatus}</span>
                </div>
                <p className="text-sm font-medium text-[#F5F8FC] mt-1 truncate">
                  {ev.conflictType}
                </p>
              </button>
            ))}

            {scopedReports.slice(0, 1).map((rep) => (
              <button
                key={rep.id}
                type="button"
                onClick={() => navigate('/reports')}
                className="w-full text-left p-3 rounded-md bg-[#0D1F35] border border-[#233B56] hover:border-[#2585FF]/60 transition-colors flex items-center justify-between gap-2"
              >
                <div className="min-w-0">
                  <p className="text-xs text-[#A9B8CA] flex items-center gap-1.5">
                    <FileText className="w-3.5 h-3.5 text-[#45B5FF]" />
                    Recent Report
                  </p>
                  <p className="text-sm font-medium text-[#F5F8FC] truncate mt-0.5">
                    {rep.title}
                  </p>
                </div>
                <ArrowRight className="w-4 h-4 text-[#A9B8CA] shrink-0" />
              </button>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
