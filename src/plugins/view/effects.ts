import type { PluginHost, ViewNode } from "../../plugin-api";
import type { ViewEffects } from "./model";

export function createViewEffects(host: PluginHost, renderDialogBody: () => ViewNode): ViewEffects {
  return {
    openDialog(dispatch) {
      host.dialogs.open({
        title: "視点",
        placement: "side",
        width: "narrow",
        closeButtonLabel: "閉じる",
        render: renderDialogBody,
        onClose: () => dispatch({ type: "dialogClosed" }),
      });
    },
    fitAll: () => host.view.fitAll(),
    showPreset: (id) => () => host.view.showPreset(id),
    setProjection: (mode) => () => host.view.setProjection(mode),
  };
}
