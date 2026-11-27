import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deduplicateAdjacentFrames,
  mergeSegmentAnalyses,
  partitionSegmentsForRetry,
  planVideoSegments,
  resolveOriginalTimestampSec,
  runWithBoundedConcurrency,
  selectDetailedTargetWindows,
} from './videoPipelinePlanner';
import type { GeminiVideoAnalysis, SegmentProgressSummary } from '../types/roadshadow';

function makeAnalysis(overrides: Partial<GeminiVideoAnalysis> = {}): GeminiVideoAnalysis {
  return {
    video_summary: 'Traffic flowing across intersection.',
    duration_seconds: 25,
    events: [],
    detected_objects: [{ label: 'car', count_estimate: 3, notes: 'Moving through junction' }],
    important_moments: [],
    safety_observations: ['Normal daytime visibility.'],
    overall_assessment: 'Routine traffic flow.',
    model_version: 'gemini-3.1-flash-lite',
    analyzed_at: '2026-11-26T00:00:00.000Z',
    ...overrides,
  };
}

test('planVideoSegments uses a single segment for short clips and smart multi-segments for long clips', () => {
  const shortSegs = planVideoSegments(12, 'balanced');
  assert.equal(shortSegs.length, 1);
  assert.equal(shortSegs[0].startSec, 0);
  assert.equal(shortSegs[0].endSec, 12);
  assert.ok(shortSegs[0].sampleTimestampsSec.length >= 2 && shortSegs[0].sampleTimestampsSec.length <= 8);

  const longSegs = planVideoSegments(90, 'balanced');
  assert.equal(longSegs.length, 4);
  assert.equal(longSegs[0].startSec, 0);
  assert.equal(longSegs[longSegs.length - 1].endSec, 90);
  for (let i = 1; i < longSegs.length; i++) {
    assert.equal(longSegs[i].startSec, longSegs[i - 1].endSec);
  }

  // Very long video caps segment count so we never spawn excessive tiny segments
  const veryLong = planVideoSegments(900, 'fast');
  assert.ok(veryLong.length <= 12);
});

test('deduplicateAdjacentFrames removes identical intermediate frames while preserving endpoints', () => {
  const sameData = 'A'.repeat(400);
  const diffData = 'B'.repeat(550);
  const frames = [
    { timestampSec: 0, timestampLabel: '00:00:00', base64Jpeg: sameData, byteLength: 400 },
    { timestampSec: 2, timestampLabel: '00:00:02', base64Jpeg: sameData, byteLength: 400 },
    { timestampSec: 4, timestampLabel: '00:00:04', base64Jpeg: diffData, byteLength: 550 },
    { timestampSec: 6, timestampLabel: '00:00:06', base64Jpeg: sameData, byteLength: 400 },
  ];
  const kept = deduplicateAdjacentFrames(frames);
  assert.equal(kept.length, 3);
  assert.deepEqual(
    kept.map((f) => f.timestampSec),
    [0, 4, 6]
  );
});

test('resolveOriginalTimestampSec shifts segment-relative timestamps and preserves absolute ones', () => {
  // Segment 25..50s, model returned relative "00:00:05" -> should become 30s
  const shifted = resolveOriginalTimestampSec('00:00:05', 25, 50, 75);
  assert.equal(shifted.sec, 30);

  // Segment 25..50s, model returned absolute "00:00:32" -> stays 32s
  const absolute = resolveOriginalTimestampSec('00:00:32', 25, 50, 75);
  assert.equal(absolute.sec, 32);

  // Out-of-bounds clamped cleanly
  const clamped = resolveOriginalTimestampSec('00:05:00', 25, 50, 75);
  assert.equal(clamped.sec, 50);
  assert.equal(clamped.wasAdjusted, true);
});

