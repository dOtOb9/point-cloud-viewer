import { useSyncExternalStore } from "react";
import type { Program } from "../../../plugin-api";
import type { ViewModel, ViewMsg } from "../model";

export function useViewModel(program: Program<ViewModel, ViewMsg>): ViewModel {
  return useSyncExternalStore(program.subscribe, program.getModel);
}
