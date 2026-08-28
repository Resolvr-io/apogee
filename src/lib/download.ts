// Hand the user a file from an extension page: a blob URL clicked through a
// detached anchor. No host page and no server, which is the only option a side
// panel has.
export function downloadText(
  filename: string,
  contents: string,
  type = "text/plain;charset=utf-8",
): void {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Safe synchronously after click(): the download is already handed to the
  // browser, and leaving it would pin the blob for the panel's lifetime.
  URL.revokeObjectURL(url);
}
