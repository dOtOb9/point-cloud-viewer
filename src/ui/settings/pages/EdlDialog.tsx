import type { CopcViewerState } from "../../../state/useCopcViewer";
import { OptionRow } from "../../dialogs/OptionRow";
import { SettingsPageDialog, type PageProps } from "../SettingsPageDialog";

export function EdlDialog({ viewer, ...page }: PageProps & { viewer: CopcViewerState }) {
  return (
    <SettingsPageDialog {...page} title="陰影（EDL）">
      <p className="text-xs opacity-70">EDL は、奥行きの差を陰影にして点群の凹凸を強調する処理。画面全体にかかる。</p>
      <OptionRow>
        <input type="checkbox" name="edl-enabled" checked={viewer.edlEnabled} onChange={(e) => viewer.setEdlEnabled(e.target.checked)} className="h-5 w-5 accent-primary" />
        EDLを使う
      </OptionRow>
    </SettingsPageDialog>
  );
}
