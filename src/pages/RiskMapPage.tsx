import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Layers, MapPin, Search } from 'lucide-react';
import { useRoadshadow } from '../context/RoadshadowContext';
import { getRiskColorHex, RiskIndicator } from '../components/RiskBadge';
import type { RiskCategory } from '../types/roadshadow';

const ALL_RISKS: RiskCategory[] = ['Critical', 'High', 'Medium', 'Low'];

export function RiskMapPage() {
  const { locations, conflictEvents, selectedProjectId } = useRoadshadow();
  const navigate = useNavigate();

  const [searchTerm, setSearchTerm] = useState('');
  const [dateDays, setDateDays] = useState<'all' | '7' | '14' | '30'>('all');
  const [selectedRisks, setSelectedRisks] = useState<RiskCategory[]>(ALL_RISKS);
  const [showHeatmap, setShowHeatmap] = useState(true);
  const [showClusters, setShowClusters] = useState(true);
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null);

  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerGroupRef = useRef<L.LayerGroup | null>(null);

  const scopedLocations = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    return locations.filter((loc) => {
      if (selectedProjectId !== 'ALL' && loc.projectId !== selectedProjectId) return false;
      if (
        q &&
        !loc.name.toLowerCase().includes(q) &&
        !loc.city.toLowerCase().includes(q) &&
        !loc.locationType.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [locations, selectedProjectId, searchTerm]);

  const filteredEvents = useMemo(() => {
    const nowMs = Date.now();
    const maxAgeMs =
      dateDays === 'all' ? Infinity : Number(dateDays) * 24 * 60 * 60 * 1000;
    const riskSet = new Set(selectedRisks);
    const locIdSet = new Set(scopedLocations.map((l) => l.id));

    return conflictEvents.filter((ev) => {
      if (ev.validationStatus === 'False positive') return false;
      if (!locIdSet.has(ev.locationId)) return false;
      if (!riskSet.has(ev.riskCategory)) return false;
      if (maxAgeMs !== Infinity) {
        const t = new Date(ev.occurredAt).getTime();
        if (!Number.isNaN(t) && Math.abs(nowMs - t) > maxAgeMs) return false;
      }
      return true;
    });
  }, [conflictEvents, scopedLocations, selectedRisks, dateDays]);

  const toggleRisk = (cat: RiskCategory) => {
    setSelectedRisks((prev) =>
      prev.includes(cat) ? prev.filter((r) => r !== cat) : [...prev, cat]
    );
  };

  // Initialize Leaflet Map once
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;
    const map = L.map(mapContainerRef.current, {
      center: [22.562, 72.928],
      zoom: 13,
      zoomControl: true,
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);
    layerGroupRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      layerGroupRef.current = null;
    };
  }, []);

  // Render location markers, conflict cluster markers, and risk density heat circles
  useEffect(() => {
    const map = mapRef.current;
    const group = layerGroupRef.current;
    if (!map || !group) return;
    group.clearLayers();

    const bounds: L.LatLngExpression[] = [];
    const riskRank: Record<RiskCategory, number> = {
      Low: 1,
      Medium: 2,
      High: 3,
      Critical: 4,
    };

    for (const loc of scopedLocations) {
      const locEvents = filteredEvents.filter((e) => e.locationId === loc.id);
      let topRisk: RiskCategory = 'Low';
      for (const ev of locEvents) {
        if (riskRank[ev.riskCategory] > riskRank[topRisk]) topRisk = ev.riskCategory;
      }
      const hex = locEvents.length > 0 ? getRiskColorHex(topRisk) : '#45B5FF';
      bounds.push([loc.latitude, loc.longitude]);

      // Heat density circle overlay
      if (showHeatmap && locEvents.length > 0) {
        L.circle([loc.latitude, loc.longitude], {
          radius: Math.min(480, 120 + locEvents.length * 45),
          color: hex,
          fillColor: hex,
          fillOpacity: 0.2,
          weight: 1,
        }).addTo(group);
      }

      // Clustered hotspot marker vs individual event markers
      if (showClusters) {
        const icon = L.divIcon({
          className: 'roadshadow-cluster-icon',
          html: `<div style="background:${hex};color:#071426;font-family:JetBrains Mono,monospace;font-weight:700;font-size:12px;width:32px;height:32px;border-radius:6px;border:2px solid #F5F8FC;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,0.45);">${locEvents.length}</div>`,
          iconSize: [32, 32],
          iconAnchor: [16, 16],
        });
        const marker = L.marker([loc.latitude, loc.longitude], { icon }).addTo(group);
        marker.on('click', () => setSelectedLocationId(loc.id));
        marker.bindTooltip(`${loc.name} (${locEvents.length} events)`, { direction: 'top' });
      } else {
        const marker = L.circleMarker([loc.latitude, loc.longitude], {
          radius: 8,
          color: '#F5F8FC',
          weight: 2,
          fillColor: hex,
          fillOpacity: 0.9,
        }).addTo(group);
        marker.on('click', () => setSelectedLocationId(loc.id));
        marker.bindTooltip(`${loc.name} · ${locEvents.length} events`, { direction: 'top' });

        // Plot slightly offset individual conflict event points around the site
        locEvents.forEach((ev, idx) => {
          const angle = (idx / Math.max(1, locEvents.length)) * Math.PI * 2;
          const offsetLat = loc.latitude + Math.sin(angle) * 0.0012;
          const offsetLng = loc.longitude + Math.cos(angle) * 0.0012;
          const evMarker = L.circleMarker([offsetLat, offsetLng], {
            radius: 5,
            color: '#071426',
            weight: 1,
            fillColor: getRiskColorHex(ev.riskCategory),
            fillOpacity: 0.95,
          }).addTo(group);
          evMarker.bindTooltip(
            `${ev.conflictType} (${ev.riskCategory} ${ev.riskScore}/100)`,
            { direction: 'top' }
          );
          evMarker.on('click', () => setSelectedLocationId(loc.id));
        });
      }
    }

    if (bounds.length > 0) {
      map.fitBounds(L.latLngBounds(bounds), { padding: [48, 48], maxZoom: 14 });
    }
  }, [scopedLocations, filteredEvents, showHeatmap, showClusters]);

  const activeLocation =
    scopedLocations.find((l) => l.id === selectedLocationId) ?? scopedLocations[0] ?? null;
  const activeLocationEvents = activeLocation
    ? filteredEvents.filter((e) => e.locationId === activeLocation.id)
    : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#F5F8FC]">Interactive Risk Map</h1>
        <p className="text-sm text-[#A9B8CA] mt-1">
          OpenStreetMap corridor visualization displaying monitored road locations, clustered conflict counts, and provisional risk density overlays.
        </p>
      </div>

      {/* Filter Bar */}
      <div className="bg-[#122943] border border-[#233B56] rounded-lg p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search className="w-4 h-4 text-[#A9B8CA] absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="search"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search locations or cities..."
            aria-label="Search map locations"
            className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md pl-9 pr-3 py-1.5 text-sm text-[#F5F8FC]"
          />
        </div>

        {/* Risk level toggles */}
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by risk level">
          {ALL_RISKS.map((cat) => {
            const active = selectedRisks.includes(cat);
            return (
              <button
                key={cat}
                type="button"
                onClick={() => toggleRisk(cat)}
                aria-pressed={active}
                className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors ${
                  active
                    ? 'bg-[#0D1F35] border-[#2585FF] text-[#F5F8FC]'
                    : 'bg-[#071426] border-[#233B56] text-[#A9B8CA] opacity-60'
                }`}
              >
                {cat}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Map date filter"
            value={dateDays}
            onChange={(e) => setDateDays(e.target.value as 'all' | '7' | '14' | '30')}
            className="bg-[#0D1F35] border border-[#233B56] rounded-md px-2.5 py-1.5 text-xs text-[#F5F8FC]"
          >
            <option value="all">All Dates</option>
            <option value="30">Last 30 Days</option>
            <option value="14">Last 14 Days</option>
            <option value="7">Last 7 Days</option>
          </select>

          <button
            type="button"
            onClick={() => setShowHeatmap((v) => !v)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md border ${
              showHeatmap
                ? 'bg-[#2585FF]/20 border-[#2585FF] text-[#F5F8FC]'
                : 'bg-[#0D1F35] border-[#233B56] text-[#A9B8CA]'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            Heatmap
          </button>

          <button
            type="button"
            onClick={() => setShowClusters((v) => !v)}
            className={`px-2.5 py-1.5 text-xs font-medium rounded-md border ${
              showClusters
                ? 'bg-[#2585FF]/20 border-[#2585FF] text-[#F5F8FC]'
                : 'bg-[#0D1F35] border-[#233B56] text-[#A9B8CA]'
            }`}
          >
            {showClusters ? 'Clustered' : 'Individual Pins'}
          </button>
        </div>
      </div>

      {/* Map + Selected Location Inspector */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        <div className="xl:col-span-8 bg-[#122943] border border-[#233B56] rounded-lg overflow-hidden">
          <div
            ref={mapContainerRef}
            data-testid="risk-map-canvas"
            className="h-[460px] w-full z-10 relative"
          />
          <div className="px-4 py-2.5 bg-[#0D1F35] border-t border-[#233B56] flex flex-wrap items-center justify-between gap-2 text-xs text-[#A9B8CA]">
            <span>
              Showing <strong className="font-mono text-[#F5F8FC]">{scopedLocations.length}</strong>{' '}
              locations and <strong className="font-mono text-[#F5F8FC]">{filteredEvents.length}</strong>{' '}
              matching conflict events
            </span>
            <div className="flex items-center gap-3">
              {ALL_RISKS.map((cat) => (
                <RiskIndicator key={cat} category={cat} compact />
              ))}
            </div>
          </div>
        </div>

        <div className="xl:col-span-4 bg-[#122943] border border-[#233B56] rounded-lg p-5 space-y-4">
          {activeLocation ? (
            <>
              <div>
                <div className="flex items-center gap-1.5 text-xs text-[#45B5FF]">
                  <MapPin className="w-3.5 h-3.5" />
                  <span>{activeLocation.locationType}</span>
                </div>
                <h2 className="text-lg font-semibold text-[#F5F8FC] mt-1">
                  {activeLocation.name}
                </h2>
                <p className="text-xs text-[#A9B8CA] mt-0.5">
                  {activeLocation.address}, {activeLocation.city}, {activeLocation.state}
                </p>
                <p className="text-xs font-mono tabular-nums text-[#A9B8CA] mt-1">
                  GPS: {activeLocation.latitude.toFixed(4)}, {activeLocation.longitude.toFixed(4)}
                </p>
              </div>

              <p className="text-xs text-[#A9B8CA] leading-relaxed">
                {activeLocation.description || 'No field notes documented.'}
              </p>

              <div className="pt-3 border-t border-[#233B56] space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold text-[#F5F8FC]">
                    Matching Conflict Events ({activeLocationEvents.length})
                  </h3>
                  <button
                    type="button"
                    onClick={() => navigate(`/locations?selected=${activeLocation.id}`)}
                    className="text-xs text-[#45B5FF] hover:underline"
                  >
                    Location Details
                  </button>
                </div>

                {activeLocationEvents.length === 0 ? (
                  <p className="text-xs text-[#A9B8CA]">
                    No events match the active risk/date filters for this location.
                  </p>
                ) : (
                  <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                    {activeLocationEvents.map((ev) => (
                      <button
                        key={ev.id}
                        type="button"
                        onClick={() => navigate(`/events?eventId=${ev.id}`)}
                        className="w-full text-left p-2.5 rounded-md bg-[#0D1F35] border border-[#233B56] hover:border-[#2585FF]/60"
                      >
                        <RiskIndicator category={ev.riskCategory} score={ev.riskScore} compact />
                        <p className="text-xs font-medium text-[#F5F8FC] mt-1">
                          {ev.conflictType}
                        </p>
                        <p className="text-[11px] font-mono text-[#A9B8CA]">
                          {ev.occurredAt.slice(0, 10)} · {ev.validationStatus}
                        </p>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <p className="text-sm text-[#A9B8CA]">No monitored locations found.</p>
          )}
        </div>
      </div>
    </div>
  );
}
