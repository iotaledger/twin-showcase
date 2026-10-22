import React, { createContext, useContext, useState, useEffect } from 'react';
import { api } from '../utils/api';

const Ctx = createContext(null);

export function ConfigProvider({ children }) {
  const [config, setConfig] = useState(null);

  useEffect(() => {
    api.getConfig().then(c => {
      setConfig(c);
      // Apply theme overrides to CSS custom properties
      if (c?.theme) {
        const s = document.documentElement.style;
        if (c.theme.accent)      s.setProperty('--accent', c.theme.accent);
        if (c.theme.accentLight) s.setProperty('--accent-light', c.theme.accentLight);
        if (c.theme.navBg)       s.setProperty('--nav-bg', c.theme.navBg);
        if (c.theme.navHover)    s.setProperty('--nav-hover', c.theme.navHover);
        if (c.theme.navActive)   s.setProperty('--nav-active', c.theme.navActive);
        if (c.theme.amber)       s.setProperty('--amber', c.theme.amber);
      }
      // Set page title from branding
      if (c?.branding?.appName) document.title = c.branding.appName;
    }).catch(() => {});
  }, []);

  return <Ctx.Provider value={config}>{children}</Ctx.Provider>;
}

export function useConfig() { return useContext(Ctx); }
