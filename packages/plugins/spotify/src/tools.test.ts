import { describe, expect, it, vi } from "vitest";
import { SpotifyClient, type SpotifyRequestOptions } from "./client.js";
import { createSpotifyToolset } from "./tools.js";

const meta = { activationKey: "node-1" };

/** A SpotifyClient whose `request` is fully mocked — these tests exercise the tools' argument
 *  parsing/dispatch, not SpotifyClient itself (that's client.test.ts's job). */
function fakeClient(
  handler: (method: string, path: string, opts: SpotifyRequestOptions) => unknown,
  opts: { connected?: boolean } = {},
): SpotifyClient {
  const client = Object.create(SpotifyClient.prototype) as SpotifyClient;
  (client as unknown as { request: SpotifyClient["request"] }).request = vi.fn(
    async (method: string, path: string, reqOpts: SpotifyRequestOptions = {}) => handler(method, path, reqOpts),
  ) as unknown as SpotifyClient["request"];
  (client as unknown as { isConnected: SpotifyClient["isConnected"] }).isConnected = () => opts.connected ?? true;
  return client;
}

function toolByName(client: SpotifyClient, name: string) {
  const reg = createSpotifyToolset(client).find((r) => r.spec.name === name);
  if (!reg) throw new Error(`no tool named ${name}`);
  return reg;
}

describe("spotify_search", () => {
  it("defaults to searching tracks and returns a flattened summary", async () => {
    const tool = toolByName(
      fakeClient((method, path, opts) => {
        expect(method).toBe("GET");
        expect(path).toBe("/search");
        expect(opts.query).toEqual({ q: "abba", type: "track", limit: 20 });
        return { tracks: { items: [{ id: "t1", name: "Waterloo", uri: "spotify:track:t1", artists: [{ name: "ABBA" }] }] } };
      }),
      "spotify_search",
    );
    const result = await tool.handler({ query: "abba" }, meta);
    expect(JSON.parse(result as string)).toEqual({
      tracks: [{ id: "t1", name: "Waterloo", uri: "spotify:track:t1", artists: ["ABBA"] }],
    });
  });

  it("honors an explicit comma-separated types list and limit", async () => {
    const tool = toolByName(
      fakeClient((_m, _p, opts) => {
        expect(opts.query).toEqual({ q: "x", type: "artist,album", limit: 5 });
        return {};
      }),
      "spotify_search",
    );
    await tool.handler({ query: "x", types: "artist,album", limit: 5 }, meta);
  });

  it("returns an error string (not a throw) when query is missing", async () => {
    const tool = toolByName(fakeClient(() => ({})), "spotify_search");
    const result = await tool.handler({}, meta);
    expect(result).toMatch(/^error:/);
  });
});

