import { useState } from 'react';
import {
  Check,
  History,
  Lock,
  Shield,
  Users,
  X,
} from 'lucide-react';
import { useRoadshadow } from '../context/RoadshadowContext';
import { canPerformAction } from '../engine/validation';
import type { UserRole } from '../types/roadshadow';

const PERMISSION_MATRIX: Array<{
  capability: string;
  admin: boolean;
  analyst: boolean;
  viewer: boolean;
}> = [
  { capability: 'View dashboards, conflict events, fingerprints & risk map', admin: true, analyst: true, viewer: true },
  { capability: 'Upload traffic video footage & trigger CV processing jobs', admin: true, analyst: true, viewer: false },
  { capability: 'Validate conflict events & record analyst notes', admin: true, analyst: true, viewer: false },
  { capability: 'Manage locations & camera infrastructure', admin: true, analyst: true, viewer: false },
  { capability: 'Generate AI explanations, recommendations & audit reports', admin: true, analyst: true, viewer: false },
  { capability: 'Create, archive, or delete safety study projects', admin: true, analyst: false, viewer: false },
  { capability: 'Assign user roles & inspect full security audit logs', admin: true, analyst: false, viewer: false },
  { capability: 'Configure provisional risk scoring thresholds & upload limits', admin: true, analyst: false, viewer: false },
];

