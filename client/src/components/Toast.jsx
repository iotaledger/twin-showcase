/**
 * Lightweight toast system used by the demo. No external deps — just
 * a Provider + a hook + a module-level bridge so non-React code (e.g.
 * NodeContext's anchor poller) can dispatch toasts too.
 *
 * Variants: success | warning | error. Each toast accepts an optional
 * action ({label, onClick} OR {label, href}). Auto-dismisses after 8s,
 * paused on hover. Stacks top-right, max 3 visible.
 */
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Clock, XCircle, X, ExternalLink } from 'lucide-react';

const ToastCtx = createContext(null);

// Module-level bridge: when ToastProvider mounts it registers its dispatcher
// here. Callers outside the React tree (e.g. NodeContext) can do
// `import { toastBridge } from '.../Toast'; toastBridge.show({...})` without
// needing the hook.
export const toastBridge = {
  show: (_t) => {
    // No-op until ToastProvider mounts; toasts dispatched too early are dropped.
  },
};

const AUTO_DISMISS_MS = 8_000;
const MAX_VISIBLE = 3;

let nextId = 1;
function makeId() { return `t-${nextId++}`; }

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const show = useCallback((toast) => {
    const id = makeId();
    setToasts(prev => {
      const next = [{ id, variant: 'success', ...toast }, ...prev];
      // Keep only the most recent MAX_VISIBLE; drop older ones silently.
      return next.slice(0, MAX_VISIBLE);
    });
    return id;
  }, []);

  // Register the bridge so non-React callers can dispatch.
  useEffect(() => {
    toastBridge.show = show;
    return () => { toastBridge.show = () => {}; };
  }, [show]);

  return (
    <ToastCtx.Provider value={{ show, dismiss }}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

function ToastContainer({ toasts, onDismiss }) {
  return (
    <div className="toast-stack" role="region" aria-live="polite" aria-label="Notifications">
      {toasts.map(t => <Toast key={t.id} toast={t} onDismiss={onDismiss} />)}
    </div>
  );
}

const VARIANT_META = {
  success: { Icon: CheckCircle2, className: 'toast--success' },
  warning: { Icon: Clock,        className: 'toast--warning' },
  error:   { Icon: XCircle,      className: 'toast--error' },
};

function Toast({ toast, onDismiss }) {
  const { Icon, className } = VARIANT_META[toast.variant] || VARIANT_META.success;
  const pausedRef = useRef(false);
  const remainingRef = useRef(AUTO_DISMISS_MS);
  const lastTickRef = useRef(Date.now());

  useEffect(() => {
    const iv = setInterval(() => {
      const now = Date.now();
      if (!pausedRef.current) {
        remainingRef.current -= now - lastTickRef.current;
        if (remainingRef.current <= 0) {
          clearInterval(iv);
          onDismiss(toast.id);
        }
      }
      lastTickRef.current = now;
    }, 250);
    return () => clearInterval(iv);
  }, [toast.id, onDismiss]);

  const handleEnter = () => { pausedRef.current = true; };
  const handleLeave = () => { pausedRef.current = false; lastTickRef.current = Date.now(); };

  return (
    <div className={`toast ${className}`} role="status" onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      <div className="toast__icon"><Icon style={{ width: 20, height: 20 }} /></div>
      <div className="toast__body">
        <div className="toast__title">{toast.title}</div>
        {toast.body && <div className="toast__text">{toast.body}</div>}
        {toast.action && (
          toast.action.href
            ? (
              <a className="toast__action" href={toast.action.href} target="_blank" rel="noreferrer"
                 onClick={() => onDismiss(toast.id)}>
                {toast.action.label} <ExternalLink style={{ width: 11, height: 11 }} />
              </a>
            ) : (
              <button className="toast__action" onClick={() => { toast.action.onClick?.(); onDismiss(toast.id); }}>
                {toast.action.label}
              </button>
            )
        )}
      </div>
      <button className="toast__close" onClick={() => onDismiss(toast.id)} aria-label="Dismiss notification">
        <X style={{ width: 14, height: 14 }} />
      </button>
    </div>
  );
}
