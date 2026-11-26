import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDetectionsSummaryFromGemini,
  classifyGeminiApiError,
  formatSecondsToTimestamp,
  mapGeminiAnalysisToConflictEvents,
  parseTimestampToSeconds,
  validateAndNormalizeGeminiAnalysis,
} from './geminiVideoAnalysis';

describe('geminiVideoAnalysis pure helpers', () => {
  it('parses HH:MM:SS, MM:SS, and numeric timestamps accurately', () => {
    assert.equal(parseTimestampToSeconds('00:01:15'), 75);
    assert.equal(parseTimestampToSeconds('02:30'), 150);
    assert.equal(parseTimestampToSeconds('12.5s'), 12.5);
    assert.equal(parseTimestampToSeconds(42), 42);
    assert.equal(parseTimestampToSeconds('-5'), null);
    assert.equal(parseTimestampToSeconds('not-a-time'), null);
    assert.equal(formatSecondsToTimestamp(75), '00:01:15');
    assert.equal(formatSecondsToTimestamp(0), '00:00:00');
  });

  it('validates structured Gemini JSON, clamps out-of-range timestamps, and flags approximate ones', () => {
    const raw = JSON.stringify({
      video_summary: 'Four-way urban intersection with mixed motorcycle and car traffic.',
      duration_seconds: 120,
      events: [
        {
          timestamp_start: '00:00:15',
          timestamp_end: '00:00:10', // end before start -> should normalize >= start
          is_approximate: false,
          event: 'Motorcycle braked sharply behind turning car.',
          objects_detected: ['Motorcycle', 'car', 'car'],
          activity: 'Sudden braking near turn pocket',
          confidence: 'HIGH',
          risk_level: 'HIGH',
          reason: 'Rapid deceleration observed as car entered path.',
        },
        {
          timestamp_start: '00:02:00', // exceeds 30s duration -> must clamp to 30s and mark approximate
          timestamp_end: '00:02:10',
          is_approximate: false,
          event: 'Pedestrian waited at curb.',
          objects_detected: ['person'],
          activity: 'Waiting to cross',
          confidence: 'medium',
          risk_level: 'low',
          reason: 'Routine curb wait observed.',
        },
      ],
      detected_objects: [
        { label: 'Car', count_estimate: 4, notes: 'Passing through junction' },
        { label: 'Motorcycle', count_estimate: 2, notes: 'Eastbound lane' },
      ],
      important_moments: [
        { timestamp: '00:05:00', description: 'Late timestamp must clamp to 30s' },
      ],
      safety_observations: ['Short sight distance at eastbound corner.'],
      overall_assessment: 'Moderate-to-high interaction risk during turning maneuvers.',
    });

    const normalized = validateAndNormalizeGeminiAnalysis(raw, {
      durationSec: 30,
      modelVersion: 'gemini-4-hydrogen',
      analyzedAtIso: '2026-11-26T00:00:00.000Z',
    });

    assert.equal(normalized.duration_seconds, 30);
    assert.equal(normalized.events.length, 2);

    // Event 1: valid within 30s, end normalized to >= start
    assert.equal(normalized.events[0].timestamp_start_sec, 15);
    assert.equal(normalized.events[0].timestamp_end_sec, 15);
    assert.equal(normalized.events[0].is_approximate, false);
    assert.deepEqual(normalized.events[0].objects_detected, ['motorcycle', 'car']);
    assert.equal(normalized.events[0].confidence, 'high');
    assert.equal(normalized.events[0].risk_level, 'high');

    // Event 2: clamped to 30s and flagged approximate
    assert.equal(normalized.events[1].timestamp_start_sec, 30);
    assert.equal(normalized.events[1].timestamp_end_sec, 30);
    assert.equal(normalized.events[1].timestamp_start, '00:00:30');
    assert.equal(normalized.events[1].is_approximate, true);

    // Important moment clamped to 30s
    assert.equal(normalized.important_moments[0].timestamp_sec, 30);
    assert.equal(normalized.important_moments[0].is_approximate, true);

    // Detections summary matches actual reported counts
    const summary = buildDetectionsSummaryFromGemini(normalized);
    assert.equal(summary.total_detections, 6);
    assert.deepEqual(summary.by_class, { car: 4, motorcycle: 2 });

    // Mapping to ConflictEvents promotes only safety-relevant event (not routine low-risk curb wait)
    const conflicts = mapGeminiAnalysisToConflictEvents(normalized, {
      videoId: 'vid_1',
      projectId: 'proj_1',
      locationId: 'loc_1',
      ownerId: 'user_1',
      fps: 25,
      jobId: 'job_abc123',
    });
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].riskCategory, 'High');
    assert.equal(conflicts[0].estimatedTtcSec, null);
    assert.equal(conflicts[0].estimatedPetSec, null);
    assert.equal(conflicts[0].detectionMethod, 'gemini_multimodal_video');
  });

  it('does not fabricate events or objects when Gemini reports a calm video with zero events', () => {
    const normalized = validateAndNormalizeGeminiAnalysis(
      {
        video_summary: 'Empty test pattern clip with no vehicles or pedestrians.',
        events: [],
        detected_objects: [],
        important_moments: [],
        safety_observations: ['No traffic hazards observed in this footage.'],
        overall_assessment: 'No road-safety risks detected.',
      },
      { durationSec: 4, modelVersion: 'gemini-4-hydrogen' }
    );

    assert.equal(normalized.events.length, 0);
    assert.equal(normalized.detected_objects.length, 0);
    const summary = buildDetectionsSummaryFromGemini(normalized);
    assert.equal(summary.total_detections, 0);
    const conflicts = mapGeminiAnalysisToConflictEvents(normalized, {
      videoId: 'vid_2',
      projectId: 'proj_1',
      locationId: 'loc_1',
      ownerId: 'user_1',
      jobId: 'job_empty',
    });
    assert.equal(conflicts.length, 0);
  });

  it('rejects malformed JSON and incomplete payloads clearly', () => {
    assert.throws(
      () =>
        validateAndNormalizeGeminiAnalysis('not valid json {{{', {
          durationSec: 10,
          modelVersion: 'gemini-4-hydrogen',
        }),
      /malformed JSON/i
    );
    assert.throws(
      () =>
        validateAndNormalizeGeminiAnalysis({ video_summary: '' }, {
          durationSec: 10,
          modelVersion: 'gemini-4-hydrogen',
        }),
      /schema validation/i
    );
  });

  it('classifies Gemini API errors safely without leaking sensitive internals', () => {
    const authErr = classifyGeminiApiError(new Error('API_KEY_INVALID: key AIzaSySecret123 rejected'));
    assert.equal(authErr.statusCode, 503);
    assert.equal(authErr.retryable, false);
    assert.ok(!authErr.userMessage.includes('AIzaSySecret123'));

    const quotaErr = classifyGeminiApiError(new Error('429 RESOURCE_EXHAUSTED quota exceeded'));
    assert.equal(quotaErr.statusCode, 429);
    assert.equal(quotaErr.retryable, true);

    const timeoutErr = classifyGeminiApiError(new Error('Request timed out after 120s'));
    assert.equal(timeoutErr.statusCode, 504);
    assert.equal(timeoutErr.retryable, true);
  });
});
