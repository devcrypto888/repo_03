/**
 * In-process memo for expensive read endpoints, with request coalescing: if
 * 30 dashboard tabs ask for the same report while it's computing, there is
 * one query, and everyone awaits the same promise.
 *
 * Bounded (LRU-ish by insertion) so a parameterised key can't grow without limit.
 */
const store = new Map<string, { at: number; value?: unknown; pending?: Promise<unknown> }>();
const MAX_KEYS = 500;

export async function cached<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);

  if (hit?.pending) return hit.pending as Promise<T>;
  if (hit && 'value' in hit && now - hit.at < ttlMs) return hit.value as T;

  const pending = compute()
    .then((value) => {
      store.set(key, { at: Date.now(), value });
      return value;
    })
    .catch((err) => {
      store.delete(key);
      throw err;
    });

  store.set(key, { at: now, pending });
  if (store.size > MAX_KEYS) store.delete(store.keys().next().value!);
  return pending;
}

export function invalidate(prefix: string) {
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
}