export function UserManagementPage() {
  const { currentUser, users, auditLogs, updateUserRole } = useRoadshadow();
  const [updatingUid, setUpdatingUid] = useState<string | null>(null);
  const [auditFilter, setAuditFilter] = useState('');

  const canManageUsers = currentUser ? canPerformAction(currentUser.role, 'manage_users') : false;
  const canViewAudit = currentUser ? canPerformAction(currentUser.role, 'view_audit_logs') : false;

  const handleRoleChange = async (uid: string, nextRole: UserRole) => {
    setUpdatingUid(uid);
    try {
      await updateUserRole(uid, nextRole);
    } finally {
      setUpdatingUid(null);
    }
  };

  const filteredLogs = auditLogs.filter((entry) => {
    if (!auditFilter.trim()) return true;
    const q = auditFilter.toLowerCase();
    return (
      entry.action.toLowerCase().includes(q) ||
      entry.actorName.toLowerCase().includes(q) ||
      entry.targetType.toLowerCase().includes(q) ||
      entry.details.toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-6">
      <div className="border-b border-[#233B56] pb-5">
        <h1 className="text-2xl font-bold tracking-tight text-[#F5F8FC]">
          User Management &amp; Audit Trail
        </h1>
        <p className="text-sm text-[#A9B8CA] mt-1">
          Role-based access control (RBAC) across municipal administrators, road safety analysts, and read-only department viewers.
        </p>
      </div>

      {!canManageUsers && (
        <div className="p-4 rounded-lg bg-[#122943] border border-[#EAB308]/40 flex items-start gap-3">
          <Lock className="w-5 h-5 text-[#EAB308] shrink-0 mt-0.5" aria-hidden="true" />
          <div className="text-sm">
            <p className="font-medium text-[#F5F8FC]">Administrator Access Required for Role Changes</p>
            <p className="text-[#A9B8CA] mt-0.5">
              Your current role is <span className="font-mono text-[#F5F8FC]">{currentUser?.role}</span>. You can inspect the permission matrix below, while role assignments and full audit trails are restricted to Administrators.
            </p>
          </div>
        </div>
      )}

      {/* Active Users Table */}
      <section className="bg-[#122943] border border-[#233B56] rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-[#233B56] flex items-center justify-between">
          <h2 className="text-base font-semibold text-[#F5F8FC] flex items-center gap-2">
            <Users className="w-4 h-4 text-[#45B5FF]" aria-hidden="true" />
            Workspace Accounts ({users.length})
          </h2>
          <span className="text-xs text-[#A9B8CA]">
            PII emails isolated under private user subcollections
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-[#0D1F35] text-xs text-[#A9B8CA] border-b border-[#233B56]">
              <tr>
                <th className="px-5 py-3 font-medium">User</th>
                <th className="px-5 py-3 font-medium">Email / Privacy</th>
                <th className="px-5 py-3 font-medium">Role</th>
                <th className="px-5 py-3 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#233B56]">
              {users.map((u) => {
                const isSelf = u.uid === currentUser?.uid;
                return (
                  <tr key={u.uid} className="hover:bg-[#0D1F35]/50 transition-colors">
                    <td className="px-5 py-3.5">
                      <p className="font-medium text-[#F5F8FC]">
                        {u.displayName}
                        {isSelf && (
                          <span className="ml-2 text-[11px] font-mono text-[#45B5FF]">(You)</span>
                        )}
                      </p>
                      <p className="text-xs font-mono text-[#A9B8CA]/80">{u.uid}</p>
                    </td>
                    <td className="px-5 py-3.5 text-[#A9B8CA] text-xs font-mono">
                      {u.email}
                    </td>
                    <td className="px-5 py-3.5">
                      {canManageUsers && !isSelf ? (
                        <select
                          aria-label={`Role for ${u.displayName}`}
                          value={u.role}
                          disabled={updatingUid === u.uid}
                          onChange={(e) => void handleRoleChange(u.uid, e.target.value as UserRole)}
                          className="bg-[#071426] border border-[#233B56] text-[#F5F8FC] text-xs font-mono rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-[#2585FF]"
                        >
                          <option value="ADMINISTRATOR">ADMINISTRATOR</option>
                          <option value="ANALYST">ANALYST</option>
                          <option value="VIEWER">VIEWER</option>
                        </select>
                      ) : (
                        <span className="text-xs font-mono text-[#45B5FF] bg-[#071426] border border-[#233B56] px-2.5 py-1 rounded">
                          {u.role}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-xs font-mono text-[#A9B8CA]">
                      {new Date(u.updatedAt).toLocaleDateString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* RBAC Matrix */}
      <section className="bg-[#122943] border border-[#233B56] rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-[#233B56]">
          <h2 className="text-base font-semibold text-[#F5F8FC] flex items-center gap-2">
            <Shield className="w-4 h-4 text-[#45B5FF]" aria-hidden="true" />
            Role Permission Matrix
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-[#0D1F35] text-xs text-[#A9B8CA] border-b border-[#233B56]">
              <tr>
                <th className="px-5 py-3 font-medium">Platform Capability</th>
                <th className="px-5 py-3 font-medium text-center">Administrator</th>
                <th className="px-5 py-3 font-medium text-center">Analyst</th>
                <th className="px-5 py-3 font-medium text-center">Viewer</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#233B56]">
              {PERMISSION_MATRIX.map((row) => (
                <tr key={row.capability} className="hover:bg-[#0D1F35]/40">
                  <td className="px-5 py-3 text-[#F5F8FC] text-xs sm:text-sm">
                    {row.capability}
                  </td>
                  {[row.admin, row.analyst, row.viewer].map((allowed, idx) => (
                    <td key={idx} className="px-5 py-3 text-center">
                      {allowed ? (
                        <span className="inline-flex items-center justify-center text-[#22C55E]" aria-label="Allowed">
                          <Check className="w-4 h-4" />
                        </span>
                      ) : (
                        <span className="inline-flex items-center justify-center text-[#A9B8CA]/40" aria-label="Restricted">
                          <X className="w-4 h-4" />
                        </span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Security & Activity Audit Log */}
      <section className="bg-[#122943] border border-[#233B56] rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-[#233B56] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-[#F5F8FC] flex items-center gap-2">
            <History className="w-4 h-4 text-[#45B5FF]" aria-hidden="true" />
            Immutable Audit Log ({filteredLogs.length})
          </h2>
          {canViewAudit && (
            <input
              type="search"
              value={auditFilter}
              onChange={(e) => setAuditFilter(e.target.value)}
              placeholder="Filter by action, actor, or target..."
              aria-label="Filter audit logs"
              className="bg-[#071426] border border-[#233B56] rounded-md px-3 py-1.5 text-xs text-[#F5F8FC] placeholder:text-[#A9B8CA]/70 w-full sm:w-64 focus:outline-none focus:ring-2 focus:ring-[#2585FF]"
            />
          )}
        </div>

        {!canViewAudit ? (
          <div className="p-6 text-sm text-[#A9B8CA]">
            Full audit log visibility is restricted to Administrators.
          </div>
        ) : filteredLogs.length === 0 ? (
          <div className="p-6 text-sm text-[#A9B8CA]">No audit records match your filter.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#0D1F35] text-[#A9B8CA] border-b border-[#233B56]">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Timestamp</th>
                  <th className="px-5 py-2.5 font-medium">Actor</th>
                  <th className="px-5 py-2.5 font-medium">Action</th>
                  <th className="px-5 py-2.5 font-medium">Target</th>
                  <th className="px-5 py-2.5 font-medium">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#233B56]">
                {filteredLogs.slice(0, 50).map((log) => (
                  <tr key={log.id} className="hover:bg-[#0D1F35]/40">
                    <td className="px-5 py-3 font-mono text-[#A9B8CA] whitespace-nowrap">
                      {new Date(log.createdAt).toLocaleString()}
                    </td>
                    <td className="px-5 py-3 text-[#F5F8FC] whitespace-nowrap">
                      {log.actorName}{' '}
                      <span className="text-[11px] font-mono text-[#A9B8CA]">({log.actorRole})</span>
                    </td>
                    <td className="px-5 py-3 font-mono text-[#45B5FF] whitespace-nowrap">
                      {log.action}
                    </td>
                    <td className="px-5 py-3 font-mono text-[#A9B8CA] whitespace-nowrap">
                      {log.targetType} / {log.targetId}
                    </td>
                    <td className="px-5 py-3 text-[#A9B8CA] max-w-md">{log.details}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
