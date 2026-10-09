/// <reference lib="webworker" />
/** Runs the bootstrap off the main thread so the page stays responsive. */

import { runBootstrap, type BootstrapInput } from './bootstrap';

export interface BootstrapRequest {
  inputs: BootstrapInput[];
  n: number;
  B: number;
}

self.onmessage = (event: MessageEvent<BootstrapRequest>) => {
  const { inputs, n, B } = event.data;
  try {
    self.postMessage({ ok: true, result: runBootstrap(inputs, n, B) });
  } catch (err) {
    self.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
