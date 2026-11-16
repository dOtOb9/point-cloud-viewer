import { useSyncExternalStore } from "react";
import type { Store } from "../app/store";

/** Read a store (src/app/store.ts) in a component. The component re-renders when the value changes. */
export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get);
}
