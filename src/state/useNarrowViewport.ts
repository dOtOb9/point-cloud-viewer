import { useEffect, useState } from "react";

export function useNarrowViewport(breakpointPx = 768): boolean {
  const query = `(max-width: ${breakpointPx - 1}px)`;
  const [narrow, setNarrow] = useState<boolean>(() => {
    if (typeof matchMedia === "undefined") return false;
    return matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const mq = matchMedia(query);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);

  return narrow;
}
