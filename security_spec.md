# ROADSHADOW Security Specification (Phase 0: Payload-First Security TDD)

## 1. Data Invariants

1. **Default Deny & Verified Identity**: All Firestore access is denied by default (`match /{document=**} { allow read, write: if false; }`). Every write requires `request.auth != null` and `request.auth.token.email_verified == true`.
2. **PII Isolation**: User emails and notification preferences live strictly under `/users/{userId}/private/{docId}` and may only be read or written by the owning user (`request.auth.uid == userId`) or a verified administrator.
3. **No Self-Assigned Privilege Escalation**: Users creating `/users/{userId}` can only self-register as `VIEWER` or `ANALYST` (never `ADMINISTRATOR`), and cannot mutate their own `role` field on update; only a verified administrator can promote roles or write `/admins/{adminUid}`.
4. **Master Gate & Global Consistency**: Every location, camera, video, processing job, conflict event, conflict fingerprint, recommendation, and report belongs to a valid existing parent `/projects/{projectId}` owned by the caller (or administered by a verified admin).
5. **Immutable Provenance & Original AI Separation**: `ownerId`, `projectId`, `createdAt`, and `originalConflictType` on `conflictEvents` are strictly immutable after creation so human analyst corrections never silently overwrite the original AI output.
6. **Terminal State Locking**: Once a `processingJobs` document reaches a terminal status (`Completed`, `Failed`, `Cancelled`), non-admin updates are blocked.
7. **Temporal Integrity**: `createdAt` on create and `updatedAt` on update must strictly equal `request.time`.
8. **Secure List Queries**: Every `allow list` rule evaluates `resource.data` against `request.auth.uid` (or `isAdmin()`) without `get()`/`exists()` calls inside `list` rules.

## 2. The "Dirty Dozen" Adversarial Payloads

1. **P01 — Self-Admin Registration**: Creating `/users/attacker` with `{ role: "ADMINISTRATOR" }` must return `PERMISSION_DENIED`.
2. **P02 — Role Escalation Update**: Updating `/users/analyst1` with `{ role: "ADMINISTRATOR" }` as `analyst1` must return `PERMISSION_DENIED`.
3. **P03 — PII Cross-User Read**: Reading `/users/victim/private/profile` as `analyst1` must return `PERMISSION_DENIED`.
4. **P04 — Unverified Email Spoof**: Attempting admin action with `email: "akshitpatel2107@gmail.com"` and `email_verified: false` must return `PERMISSION_DENIED`.
5. **P05 — Shadow Field Injection**: Creating `/projects/proj_1` with an undeclared ghost key `{ isApprovedByGov: true }` must return `PERMISSION_DENIED`.
6. **P06 — Owner Spoofing**: Creating `/projects/proj_2` with `{ ownerId: "other_user" }` must return `PERMISSION_DENIED`.
7. **P07 — Orphaned Location Write**: Creating `/locations/loc_orphan` referencing a non-existent `projectId: "missing_proj"` must return `PERMISSION_DENIED`.
8. **P08 — Path ID Poisoning**: Creating `/projects/../../../etc/passwd` or an ID > 128 chars must return `PERMISSION_DENIED`.
9. **P09 — Client Timestamp Forgery**: Creating `/projects/proj_3` with a backdated `createdAt` not equal to `request.time` must return `PERMISSION_DENIED`.
10. **P10 — Overwriting Original AI Output**: Updating `/conflictEvents/evt_1` to mutate `originalConflictType` must return `PERMISSION_DENIED`.
11. **P11 — Terminal Job Tampering**: Updating `/processingJobs/job_1` whose existing status is `Completed` as a non-admin must return `PERMISSION_DENIED`.
12. **P12 — Audit Log Tampering/Deletion**: Updating or deleting `/auditLogs/log_1` must return `PERMISSION_DENIED`.
