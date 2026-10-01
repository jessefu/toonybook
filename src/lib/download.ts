/**
 * Hand a downloaded blob to the browser as a save-file prompt.
 *
 * The object URL is released on a timer rather than straight after `click()`:
 * the browser reads it asynchronously, and revoking in the same tick can cancel
 * the download before it has started.
 */
export function saveBlobAsFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
