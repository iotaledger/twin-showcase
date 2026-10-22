import { useState, useEffect, useCallback, useRef } from 'react';

// useApiResource — one place for the "fetch on mount + on dependency change,
// keep previous data, expose loading/error, allow manual refetch" pattern that
// every view used to hand-roll (useState + useEffect(api.getX) + silent catch
// keyed on refreshKey). Centralising it means error handling lives in ONE spot
// instead of being swallowed per component.
//
//   const { data, loading, error, refetch } = useApiResource(
//     () => api.getConsignments(user.id),
//     [user.id, refreshKey],
//     { initial: [] },
//   );
//
// Behaviour preserved from the old pattern: on error the PREVIOUS data is kept
// (the UI doesn't flash empty), but `error` is now exposed so callers can show
// it if they want. A stale in-flight response can't overwrite a newer one (the
// effect cancels on dependency change / unmount).
//
// `enabled: false` skips fetching (e.g. before a user/id is known).
export function useApiResource(fetchFn, deps = [], { initial = null, enabled = true } = {}) {
  const [data, setData] = useState(initial);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState(null);
  // Keep the latest fetchFn without making it a dependency (callers pass a fresh
  // closure each render; the deps array is the intended trigger).
  const fnRef = useRef(fetchFn);
  fnRef.current = fetchFn;

  // Manual refetch (e.g. after a mutation) — shares the keep-previous-data rule.
  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fnRef.current();
      setData(result);
      setError(null);
      return result;
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) { setLoading(false); return undefined; }
    let cancelled = false;
    setLoading(true);
    fnRef.current()
      .then((r) => { if (!cancelled) { setData(r); setError(null); } })
      .catch((e) => { if (!cancelled) setError(e); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);

  return { data, loading, error, refetch };
}
