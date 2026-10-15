import type { UpdateCheckState } from "../../../state/useUpdateCheck";
import { SettingsPageDialog, type PageProps } from "../SettingsPageDialog";

export function UpdateDialog({ update, ...page }: PageProps & { update: UpdateCheckState }) {
  return (
    <SettingsPageDialog {...page} title="更新の確認">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={update.enabled} onChange={(e) => update.setEnabled(e.target.checked)} />
        起動時に新しいバージョンを確認する
      </label>
      <p className="text-xs opacity-60">新しい版があるか確認するだけで、ダウンロードとインストールは自分で行う。</p>
      {update.currentVersion && <p className="text-xs opacity-60">現在のバージョン: {update.currentVersion}</p>}
    </SettingsPageDialog>
  );
}
