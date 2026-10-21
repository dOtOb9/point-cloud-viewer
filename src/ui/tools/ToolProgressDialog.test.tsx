// @vitest-environment jsdom
//
// G0-3: collapsing the tool progress dialog (outside click / Esc) must not cancel the tool; only the cancel button does.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CopcViewerState } from "../../state/useCopcViewer";

const cancelTool = vi.fn();
vi.mock("../../app/point-cloud-tools", () => ({ cancelTool: (...args: unknown[]) => cancelTool(...args) }));

import { ToolProgressDialog } from "./ToolProgressDialog";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const viewer = {
  toolProgress: { title: "断面", pointsRead: 5, totalPoints: 10 },
  toolContext: {},
} as unknown as CopcViewerState;

function mount(onCollapse: () => void) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<ToolProgressDialog viewer={viewer} open onCollapse={onCollapse} />));
  return () => {
    act(() => root.unmount());
    container.remove();
  };
}

afterEach(() => cancelTool.mockClear());

describe("ToolProgressDialog", () => {
  it("Esc collapses without cancelling the tool", () => {
    const onCollapse = vi.fn();
    const cleanup = mount(onCollapse);
    const panel = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(panel).not.toBeNull();
    act(() => {
      panel?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onCollapse).toHaveBeenCalledTimes(1);
    expect(cancelTool).not.toHaveBeenCalled();
    cleanup();
  });

  it("the cancel button cancels the tool", () => {
    const onCollapse = vi.fn();
    const cleanup = mount(onCollapse);
    const button = document.querySelector<HTMLButtonElement>('[data-testid="tool-cancel"]');
    act(() => button?.click());
    expect(cancelTool).toHaveBeenCalledTimes(1);
    expect(onCollapse).not.toHaveBeenCalled();
    cleanup();
  });
});
