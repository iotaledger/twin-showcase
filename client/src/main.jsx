import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import PublicVerify from './pages/PublicVerify';
import PublicShipment from './pages/PublicShipment';
import { ConfigProvider } from './context/ConfigContext';
import { NodeProvider } from './context/NodeContext';
import { ToastProvider } from './components/Toast';
import './index.css';

// Public QR landing pages are standalone — no auth, no providers. Everything
// else is the authenticated SPA.
//   /verify/:docId   — document verification (T-4V03 WP4)
//   /shipment/:id    — shipment dossier (T-4V04)
const path = window.location.pathname;
const publicPage = path.startsWith('/verify/') ? <PublicVerify />
  : path.startsWith('/shipment/') ? <PublicShipment />
  : null;

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {publicPage ?? (
      <ToastProvider>
        <ConfigProvider>
          <NodeProvider><App /></NodeProvider>
        </ConfigProvider>
      </ToastProvider>
    )}
  </React.StrictMode>
);
