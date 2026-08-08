import type { DiscoverableCommand, RemoteManifest } from "@astrivya/plugin-api";

export interface ManifestClientOptions {
  cloudUrl: string;
  fetchFn?: typeof fetch;
}

export class ManifestClient {
  private cloudUrl: string;
  private fetchFn: typeof fetch;

  constructor(opts: ManifestClientOptions) {
    this.cloudUrl = opts.cloudUrl.replace(/\/+$/, "");
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
  }

  async fetchManifest(token: string): Promise<RemoteManifest> {
    const url = `${this.cloudUrl}/api/plugins/manifest`;
    const res = await this.fetchFn(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch plugin manifest: ${res.status} ${res.statusText}`);
    }
    return res.json() as Promise<RemoteManifest>;
  }

  async fetchDiscoverable(): Promise<DiscoverableCommand[]> {
    const url = `${this.cloudUrl}/api/plugins/discoverable`;
    const res = await this.fetchFn(url);
    if (!res.ok) {
      return [];
    }
    const body = (await res.json()) as { commands: DiscoverableCommand[] };
    return body.commands ?? [];
  }
}
