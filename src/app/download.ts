// Web download of a file the app built: a temporary <a download> click. Shared by the GeoTIFF export and the section line export.

/** Make the browser save the file at `url` (a Blob URL or a link) under `fileName`. */
export function startDownload(url: string, fileName: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
}
