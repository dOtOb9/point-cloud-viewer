// A tiny store: { get, set, subscribe } (ADR-0021 revision, RF-5). State that plain functions in src/app/ read
// and change lives in one of these; React reads it with useSyncExternalStore (src/state/useStore.ts) and only shows it.
// Not a class and no hidden fields: the value is in the closure and `set` tells the listeners.

export interface Store<T> {
  /** The latest value. Plain functions call this when they need it, so no ref box is needed. */
  get: () => T;
  /** Replace the value. Listeners are told only when it changed (Object.is). */
  set: (value: T) => void;
  /** Call `listener` after every change. Returns the function that stops it. */
  subscribe: (listener: () => void) => () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (value) => {
      if (Object.is(value, current)) return;
      current = value;
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
