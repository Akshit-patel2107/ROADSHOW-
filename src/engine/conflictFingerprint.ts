import type {
  ConflictEvent,
  ConflictFingerprint,
  RiskCategory,
  RoadLocation,
} from '../types/roadshadow';

export const MIN_FINGERPRINT_OBSERVATIONS = 2;
export const ESTABLISHED_FINGERPRINT_OBSERVATIONS = 4;

export function getTimeWindowFromIso(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Unspecified window';
  const hour = date.getHours();
  if (hour >= 6 && hour < 8) return '6 AM–8 AM';
  if (hour >= 8 && hour < 10) return '8 AM–10 AM';
  if (hour >= 10 && hour < 12) return '10 AM–12 PM';
  if (hour >= 12 && hour < 15) return '12 PM–3 PM';
  if (hour >= 15 && hour < 17) return '3 PM–5 PM';
  if (hour >= 17 && hour < 20) return '5 PM–8 PM';
  if (hour >= 20 && hour < 23) return '8 PM–11 PM';
  return '11 PM–6 AM';
}

export function getDayPattern(dates: string[]): string {
  let weekdayCount = 0;
  let weekendCount = 0;
  for (const iso of dates) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) continue;
    const day = d.getDay();
    if (day === 0 || day === 6) weekendCount += 1;
    else weekdayCount += 1;
  }
  if (weekdayCount > 0 && weekendCount === 0) return 'Weekdays (Mon–Fri)';
  if (weekendCount > 0 && weekdayCount === 0) return 'Weekends (Sat–Sun)';
  if (weekdayCount >= weekendCount * 2) return 'Primarily Weekdays';
  return 'All Days';
}

function buildInvestigationSuggestion(
  conflictType: ConflictEvent['conflictType'],
  locationType: string
): string {
  switch (conflictType) {
    case 'Motorcycle versus turning car':
      return `Review turning sightlines, dedicated right-turn phasing, and two-wheeler channelization at this ${locationType.toLowerCase()}.`;
    case 'Pedestrian versus vehicle':
      return `Inspect pedestrian crossing visibility, refuge island spacing, advance speed-calming strips, and pedestrian signal intervals at this ${locationType.toLowerCase()}.`;
    case 'Unsafe merging':
      return 'Audit merge taper length, chevron lane markings, and advance signage separating merging slow traffic from through lanes.';
    case 'Wrong-direction movement':
      return 'Evaluate median openings, U-turn spacing, and physical channelizers that may be encouraging counter-flow shortcuts.';
    case 'Sudden braking':
      return 'Check signal visibility distance, queue spillback, and roadside encroachment causing abrupt deceleration.';
    case 'Crossing conflict':
      return 'Assess all-red clearance intervals, stop-line setback, and cross-street sight triangles.';
    default:
      return 'Conduct a field safety audit of lane geometry, visibility obstructions, and peak-hour turning volumes.';
  }
}

function buildPatternFactors(conflictType: ConflictEvent['conflictType']): string[] {
  switch (conflictType) {
    case 'Motorcycle versus turning car':
      return ['Turning visibility', 'Mixed-lane separation', 'Peak-hour volume', 'Conflicting turning paths'];
    case 'Pedestrian versus vehicle':
      return ['Crosswalk visibility', 'Approach speed', 'Unprotected crossing phase', 'Curbside visual obstruction'];
    case 'Unsafe merging':
      return ['Short merge taper', 'Speed differential', 'Absent lane markings', 'Heavy vehicle blind spots'];
    case 'Wrong-direction movement':
      return ['Distant legal U-turn', 'Unchannelized service entry', 'Low enforcement deterrence'];
    case 'Sudden braking':
      return ['Queue spillback', 'Late signal perception', 'Roadside stopping friction'];
    default:
      return ['Intersection geometry', 'Conflicting movement paths', 'Peak traffic density'];
  }
}

/**
 * Generates ROADSHADOW Conflict Fingerprints purely from actual stored events.
 * Excludes false positives and requires at least MIN_FINGERPRINT_OBSERVATIONS events.
 * Marks patterns with fewer than ESTABLISHED_FINGERPRINT_OBSERVATIONS as Preliminary.
 */
