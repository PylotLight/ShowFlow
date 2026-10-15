// Plex Media Server client — just enough for post-import library refresh.
// Docs: https://plexapi.dev/ (sections + refresh are long-stable endpoints)

export interface PlexSection {
  key: string;
  title: string;
  type: string;
  locations: string[];
}

export class PlexClient {
  private baseUrl: string;

  constructor(baseUrl: string, private token: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private async request(path: string): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        headers: {
          'X-Plex-Token': this.token,
          'X-Plex-Client-Identifier': 'showflow',
          'X-Plex-Product': 'ShowFlow',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new Error(`Could not reach Plex at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status === 401) throw new Error('Plex rejected the token (401 Unauthorized).');
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Plex request failed: ${res.status}${text ? ` - ${text.slice(0, 200)}` : ''}`);
    }
    return res;
  }

  async getSections(): Promise<PlexSection[]> {
    const res = await this.request('/library/sections');
    const body = (await res.json()) as any;
    const dirs: any[] = body?.MediaContainer?.Directory ?? [];
    return dirs.map(d => ({
      key: String(d.key),
      title: String(d.title ?? ''),
      type: String(d.type ?? ''),
      locations: (Array.isArray(d.Location) ? d.Location : []).map((l: any) => String(l.path ?? '')).filter(Boolean),
    }));
  }

  /** Partial scan of one folder inside a section (GET .../refresh?path=). */
  async refreshSection(sectionKey: string, path?: string): Promise<void> {
    const qs = path ? `?path=${encodeURIComponent(path)}` : '';
    await this.request(`/library/sections/${encodeURIComponent(sectionKey)}/refresh${qs}`);
  }

  async test(): Promise<{ ok: boolean; message?: string; sections?: number }> {
    try {
      const sections = await this.getSections();
      return { ok: true, sections: sections.length, message: `${sections.length} librar${sections.length === 1 ? 'y' : 'ies'} found` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}
