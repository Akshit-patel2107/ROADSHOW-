import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { AlertCircle, MapPin, Plus, Trash2 } from 'lucide-react';
import { useRoadshadow } from '../context/RoadshadowContext';
import { canPerformAction, validateCoordinates } from '../engine/validation';
import { ConfirmDialog } from '../components/ToastContainer';
import type { LocationType } from '../types/roadshadow';

const LOCATION_TYPES: LocationType[] = [
  'Intersection',
  'Highway',
  'School zone',
  'Hospital zone',
  'Commercial road',
  'Residential road',
  'Pedestrian crossing',
  'Other',
];

export function LocationsPage() {
  const {
    locations,
    projects,
    cameras,
    conflictEvents,
    selectedProjectId,
    currentUser,
    createLocation,
    deleteLocation,
  } = useRoadshadow();
  const [searchParams] = useSearchParams();

  const canManage = currentUser ? canPerformAction(currentUser.role, 'manage_locations') : false;

  const [name, setName] = useState('');
  const [projectId, setProjectId] = useState(
    selectedProjectId !== 'ALL' ? selectedProjectId : projects[0]?.id || ''
  );
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('Anand');
  const [stateName, setStateName] = useState('Gujarat');
  const [country, setCountry] = useState('India');
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [locationType, setLocationType] = useState<LocationType>('Intersection');
  const [description, setDescription] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

  const pickerMapEl = useRef<HTMLDivElement | null>(null);
  const pickerMapRef = useRef<L.Map | null>(null);
  const pickerMarkerRef = useRef<L.CircleMarker | null>(null);

  const highlightedId = searchParams.get('selected');

  const scopedLocations = useMemo(
    () =>
      locations.filter((l) =>
        selectedProjectId === 'ALL' ? true : l.projectId === selectedProjectId
      ),
    [locations, selectedProjectId]
  );

  useEffect(() => {
    if (selectedProjectId !== 'ALL' && projects.some((p) => p.id === selectedProjectId)) {
      setProjectId(selectedProjectId);
      return;
    }
    if (!projectId || !projects.some((p) => p.id === projectId)) {
      if (projects[0]) setProjectId(projects[0].id);
    }
  }, [selectedProjectId, projects, projectId]);

  // Interactive Leaflet click-to-pick map for verified coordinates
  useEffect(() => {
    if (!pickerMapEl.current || pickerMapRef.current) return;
    const map = L.map(pickerMapEl.current, {
      center: [22.5645, 72.9289],
      zoom: 13,
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap',
      maxZoom: 19,
    }).addTo(map);

    map.on('click', (e: L.LeafletMouseEvent) => {
      const lat = Number(e.latlng.lat.toFixed(5));
      const lng = Number(e.latlng.lng.toFixed(5));
      setLatitude(String(lat));
      setLongitude(String(lng));
      setFormError(null);
      if (pickerMarkerRef.current) {
        pickerMarkerRef.current.setLatLng([lat, lng]);
      } else {
        pickerMarkerRef.current = L.circleMarker([lat, lng], {
          radius: 8,
          color: '#F5F8FC',
          weight: 2,
          fillColor: '#2585FF',
          fillOpacity: 0.9,
        }).addTo(map);
      }
    });

    pickerMapRef.current = map;
    return () => {
      map.remove();
      pickerMapRef.current = null;
      pickerMarkerRef.current = null;
    };
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!canManage) {
      setFormError('Your role does not allow registering road locations.');
      return;
    }
    const effectiveProject = projectId || projects[0]?.id;
    if (!effectiveProject) {
      setFormError('Create a project first before adding road locations.');
      return;
    }
    if (name.trim().length < 2) {
      setFormError('Enter a location name (minimum 2 characters).');
      return;
    }
    if (!latitude.trim() || !longitude.trim()) {
      setFormError('Provide coordinates manually or click a real road point on the map below.');
      return;
    }
    const latNum = Number(latitude);
    const lngNum = Number(longitude);
    const check = validateCoordinates(latNum, lngNum);
    if (!check.valid) {
      setFormError(check.error || 'Invalid GPS coordinates.');
      return;
    }

    setSaving(true);
    try {
      await createLocation({
        projectId: effectiveProject,
        name: name.trim(),
        address: address.trim(),
        city: city.trim() || 'Anand',
        state: stateName.trim() || 'Gujarat',
        country: country.trim() || 'India',
        latitude: latNum,
        longitude: lngNum,
        locationType,
        description: description.trim(),
      });
      setName('');
      setAddress('');
      setLatitude('');
      setLongitude('');
      setDescription('');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#F5F8FC]">Location Management</h1>
        <p className="text-sm text-[#A9B8CA] mt-1">
          Register monitored intersections, school zones, highway merges, and pedestrian crossings with validated GPS coordinates.
        </p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        {/* Left: Add Location Form + Interactive Map Picker */}
        <form
          onSubmit={handleCreate}
          className="xl:col-span-5 bg-[#122943] border border-[#233B56] rounded-lg p-5 space-y-4"
        >
          <div className="flex items-center gap-2">
            <Plus className="w-4 h-4 text-[#45B5FF]" />
            <h2 className="text-base font-semibold text-[#F5F8FC]">Register Road Location</h2>
          </div>

          <div>
            <label htmlFor="loc-name" className="block text-xs text-[#A9B8CA] mb-1">
              Location Name *
            </label>
            <input
              id="loc-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Borsad Chokdi Four-Way Junction"
              className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC]"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="loc-project" className="block text-xs text-[#A9B8CA] mb-1">
                Project *
              </label>
              <select
                id="loc-project"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC]"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="loc-type" className="block text-xs text-[#A9B8CA] mb-1">
                Location Type *
              </label>
              <select
                id="loc-type"
                value={locationType}
                onChange={(e) => setLocationType(e.target.value as LocationType)}
                className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC]"
              >
                {LOCATION_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="loc-addr" className="block text-xs text-[#A9B8CA] mb-1">
              Street Address / Landmark
            </label>
            <input
              id="loc-addr"
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="e.g. Ring Road & Station Approach"
              className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC]"
            />
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div>
              <label htmlFor="loc-city" className="block text-xs text-[#A9B8CA] mb-1">
                City
              </label>
              <input
                id="loc-city"
                type="text"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-2.5 py-1.5 text-sm text-[#F5F8FC]"
              />
            </div>
            <div>
              <label htmlFor="loc-state" className="block text-xs text-[#A9B8CA] mb-1">
                State
              </label>
              <input
                id="loc-state"
                type="text"
                value={stateName}
                onChange={(e) => setStateName(e.target.value)}
                className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-2.5 py-1.5 text-sm text-[#F5F8FC]"
              />
            </div>
            <div>
              <label htmlFor="loc-country" className="block text-xs text-[#A9B8CA] mb-1">
                Country
              </label>
              <input
                id="loc-country"
                type="text"
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-2.5 py-1.5 text-sm text-[#F5F8FC]"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="loc-lat" className="block text-xs text-[#A9B8CA] mb-1">
                Latitude * (Click map or enter)
              </label>
              <input
                id="loc-lat"
                type="text"
                value={latitude}
                onChange={(e) => setLatitude(e.target.value)}
                placeholder="22.5645"
                className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-1.5 text-sm font-mono text-[#F5F8FC]"
              />
            </div>
            <div>
              <label htmlFor="loc-lng" className="block text-xs text-[#A9B8CA] mb-1">
                Longitude *
              </label>
              <input
                id="loc-lng"
                type="text"
                value={longitude}
                onChange={(e) => setLongitude(e.target.value)}
                placeholder="72.9289"
                className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-1.5 text-sm font-mono text-[#F5F8FC]"
              />
            </div>
          </div>

          {/* Click-to-pick OpenStreetMap selector */}
          <div className="space-y-1">
            <p className="text-xs text-[#A9B8CA]">
              Click anywhere on the map to set verified coordinates:
            </p>
            <div
              ref={pickerMapEl}
              className="h-44 w-full rounded-md overflow-hidden border border-[#233B56] z-10 relative"
            />
          </div>

          <div>
            <label htmlFor="loc-desc" className="block text-xs text-[#A9B8CA] mb-1">
              Site Description
            </label>
            <textarea
              id="loc-desc"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Signalized arms, lane markings, school/hospital proximity..."
              className="w-full bg-[#0D1F35] border border-[#233B56] rounded-md px-3 py-2 text-sm text-[#F5F8FC]"
            />
          </div>

          {formError && (
            <div role="alert" className="p-3 rounded-md bg-[#E5484D]/10 border border-[#E5484D]/40 text-xs text-[#F5F8FC] flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-[#E5484D] shrink-0 mt-0.5" />
              <span>{formError}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={!canManage || saving}
            className="w-full px-4 py-2 bg-[#2585FF] hover:bg-[#1C74E8] disabled:opacity-50 text-white text-sm font-medium rounded-md"
          >
            {saving ? 'Saving Location...' : 'Save Road Location'}
          </button>
        </form>

        {/* Right: Locations Directory */}
        <div className="xl:col-span-7 space-y-3">
          {scopedLocations.length === 0 ? (
            <div className="bg-[#122943] border border-[#233B56] rounded-lg p-10 text-center text-sm text-[#A9B8CA]">
              No locations registered for this project yet. Use the form on the left to add your first monitored road site.
            </div>
          ) : (
            scopedLocations.map((loc) => {
              const proj = projects.find((p) => p.id === loc.projectId);
              const camCount = cameras.filter((c) => c.locationId === loc.id).length;
              const evCount = conflictEvents.filter((e) => e.locationId === loc.id).length;
              const isHighlighted = highlightedId === loc.id;

              return (
                <div
                  key={loc.id}
                  className={`bg-[#122943] border rounded-lg p-5 transition-colors ${
                    isHighlighted ? 'border-[#2585FF]' : 'border-[#233B56]'
                  }`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2 text-xs text-[#45B5FF]">
                        <MapPin className="w-3.5 h-3.5" />
                        <span>{loc.locationType}</span>
                        <span aria-hidden="true">·</span>
                        <span className="text-[#A9B8CA]">{proj?.name || loc.projectId}</span>
                      </div>
                      <h3 className="text-base font-semibold text-[#F5F8FC] mt-1">{loc.name}</h3>
                      <p className="text-xs text-[#A9B8CA] mt-0.5">
                        {loc.address ? `${loc.address}, ` : ''}
                        {loc.city}, {loc.state}, {loc.country}
                      </p>
                    </div>

                    {canManage && (
                      <button
                        type="button"
                        onClick={() => setDeleteTargetId(loc.id)}
                        aria-label={`Delete location ${loc.name}`}
                        className="p-2 text-[#A9B8CA] hover:text-[#E5484D] rounded-md hover:bg-[#0D1F35]"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>

                  {loc.description && (
                    <p className="text-xs text-[#A9B8CA] mt-2 leading-relaxed">
                      {loc.description}
                    </p>
                  )}

                  <div className="mt-3 pt-3 border-t border-[#233B56] flex flex-wrap items-center gap-4 text-xs text-[#A9B8CA]">
                    <span className="font-mono tabular-nums">
                      GPS: {loc.latitude.toFixed(4)}, {loc.longitude.toFixed(4)}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums text-[#F5F8FC]">
                      {camCount} Camera{camCount === 1 ? '' : 's'}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums text-[#F5F8FC]">
                      {evCount} Conflict Event{evCount === 1 ? '' : 's'}
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(deleteTargetId)}
        title="Delete Monitored Location?"
        description="Removing this location record will unlink it from the Locations directory. Existing historical conflict events remain intact for audit traceability."
        confirmLabel="Delete Location"
        destructive
        onCancel={() => setDeleteTargetId(null)}
        onConfirm={async () => {
          if (deleteTargetId) {
            await deleteLocation(deleteTargetId);
            setDeleteTargetId(null);
          }
        }}
      />
    </div>
  );
}