export function buildConflictFingerprints(
  events: ConflictEvent[],
  locations: RoadLocation[],
  existingStatuses: Record<string, ConflictFingerprint['investigationStatus']> = {},
  options: { verifiedOnly?: boolean } = {}
): ConflictFingerprint[] {
  const locationMap = new Map(locations.map((loc) => [loc.id, loc]));
  const eligible = events.filter((e) => {
    if (e.validationStatus === 'False positive') return false;
    if (options.verifiedOnly) return e.validationStatus === 'Verified';
    return true;
  });

  const grouped = new Map<string, ConflictEvent[]>();

  for (const event of eligible) {
    const roadUserCombo = [...new Set(event.roadUsers)].sort().join(' + ') || 'unspecified';
    const timeWindow = getTimeWindowFromIso(event.occurredAt);
    const key = [
      event.projectId,
      event.locationId,
      event.conflictType,
      roadUserCombo,
      timeWindow,
      event.movementDirection,
    ].join('::');

    const bucket = grouped.get(key) ?? [];
    bucket.push(event);
    grouped.set(key, bucket);
  }

  const fingerprints: ConflictFingerprint[] = [];

  for (const [key, bucket] of grouped.entries()) {
    if (bucket.length < MIN_FINGERPRINT_OBSERVATIONS) {
      continue;
    }

    const first = bucket[0];
    const loc = locationMap.get(first.locationId);
    const locationName = loc?.name ?? first.locationId;
    const roadUserCombo = [...new Set(first.roadUsers)]
      .sort()
      .map((u) => u.replace('_', ' '))
      .join(' vs ');
    const timeWindow = getTimeWindowFromIso(first.occurredAt);

    const riskDistribution: Record<RiskCategory, number> = {
      Low: 0,
      Medium: 0,
      High: 0,
      Critical: 0,
    };
    for (const item of bucket) {
      riskDistribution[item.riskCategory] += 1;
    }

    // Group events into chronological week buckets for period comparison
    const weekBuckets = new Map<string, { count: number; totalRisk: number }>();
    for (const item of bucket) {
      const d = new Date(item.occurredAt);
      const period = Number.isNaN(d.getTime())
        ? 'Current'
        : `${d.getFullYear()}-W${String(Math.ceil((d.getDate() + 6) / 7)).padStart(2, '0')} (${d.toLocaleString('en-US', { month: 'short' })})`;
      const curr = weekBuckets.get(period) ?? { count: 0, totalRisk: 0 };
      curr.count += 1;
      curr.totalRisk += item.riskScore;
      weekBuckets.set(period, curr);
    }

    const periodTrend = Array.from(weekBuckets.entries()).map(([period, stats]) => ({
      period,
      count: stats.count,
      avgRiskScore: Math.round(stats.totalRisk / stats.count),
    }));

    const deterministicId = `fp_${key
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .slice(0, 72)}`;

    const sortedDates = bucket.map((b) => b.occurredAt).sort();
    const isPreliminary = bucket.length < ESTABLISHED_FINGERPRINT_OBSERVATIONS;
    const supportingVideoIds = Array.from(new Set(bucket.map((b) => b.videoId)));
    const conflictZone = `${loc?.locationType || 'Road'} · ${first.movementDirection}`;

    fingerprints.push({
      id: deterministicId,
      projectId: first.projectId,
      locationId: first.locationId,
      ownerId: first.ownerId,
      locationName,
      patternLabel: `${first.conflictType} (${timeWindow})`,
      conflictType: first.conflictType,
      conflictZone,
      roadUserCombo,
      timeWindow,
      dayOfWeekPattern: getDayPattern(sortedDates),
      movementDirection: first.movementDirection,
      observedCount: bucket.length,
      isPreliminary,
      riskDistribution,
      linkedEventIds: bucket.map((b) => b.id),
      supportingVideoIds,
      contributingFactors: buildPatternFactors(first.conflictType),
      suggestedInvestigation: buildInvestigationSuggestion(
        first.conflictType,
        loc?.locationType ?? 'road location'
      ),
      investigationStatus:
        existingStatuses[deterministicId] ??
        (riskDistribution.Critical > 0 ? 'Marked for investigation' : 'Monitoring'),
      periodTrend,
      createdAt: sortedDates[0] ?? first.createdAt,
      updatedAt: sortedDates[sortedDates.length - 1] ?? first.updatedAt,
    });
  }

  return fingerprints.sort((a, b) => {
    const scoreA = a.riskDistribution.Critical * 10 + a.riskDistribution.High * 4 + a.observedCount;
    const scoreB = b.riskDistribution.Critical * 10 + b.riskDistribution.High * 4 + b.observedCount;
    return scoreB - scoreA;
  });
}
