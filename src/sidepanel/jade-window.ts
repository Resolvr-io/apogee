// Open the standalone Jade connection page. Web Serial needs a top-level secure
// context + user gesture (not available in the side panel or offscreen doc).
// We open it as a full TAB rather than a popup window: Chrome's Web Serial
// device chooser reliably enumerates ports in a normal tab, but often comes up
// EMPTY in an extension popup window.
import { browser } from "@/lib/ext";

export function openJadeWindow(network: string): void {
  void browser.tabs.create({
    url: browser.runtime.getURL(`src/jade/jade.html?network=${encodeURIComponent(network)}`),
  });
}
