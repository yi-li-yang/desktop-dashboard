// The one door to the Rust side. In the normal build these are Tauri's own
// functions. `npm run demo` (Vite mode "demo") swaps in src/demo.ts, which
// answers with invented data so the UI renders in a plain browser; the check is
// on a build-time constant, so a normal build drops the demo code entirely.

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, emit as tauriEmit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as demo from "./demo";

const DEMO = import.meta.env.MODE === "demo";
if (DEMO) demo.setup();

export const invoke: typeof tauriInvoke = DEMO ? demo.invoke : tauriInvoke;
export const listen: typeof tauriListen = DEMO ? demo.listen : tauriListen;
export const emit: typeof tauriEmit = DEMO ? demo.emit : tauriEmit;
export const closeWindow = (): Promise<void> => (DEMO ? Promise.resolve() : getCurrentWindow().close());
