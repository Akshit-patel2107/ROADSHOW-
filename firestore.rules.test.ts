import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const rulesPath = path.resolve(process.cwd(), 'firestore.rules');
const draftPath = path.resolve(process.cwd(), 'DRAFT_firestore.rules');
const activeRules = fs.existsSync(rulesPath)
  ? fs.readFileSync(rulesPath, 'utf-8')
  : fs.readFileSync(draftPath, 'utf-8');

const blueprint = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'firebase-blueprint.json'), 'utf-8')
);

test('Pillar 1 & Safety Net: default deny catch-all exists at top of rules', () => {
  assert.match(activeRules, /match \/\{document=\*\*\}\s*\{\s*allow read, write: if false;\s*\}/);
});

test('Phase 1 Coverage: every blueprint collection has a dedicated match block', () => {
  const paths = Object.keys(blueprint.firestore);
  for (const p of paths) {
    const cleanName = p.split('/').filter(Boolean)[0];
    assert.ok(
      activeRules.includes(`match /${cleanName}/`),
      `Missing match block for collection /${cleanName}/`
    );
  }
});

test('Dirty Dozen P01 & P02: self-assigned admin creation and self role escalation blocked', () => {
  assert.match(activeRules, /incoming\(\)\.role in \['ANALYST', 'VIEWER'\]/);
  assert.match(activeRules, /incoming\(\)\.role == existing\(\)\.role/);
});

test('Dirty Dozen P03: PII isolated in /private subcollection restricted to owner or admin', () => {
  assert.match(activeRules, /match \/private\/\{docId\}/);
  assert.match(activeRules, /allow get: if isValidId\(userId\) && isValidId\(docId\) && \(isOwnerUid\(userId\) \|\| isAdmin\(\)\);/);
});

test('Dirty Dozen P04: email verification strictly enforced on bootstrapped admin', () => {
  assert.match(activeRules, /request\.auth\.token\.email_verified == true/);
  assert.match(activeRules, /isBootstrappedAdmin\(\)/);
});

test('Dirty Dozen P05 & P08: strict hasOnly key allowlists and path ID hardening present', () => {
  assert.ok(activeRules.includes('data.keys().hasOnly('));
  assert.ok(activeRules.includes('isValidId(projectId)'));
  assert.ok(activeRules.includes("id.matches('^[a-zA-Z0-9_\\\\-]+$')"));
});

test('Dirty Dozen P06 & P07: ownerId match and parent project existence enforced', () => {
  assert.ok(activeRules.includes('incoming().ownerId == request.auth.uid'));
  assert.ok(activeRules.includes('isProjectOwner(incoming().projectId)'));
});

test('Dirty Dozen P09: temporal integrity enforces request.time on createdAt and updatedAt', () => {
  assert.ok(activeRules.includes('incoming().createdAt == request.time'));
  assert.ok(activeRules.includes('incoming().updatedAt == request.time'));
});

test('Dirty Dozen P10: originalConflictType is immutable on conflictEvents updates', () => {
  assert.ok(activeRules.includes('incoming().originalConflictType == existing().originalConflictType'));
});

test('Dirty Dozen P11: terminal processingJob statuses locked against non-admin updates', () => {
  assert.ok(activeRules.includes("!(existing().status in ['Completed', 'Failed', 'Cancelled'])"));
});

test('Dirty Dozen P12: auditLogs are strictly append-only (no update or delete)', () => {
  const auditSection = activeRules.slice(activeRules.indexOf('match /auditLogs/'));
  assert.match(auditSection, /allow update: if false;/);
  assert.match(auditSection, /allow delete: if false;/);
});

test('Pillar 8: no blanket allow list rules and no get()/exists() in allow list', () => {
  const listRules = activeRules.match(/allow list:[^;]+;/g) || [];
  assert.ok(listRules.length >= 10, 'Expected explicit allow list rules across collections');
  for (const rule of listRules) {
    assert.ok(!rule.includes('get('), `Cost violation: get() found in ${rule}`);
    assert.ok(!rule.includes('exists('), `Cost violation: exists() found in ${rule}`);
    assert.ok(!/allow list:\s*if\s*isSignedIn\(\)\s*;/.test(rule), `Blanket list rule found: ${rule}`);
  }
});
