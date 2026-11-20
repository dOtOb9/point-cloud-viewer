import type { PluginHostCore } from "../../core/plugin-host";
import { Dialog } from "../dialogs/Dialog";
import { PluginView } from "./PluginView";
import { usePluginHostState } from "./usePluginHost";

export function PluginDialogs({ host }: { host: PluginHostCore }) {
  const { dialogs } = usePluginHostState(host);
  return (
    <>
      {dialogs.map((entry) => (
        <Dialog key={entry.key} open title={entry.item.title} placement={entry.item.placement} onClose={() => host.closeDialog(entry.key)}>
          <PluginView host={host} pluginId={entry.pluginId} render={entry.item.render} />
        </Dialog>
      ))}
    </>
  );
}
