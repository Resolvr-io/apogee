// Open the standalone Jade connection page. Web Serial needs a top-level secure
// context + user gesture (not available in the side panel or offscreen doc).
// We open it as a full TAB rather than a popup window: Chrome's Web Serial
// device chooser reliably enumerates ports in a normal tab, but often comes up
// EMPTY in an extension popup window.
export function openJadeWindow(network: string): void {
  void chrome.tabs.create({
    url: chrome.runtime.getURL(`src/jade/jade.html?network=${encodeURIComponent(network)}`),
  });
}
