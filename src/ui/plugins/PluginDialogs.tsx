import type { PluginHostCore } from "../../core/plugin-host";
import type { DialogWidth } from "../../plugin-api";
import { Dialog } from "../dialogs/Dialog";
import { DIALOG_TERTIARY_BUTTON_CLASS } from "../dialogs/dialog-styles";
import { PluginErrorBoundary } from "./PluginErrorBoundary";
import { RenderedByPlugin } from "./RenderedByPlugin";
import { usePluginHostState } from "./usePluginHost";

const DIALOG_WIDTH_CLASS: Record<DialogWidth, string> = {
  normal: "max-w-lg",
  narrow: "max-w-xs",
};

export function PluginDialogs({ host }: { host: PluginHostCore }) {
  const { dialogs } = usePluginHostState(host);
  return (
    <>
      {dialogs.map((entry) => {
        const close = () => host.closeDialog(entry.key);
        const closeButtonLabel = entry.item.closeButtonLabel;
        return (
          <PluginErrorBoundary
            key={entry.key}
            pluginId={entry.pluginId}
            onError={(pluginId, error) => {
              host.report(pluginId, error);
              close();
            }}
          >
            <Dialog
              open
              title={entry.item.title}
              placement={entry.item.placement}
              widthClass={DIALOG_WIDTH_CLASS[entry.item.width ?? "normal"]}
              onClose={close}
              footer={
                closeButtonLabel === undefined ? undefined : (
                  <button type="button" onClick={close} className={DIALOG_TERTIARY_BUTTON_CLASS}>
                    {closeButtonLabel}
                  </button>
                )
              }
            >
              <RenderedByPlugin render={entry.item.render} />
            </Dialog>
          </PluginErrorBoundary>
        );
      })}
    </>
  );
}