test('mergeSegmentAnalyses merges timeline, deduplicates boundary events, and avoids overcounting objects', () => {
  const seg0 = makeAnalysis({
    video_summary: 'Car approaches crossing.',
    events: [
      {
        timestamp_start: '00:00:23',
        timestamp_end: '00:00:25',
        timestamp_start_sec: 23,
        timestamp_end_sec: 25,
        is_approximate: false,
        event: 'Car brakes sharply for crossing motorcycle',
        objects_detected: ['car', 'motorcycle'],
        activity: 'Sudden braking at intersection',
        confidence: 'high',
        risk_level: 'medium',
        reason: 'Close clearance observed.',
      },
    ],
    detected_objects: [
      { label: 'car', count_estimate: 2, notes: 'Sedan approaching' },
      { label: 'motorcycle', count_estimate: 1, notes: 'Crossing left to right' },
    ],
  });

  const seg1 = makeAnalysis({
    video_summary: 'Motorcycle clears intersection safely.',
    events: [
      {
        timestamp_start: '00:00:26',
        timestamp_end: '00:00:28',
        timestamp_start_sec: 26,
        timestamp_end_sec: 28,
        is_approximate: false,
        event: 'Car brakes sharply for crossing motorcycle',
        objects_detected: ['car', 'motorcycle'],
        activity: 'Sudden braking at intersection',
        confidence: 'high',
        risk_level: 'high',
        reason: 'Tight gap during evasive maneuver.',
      },
    ],
    detected_objects: [
      { label: 'car', count_estimate: 3, notes: 'Vehicles in lane' },
    ],
  });

  const merged = mergeSegmentAnalyses(
    [
      { segmentIndex: 0, startSec: 0, endSec: 25, analysis: seg0 },
      { segmentIndex: 1, startSec: 25, endSec: 50, analysis: seg1 },
    ],
    { totalDurationSec: 50, modelVersion: 'gemini-3.1-flash-lite' }
  );

  // Adjacent duplicate boundary event merged into 1 spanning 23..28s with upgraded 'high' risk
  assert.equal(merged.events.length, 1);
  assert.equal(merged.events[0].timestamp_start_sec, 23);
  assert.equal(merged.events[0].timestamp_end_sec, 28);
  assert.equal(merged.events[0].risk_level, 'high');

  // Peak count kept (3, not 2+3=5)
  const carObj = merged.detected_objects.find((o) => o.label === 'car');
  assert.equal(carObj?.count_estimate, 3);
});

test('selectDetailedTargetWindows skips Stage B in fast mode or when no elevated risks exist', () => {
  const calm = makeAnalysis({
    events: [
      {
        timestamp_start: '00:00:02',
        timestamp_end: '00:00:04',
        timestamp_start_sec: 2,
        timestamp_end_sec: 4,
        is_approximate: false,
        event: 'Normal lane traffic',
        objects_detected: ['car'],
        activity: 'Cruising',
        confidence: 'high',
        risk_level: 'low',
        reason: 'Routine movement.',
      },
    ],
  });
  assert.equal(selectDetailedTargetWindows(calm, 'balanced', 20).length, 0);

  const risky = makeAnalysis({
    events: [
      {
        timestamp_start: '00:00:10',
        timestamp_end: '00:00:12',
        timestamp_start_sec: 10,
        timestamp_end_sec: 12,
        is_approximate: false,
        event: 'Pedestrian near-miss',
        objects_detected: ['person', 'car'],
        activity: 'Sudden swerve',
        confidence: 'high',
        risk_level: 'high',
        reason: 'Vehicle passed closely behind pedestrian.',
      },
    ],
  });
  assert.equal(selectDetailedTargetWindows(risky, 'fast', 20).length, 0);
  const windows = selectDetailedTargetWindows(risky, 'balanced', 20);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].windowStartSec, 7);
  assert.equal(windows[0].windowEndSec, 15);
});

test('partitionSegmentsForRetry preserves completed segments and retries only failed ones', () => {
  const planned = planVideoSegments(75, 'balanced'); // 3 segments: 0-25, 25-50, 50-75
  const prev: SegmentProgressSummary[] = planned.map((p, idx) => ({
    segmentIndex: p.segmentIndex,
    startSec: p.startSec,
    endSec: p.endSec,
    status: idx === 1 ? 'failed' : 'completed',
    framesSent: 6,
    errorMessage: idx === 1 ? '429 rate limit' : undefined,
  }));

  const { reusedIndices, pendingIndices } = partitionSegmentsForRetry(prev, planned);
  assert.deepEqual(reusedIndices, [0, 2]);
  assert.deepEqual(pendingIndices, [1]);
});

test('runWithBoundedConcurrency respects max concurrency limit', async () => {
  let active = 0;
  let peak = 0;
  const out = await runWithBoundedConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 15));
    active--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10]);
  assert.ok(peak <= 2);
});
