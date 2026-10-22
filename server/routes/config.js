import { Router } from 'express';
import { getConfig } from '../config.js';

const router = Router();

router.get('/api/config', (req, res) => {
  const c = getConfig();
  if (!c) return res.json(null);
  res.json({
    corridor: c.corridor,
    branding: c.branding,
    theme: c.theme,
    geography: c.geography,
    credentials: { testCredentials: c.credentials?.testCredentials },
    finance: { currencies: c.finance?.currencies, paymentMethods: c.finance?.paymentMethods },
  });
});

export default router;
