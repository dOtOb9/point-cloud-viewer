import type { Program } from "../../../plugin-api";
import { viewStatusText } from "../labels";
import type { ViewModel, ViewMsg } from "../model";
import { useViewModel } from "./useViewModel";

export function ViewStatus({ program }: { program: Program<ViewModel, ViewMsg> }) {
  const { view } = useViewModel(program);
  if (!view.rendererHasLayers) return null;
  return (
    <span className="whitespace-nowrap" data-testid="view-status">
      <span className="hidden md:inline">{viewStatusText(view.preset, view.projection, false)}</span>
      <span className="md:hidden">{viewStatusText(view.preset, view.projection, true)}</span>
    </span>
  );
}
