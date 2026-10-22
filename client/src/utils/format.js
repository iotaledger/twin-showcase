/**
 * Abbreviated value formatter (e.g. $168K, €1.20M, KES 500K).
 * Used in Dashboard, Consignments, Payments.
 */
export function fmtValue(val, currency = 'USD') {
  if (!val || isNaN(Number(val))) return '\u2014';
  const n = Number(val);
  if (currency === 'KES') {
    if (n >= 1_000_000) return `KES ${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000)     return `KES ${(n / 1_000).toFixed(1)}K`;
    return `KES ${n.toLocaleString()}`;
  }
  const sym = currency === 'EUR' ? '\u20ac' : '$';
  if (n >= 1_000_000) return `${sym}${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${sym}${(n / 1_000).toFixed(0)}K`;
  return `${sym}${n.toLocaleString()}`;
}

/**
 * Full-precision currency formatter (e.g. $168,000.00, \u20ac264,000.00).
 * Used in TradeFinance for LC/contract amounts.
 */
export function fmtCurrency(n, cur = 'USD') {
  const symbols = { USD: '$', EUR: '\u20ac', GBP: '\u00a3', JPY: '\u00a5', CNY: '\u00a5', KES: 'KES ', VND: '\u20ab', KRW: '\u20a9' };
  const s = symbols[cur] || cur + ' ';
  return `${s}${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