describe("spotify_playlists", () => {
  it("list summarizes the current user's playlists", async () => {
    const tool = toolByName(
      fakeClient((method, path) => {
        expect(method).toBe("GET");
        expect(path).toBe("/me/playlists");
        return { items: [{ id: "p1", name: "Roadtrip", uri: "spotify:playlist:p1", tracks: { total: 12 } }] };
      }),
      "spotify_playlists",
    );
    const result = await tool.handler({ action: "list" }, meta);
    expect(JSON.parse(result as string)).toEqual([{ id: "p1", name: "Roadtrip", uri: "spotify:playlist:p1", tracksTotal: 12 }]);
  });

  it("add_tracks normalizes bare ids to URIs and posts them", async () => {
    const tool = toolByName(
      fakeClient((method, path, opts) => {
        expect(method).toBe("POST");
        expect(path).toBe("/playlists/p1/tracks");
        expect(opts.body).toEqual({ uris: ["spotify:track:abc", "spotify:track:def"] });
        return {};
      }),
      "spotify_playlists",
    );
    const result = await tool.handler({ action: "add_tracks", playlistId: "p1", trackUris: "abc,def" }, meta);
    expect(result).toBe("added 2 track(s) to playlist p1");
  });

  it("add_tracks accepts a JSON array string for trackUris", async () => {
    const tool = toolByName(
      fakeClient((_m, _p, opts) => {
        expect(opts.body).toEqual({ uris: ["spotify:track:abc"] });
        return {};
      }),
      "spotify_playlists",
    );
    await tool.handler({ action: "add_tracks", playlistId: "p1", trackUris: '["spotify:track:abc"]' }, meta);
  });

  it("create fetches the current user id first, then posts to /users/:id/playlists", async () => {
    const calls: string[] = [];
    const tool = toolByName(
      fakeClient((method, path, opts) => {
        calls.push(path);
        if (path === "/me") return { id: "user-42" };
        expect(method).toBe("POST");
        expect(path).toBe("/users/user-42/playlists");
        expect(opts.body).toEqual({ name: "New Mix", description: undefined, public: false });
        return { id: "p9", name: "New Mix", uri: "spotify:playlist:p9" };
      }),
      "spotify_playlists",
    );
    const result = await tool.handler({ action: "create", name: "New Mix" }, meta);
    expect(calls).toEqual(["/me", "/users/user-42/playlists"]);
    expect(JSON.parse(result as string)).toEqual({ id: "p9", name: "New Mix", uri: "spotify:playlist:p9" });
  });

  it("returns an error string for an unknown action", async () => {
    const tool = toolByName(fakeClient(() => ({})), "spotify_playlists");
    const result = await tool.handler({ action: "nonsense" }, meta);
    expect(result).toMatch(/unknown action/);
  });

  it("returns an error string when a required id is missing", async () => {
    const tool = toolByName(fakeClient(() => ({})), "spotify_playlists");
    const result = await tool.handler({ action: "get" }, meta);
    expect(result).toMatch(/^error:/);
  });
});

describe("spotify_library", () => {
  it("defaults itemType to track for list", async () => {
    const tool = toolByName(
      fakeClient((method, path) => {
        expect(method).toBe("GET");
        expect(path).toBe("/me/tracks");
        return { items: [{ track: { id: "t1", name: "Song" } }] };
      }),
      "spotify_library",
    );
    const result = await tool.handler({ action: "list" }, meta);
    expect(JSON.parse(result as string)).toEqual([{ id: "t1", name: "Song" }]);
  });

  it("uses the albums endpoint when itemType is album", async () => {
    const tool = toolByName(
      fakeClient((_m, path, opts) => {
        expect(path).toBe("/me/albums");
        expect(opts.query).toEqual({ ids: "a1,a2" });
        return {};
      }),
      "spotify_library",
    );
    await tool.handler({ action: "save", itemType: "album", ids: "a1,a2" }, meta);
  });

  it("check returns a map from id to saved-boolean", async () => {
    const tool = toolByName(
      fakeClient((method, path, opts) => {
        expect(method).toBe("GET");
        expect(path).toBe("/me/tracks/contains");
        expect(opts.query).toEqual({ ids: "t1,t2" });
        return [true, false];
      }),
      "spotify_library",
    );
    const result = await tool.handler({ action: "check", ids: "t1,t2" }, meta);
    expect(JSON.parse(result as string)).toEqual({ t1: true, t2: false });
  });

  it("strips a spotify: URI down to its bare id before save/remove/check", async () => {
    const tool = toolByName(
      fakeClient((_m, _p, opts) => {
        expect(opts.query).toEqual({ ids: "abc" });
        return {};
      }),
      "spotify_library",
    );
    await tool.handler({ action: "remove", ids: "spotify:track:abc" }, meta);
  });
});

describe("createSpotifyToolset unavailableReason", () => {
  it("reports no reason (available) when the client is connected", () => {
    const toolset = createSpotifyToolset(fakeClient(() => ({}), { connected: true }));
    for (const reg of toolset) expect(reg.unavailableReason?.()).toBeUndefined();
  });

  it("reports a reason on every tool when the client isn't connected", () => {
    const toolset = createSpotifyToolset(fakeClient(() => ({}), { connected: false }));
    expect(toolset).toHaveLength(3);
    for (const reg of toolset) expect(reg.unavailableReason?.()).toMatch(/not connected/);
  });
});
