import { createElement } from "react";
import { Eye } from "lucide-react";
import { PLUGIN_API_VERSION, type PcvPlugin, type PluginHost, type Program } from "../../plugin-api";
import { createViewEffects } from "./effects";
import { VIEW_BUTTON_DISABLED_TITLE, VIEW_BUTTON_TITLE, VIEW_SHORTCUTS } from "./labels";
import { initialViewModel, updateView, type ViewModel, type ViewMsg } from "./model";
import { ViewDialogBody } from "./view/ViewDialogBody";
import { ViewStatus } from "./view/ViewStatus";

function activateView(host: PluginHost): () => void {
  const program: Program<ViewModel, ViewMsg> = host.program<ViewModel, ViewMsg>(
    initialViewModel(host.layers.hasPointCloud(), host.view.get()),
    (model, msg) => updateView(model, msg, effects),
    (error) => ({ type: "effectFailed", error }),
  );
  const effects = createViewEffects(host, () => createElement(ViewDialogBody, { program }));

  const enabled = program.getModel().pointCloud;
  const ribbon = host.ribbon.add({
    group: "view",
    label: "視点",
    icon: Eye,
    title: VIEW_BUTTON_TITLE,
    disabledTitle: VIEW_BUTTON_DISABLED_TITLE,
    enabled,
    testId: "view-button",
    onClick: () => program.dispatch({ type: "ribbonClicked" }),
  });
  const keys = VIEW_SHORTCUTS.map((shortcut) =>
    host.shortcuts.add({ key: shortcut.key, label: shortcut.label, kind: "harmless", enabled, run: () => program.dispatch(shortcut.msg) }),
  );
  host.status.add({ render: () => createElement(ViewStatus, { program }) });

  const stopEnabled = program.subscribe(() => {
    const pointCloud = program.getModel().pointCloud;
    ribbon.setEnabled(pointCloud);
    for (const key of keys) key.setEnabled(pointCloud);
  });
  const stopLayers = host.layers.subscribe(() => program.dispatch({ type: "layersChanged", pointCloud: host.layers.hasPointCloud() }));
  const stopView = host.view.subscribe(() => program.dispatch({ type: "viewChanged", view: host.view.get() }));

  return () => {
    stopView();
    stopLayers();
    stopEnabled();
  };
}

export const viewPlugin: PcvPlugin = {
  id: "pcv.view",
  name: "視点",
  apiVersion: PLUGIN_API_VERSION,
  activate: activateView,
};
