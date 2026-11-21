import type { PcvPlugin } from "../plugin-api";
import { viewPlugin } from "./view";

export const builtinPlugins: readonly PcvPlugin[] = [viewPlugin];
