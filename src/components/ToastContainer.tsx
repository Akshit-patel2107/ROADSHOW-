import { AlertCircle, CheckCircle2, Info, X, AlertTriangle } from 'lucide-react';
import { useRoadshadow } from '../context/RoadshadowContext';

export function ToastContainer() {
  const { toasts, dismissToast } = useRoadshadow();

  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      aria-label="Notifications"
      className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none"
    >
      {toasts.map((toast) => {
        const Icon =
          toast.type === 'success'
            ? CheckCircle2
            : toast.type === 'error'
              ? AlertCircle
              : toast.type === 'warning'
                ? AlertTriangle
                : Info;
        const accent =
          toast.type === 'success'
            ? 'text-[#22C55E]'
            : toast.type === 'error'
              ? 'text-[#E5484D]'
              : toast.type === 'warning'
                ? 'text-[#EAB308]'
                : 'text-[#45B5FF]';

        return (
          <div
            key={toast.id}
            role="status"
            className="pointer-events-auto bg-[#122943] border border-[#233B56] rounded-lg p-3.5 shadow-lg flex items-start gap-3"
          >
            <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${accent}`} aria-hidden="true" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-[#F5F8FC]">{toast.title}</p>
              {toast.description && (
                <p className="text-xs text-[#A9B8CA] mt-0.5 leading-relaxed">
                  {toast.description}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => dismissToast(toast.id)}
              aria-label={`Dismiss ${toast.title}`}
              className="text-[#A9B8CA] hover:text-[#F5F8FC] p-1 rounded"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  destructive = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4"
    >
      <div className="bg-[#122943] border border-[#233B56] rounded-lg max-w-md w-full p-6 space-y-4">
        <h2 id="confirm-dialog-title" className="text-base font-semibold text-[#F5F8FC]">
          {title}
        </h2>
        <p className="text-sm text-[#A9B8CA] leading-relaxed">{description}</p>
        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-[#A9B8CA] hover:text-[#F5F8FC] bg-[#0D1F35] border border-[#233B56] rounded-md transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`px-4 py-2 text-sm font-medium text-white rounded-md transition-colors ${
              destructive
                ? 'bg-[#E5484D] hover:bg-[#CC3A3F]'
                : 'bg-[#2585FF] hover:bg-[#1C74E8]'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
