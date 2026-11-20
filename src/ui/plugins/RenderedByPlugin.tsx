import type { ReactNode } from "react";
import type { ViewNode } from "../../plugin-api";

export function RenderedByPlugin({ render }: { render: () => ViewNode }) {
  return <>{render() as ReactNode}</>;
}
