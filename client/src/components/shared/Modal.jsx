import { useEffect } from 'react';
import { X } from 'lucide-react';

export default function Modal({ open, onClose, title, children, width, showClose = false }) {
  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" style={width ? { width } : undefined} onClick={e => e.stopPropagation()}>
        {showClose ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 18 }}>
            {title ? <h3 style={{ margin: 0 }}>{title}</h3> : <span />}
            <button className="btn btn-s btn-sm" onClick={onClose} aria-label="Close">
              <X style={{ width: 12, height: 12 }} />
            </button>
          </div>
        ) : (
          title && <h3>{title}</h3>
        )}
        {children}
      </div>
    </div>
  );
}
