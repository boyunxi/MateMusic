import { useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { useToastStore } from "../store/useToastStore";
import type { Toast, ToastKind } from "../store/useToastStore";

const ICONS: Record<ToastKind, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
};

function ToastItem({ toast }: { toast: Toast }) {
  const dismiss = useToastStore((state) => state.dismiss);
  const Icon = ICONS[toast.kind];

  useEffect(() => {
    if (toast.duration <= 0) return;
    const timer = setTimeout(() => dismiss(toast.id), toast.duration);
    return () => clearTimeout(timer);
  }, [dismiss, toast.duration, toast.id]);

  return (
    <motion.div
      className={`toast toast-${toast.kind}`}
      initial={{ opacity: 0, y: 14, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 10, scale: 0.98 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      role="status"
    >
      <Icon size={16} className="toast-icon" />
      <span className="toast-message">{toast.message}</span>
      {toast.actionLabel && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            toast.onAction?.();
            dismiss(toast.id);
          }}
        >
          {toast.actionLabel}
        </button>
      )}
      <button type="button" className="toast-close" onClick={() => dismiss(toast.id)} aria-label="关闭提示">
        <X size={14} />
      </button>
    </motion.div>
  );
}

export default function ToastHost() {
  const toasts = useToastStore((state) => state.toasts);

  return (
    <div className="toast-host" aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} />
        ))}
      </AnimatePresence>
    </div>
  );
}
