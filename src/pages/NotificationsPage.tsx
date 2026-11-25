import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  AlertTriangle,
  Bell,
  CheckCheck,
  CheckCircle2,
  ExternalLink,
  Info,
} from 'lucide-react';
import { useRoadshadow } from '../context/RoadshadowContext';

export function NotificationsPage() {
  const { notifications, markNotificationRead, markAllNotificationsRead } = useRoadshadow();
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const navigate = useNavigate();

  const unreadCount = notifications.filter((n) => !n.read).length;
  const filtered =
    filter === 'unread' ? notifications.filter((n) => !n.read) : notifications;

  const sorted = [...filtered].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-[#233B56] pb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[#F5F8FC]">
            Notifications
          </h1>
          <p className="text-sm text-[#A9B8CA] mt-1">
            Processing job completions, critical near-miss alerts, and recurring conflict fingerprint notices.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <div className="inline-flex rounded-md border border-[#233B56] bg-[#0D1F35] p-0.5">
            <button
              type="button"
              onClick={() => setFilter('all')}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                filter === 'all'
                  ? 'bg-[#2585FF] text-white'
                  : 'text-[#A9B8CA] hover:text-[#F5F8FC]'
              }`}
            >
              All ({notifications.length})
            </button>
            <button
              type="button"
              onClick={() => setFilter('unread')}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                filter === 'unread'
                  ? 'bg-[#2585FF] text-white'
                  : 'text-[#A9B8CA] hover:text-[#F5F8FC]'
              }`}
            >
              Unread ({unreadCount})
            </button>
          </div>

          <button
            type="button"
            disabled={unreadCount === 0}
            onClick={() => void markAllNotificationsRead()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-md bg-[#122943] hover:bg-[#193656] text-[#F5F8FC] border border-[#233B56] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <CheckCheck className="w-4 h-4 text-[#45B5FF]" aria-hidden="true" />
            Mark All Read
          </button>
        </div>
      </div>

      {sorted.length === 0 ? (
        <div className="bg-[#122943] border border-[#233B56] rounded-lg p-12 text-center">
          <Bell className="w-8 h-8 text-[#A9B8CA] mx-auto mb-3" aria-hidden="true" />
          <h2 className="text-base font-semibold text-[#F5F8FC]">
            {filter === 'unread' ? 'No unread notifications' : 'No notifications yet'}
          </h2>
          <p className="text-sm text-[#A9B8CA] mt-1">
            {filter === 'unread'
              ? 'All safety alerts and processing job updates have been reviewed.'
              : 'Notifications appear here when video analysis jobs complete or critical conflict events require review.'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {sorted.map((item) => {
            const Icon =
              item.severity === 'critical'
                ? AlertCircle
                : item.severity === 'warning'
                  ? AlertTriangle
                  : item.severity === 'success'
                    ? CheckCircle2
                    : Info;
            const iconColor =
              item.severity === 'critical'
                ? 'text-[#E5484D]'
                : item.severity === 'warning'
                  ? 'text-[#F97316]'
                  : item.severity === 'success'
                    ? 'text-[#22C55E]'
                    : 'text-[#45B5FF]';

            return (
              <article
                key={item.id}
                className={`p-4 rounded-lg border transition-colors flex flex-col sm:flex-row sm:items-start justify-between gap-4 ${
                  item.read
                    ? 'bg-[#0D1F35] border-[#233B56]/70'
                    : 'bg-[#122943] border-[#2585FF]/50'
                }`}
              >
                <div className="flex items-start gap-3.5 min-w-0">
                  <div className="mt-0.5 shrink-0">
                    <Icon className={`w-5 h-5 ${iconColor}`} aria-hidden="true" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="text-sm font-semibold text-[#F5F8FC]">{item.title}</h2>
                      {!item.read && (
                        <span className="text-[11px] font-mono text-[#45B5FF] bg-[#2585FF]/15 border border-[#2585FF]/35 px-1.5 py-0.5 rounded">
                          UNREAD
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-[#A9B8CA] mt-1 leading-relaxed">{item.message}</p>
                    <p className="text-xs font-mono text-[#A9B8CA]/80 mt-2">
                      {new Date(item.createdAt).toLocaleString()}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {item.linkPath && (
                    <button
                      type="button"
                      onClick={() => {
                        if (!item.read) void markNotificationRead(item.id);
                        navigate(item.linkPath!);
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#2585FF] hover:bg-[#1C74E8] text-white rounded-md transition-colors"
                    >
                      Open
                      <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  )}
                  {!item.read && (
                    <button
                      type="button"
                      onClick={() => void markNotificationRead(item.id)}
                      className="px-3 py-1.5 text-xs font-medium bg-[#071426] hover:bg-[#0D1F35] text-[#A9B8CA] hover:text-[#F5F8FC] border border-[#233B56] rounded-md transition-colors"
                    >
                      Mark Read
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
