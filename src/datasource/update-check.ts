const REPO = "dOtOb9/point-cloud-viewer";

export interface LatestRelease {
  tagName: string;
  htmlUrl: string;
  body: string;
}

export async function fetchLatestRelease(): Promise<LatestRelease | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return null;

    const json = (await res.json()) as { tag_name?: string; html_url?: string; body?: string };
    if (!json.tag_name || !json.html_url) return null;

    return { tagName: json.tag_name, htmlUrl: json.html_url, body: json.body ?? "" };
  } catch {
    return null;
  }
}
