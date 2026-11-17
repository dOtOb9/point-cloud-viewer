// @vitest-environment jsdom
//
// TP-1 F-10 / RP F-RP-5: the path from the layer list to "the view keys work" is tested end to end: the hook gets the
// layers, syncViewEnabled decides whether a point cloud is open, and a key press changes the projection only then.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { createViewContext } from "../../app/view";
import type { ViewerLayer } from "../../state/layers";
import { useViewShortcuts } from "./useViewShortcuts";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const pointCloud = { id: "a" } as unknown as ViewerLayer;
const measurement = { id: "m", measurement: { kind: "distance" } } as unknown as ViewerLayer;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

function Probe({ ctx, layers }: { ctx: ReturnType<typeof createViewContext>; layers: ViewerLayer[] }) {
  useViewShortcuts(ctx, layers);
  return null;
}

function mount(ctx: ReturnType<typeof createViewContext>, layers: ViewerLayer[]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<Probe ctx={ctx} layers={layers} />));
  return (layersNext: ViewerLayer[]) => act(() => root!.render(<Probe ctx={ctx} layers={layersNext} />));
}

function press(key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

describe("useViewShortcuts", () => {
  it("5 switches the projection while a point cloud is open", () => {
    const ctx = createViewContext();
    mount(ctx, [pointCloud]);
    const event = press("5");
    expect(ctx.projection.get()).toBe("orthographic");
    expect(event.defaultPrevented).toBe(true);
  });

  it("with only measurement layers left, 5 changes nothing and the key is not taken", () => {
    const ctx = createViewContext();
    mount(ctx, [measurement]);
    const event = press("5");
    expect(ctx.projection.get()).toBe("perspective");
    expect(event.defaultPrevented).toBe(false);
  });

  it("with no layer at all the keys do nothing", () => {
    const ctx = createViewContext();
    mount(ctx, []);
    press("5");
    expect(ctx.projection.get()).toBe("perspective");
  });

  it("follows the layer list: deleting the point cloud stops the keys, opening one starts them", () => {
    const ctx = createViewContext();
    const rerender = mount(ctx, [pointCloud, measurement]);
    press("5");
    expect(ctx.projection.get()).toBe("orthographic");
    rerender([measurement]); // the point-cloud layer was removed
    press("5");
    expect(ctx.projection.get()).toBe("orthographic"); // unchanged
    rerender([measurement, pointCloud]);
    press("5");
    expect(ctx.projection.get()).toBe("perspective");
  });

  // Audit trendpoint-parity-PR R1 F-1: the view dialog stays open and has projection radio buttons. After clicking one,
  // focus is on an <input type="radio">, which takes no typed text, so the view keys must still work.
  it("F-1 the keys still work while a radio button (the dialog's projection choice) has focus", () => {
    const ctx = createViewContext();
    mount(ctx, [pointCloud]);
    const radio = document.createElement("input");
    radio.type = "radio";
    document.body.appendChild(radio);
    radio.focus();
    const event = new KeyboardEvent("keydown", { key: "5", bubbles: true, cancelable: true });
    act(() => {
      radio.dispatchEvent(event);
    });
    expect(ctx.projection.get()).toBe("orthographic");
  });
});
