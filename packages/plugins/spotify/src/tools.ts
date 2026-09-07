import type { ToolRegistration, ToolSpec } from "@flowlathe/core";
import { asStringArray, clampLimit, requireString } from "@flowlathe/plugin-common";
import { SpotifyClient, SpotifyError } from "./client.js";

/** Spotify accepts either a bare id or a full "spotify:track:<id>"/URL form in most places, but
 *  the tracks/playlist-items "add" endpoint specifically wants URIs — normalize ids up to that. */
function toUri(kind: "track" | "album" | "playlist", value: string): string {
  if (value.startsWith("spotify:")) return value;
  const match = value.match(/open\.spotify\.com\/(?:[a-z-]+\/)?(?:track|album|playlist)\/([A-Za-z0-9]+)/);
  const id = match ? match[1] : value;
  return `spotify:${kind}:${id}`;
}

function idFromUriOrId(value: string): string {
  const parts = value.split(":");
  return parts[parts.length - 1] ?? value;
}

async function currentUserId(client: SpotifyClient): Promise<string> {
  const me = await client.request<{ id: string }>("GET", "/me");
  return me.id;
}

function toolError(err: unknown): string {
  return `error: ${err instanceof Error ? err.message : String(err)}`;
}

export const SPOTIFY_SEARCH_TOOL: ToolSpec = {
  name: "spotify_search",
  description: "Search Spotify for tracks, artists, albums, or playlists.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "search text" },
      types: {
        type: "string",
        description: 'comma-separated subset of "track,artist,album,playlist" (default: "track")',
      },
      limit: { type: "number", description: "max results, 1-50 (default 20)" },
    },
    required: ["query"],
  },
};

interface SpotifySearchResult {
  id: string;
  name: string;
  uri: string;
  artists?: { name: string }[];
}
interface SpotifySearchResponse {
  tracks?: { items: SpotifySearchResult[] };
  artists?: { items: SpotifySearchResult[] };
  albums?: { items: SpotifySearchResult[] };
  playlists?: { items: SpotifySearchResult[] };
}

/** Spotify's search response only includes keys for the types actually requested — mirror that
 *  rather than always emitting all four, so a caller that searched just "track" doesn't have to
 *  filter out empty artists/albums/playlists arrays. */
function summarizeSearchResults(response: SpotifySearchResponse): Record<string, unknown[]> {
  const summary: Record<string, unknown[]> = {};
  for (const key of Object.keys(response) as (keyof SpotifySearchResponse)[]) {
    const page = response[key];
    summary[key] = (page?.items ?? []).map((item) => ({
      id: item.id,
      name: item.name,
      uri: item.uri,
      artists: item.artists?.map((a) => a.name),
    }));
  }
  return summary;
}

function spotifySearchTool(client: SpotifyClient): ToolRegistration {
  return {
    toolset: "spotify",
    spec: SPOTIFY_SEARCH_TOOL,
    handler: async (args) => {
      try {
        const query = requireString(args, "query");
        const types = asStringArray(args["types"]);
        const response = await client.request<SpotifySearchResponse>("GET", "/search", {
          query: { q: query, type: (types.length > 0 ? types : ["track"]).join(","), limit: clampLimit(args["limit"]) },
        });
        return JSON.stringify(summarizeSearchResults(response));
      } catch (err) {
        return toolError(err);
      }
    },
  };
}

export const SPOTIFY_PLAYLISTS_TOOL: ToolSpec = {
  name: "spotify_playlists",
  description:
    "Manage the current user's Spotify playlists. Actions: list, get, create, add_tracks, remove_tracks.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", description: "list | get | create | add_tracks | remove_tracks" },
      playlistId: { type: "string", description: "required for get, add_tracks, remove_tracks" },
      name: { type: "string", description: "required for create" },
      description: { type: "string", description: "optional, for create" },
      public: { type: "boolean", description: "optional, for create (default false)" },
      trackUris: {
        type: "string",
        description: "for add_tracks/remove_tracks: track ids/URIs, as a JSON array or comma-separated list",
      },
      limit: { type: "number", description: "for list/get, max results 1-50 (default 20)" },
    },
    required: ["action"],
  },
};

interface SpotifyPlaylistSummary {
  id: string;
  name: string;
  uri: string;
  tracksTotal?: number;
}

function spotifyPlaylistsTool(client: SpotifyClient): ToolRegistration {
  return {
    toolset: "spotify",
    spec: SPOTIFY_PLAYLISTS_TOOL,
    handler: async (args) => {
      try {
        const action = requireString(args, "action");
        switch (action) {
          case "list": {
            const page = await client.request<{ items: (SpotifyPlaylistSummary & { tracks: { total: number } })[] }>(
              "GET",
              "/me/playlists",
              { query: { limit: clampLimit(args["limit"]) } },
            );
            return JSON.stringify(
              page.items.map((p) => ({ id: p.id, name: p.name, uri: p.uri, tracksTotal: p.tracks.total })),
            );
          }
          case "get": {
            const playlistId = idFromUriOrId(requireString(args, "playlistId"));
            const page = await client.request<{ items: { track: { id: string; name: string; uri: string } | null }[] }>(
              "GET",
              `/playlists/${playlistId}/tracks`,
              { query: { limit: clampLimit(args["limit"]) } },
            );
            return JSON.stringify(
              page.items.filter((i) => i.track !== null).map((i) => ({ id: i.track!.id, name: i.track!.name, uri: i.track!.uri })),
            );
          }
          case "create": {
            const name = requireString(args, "name");
            const userId = await currentUserId(client);
            const created = await client.request<SpotifyPlaylistSummary>("POST", `/users/${userId}/playlists`, {
              body: { name, description: args["description"], public: args["public"] === true },
            });
            return JSON.stringify({ id: created.id, name: created.name, uri: created.uri });
          }
          case "add_tracks": {
            const playlistId = idFromUriOrId(requireString(args, "playlistId"));
            const uris = asStringArray(args["trackUris"]).map((v) => toUri("track", v));
            if (uris.length === 0) throw new SpotifyError('add_tracks requires a non-empty "trackUris"');
            await client.request("POST", `/playlists/${playlistId}/tracks`, { body: { uris } });
            return `added ${uris.length} track(s) to playlist ${playlistId}`;
          }
          case "remove_tracks": {
            const playlistId = idFromUriOrId(requireString(args, "playlistId"));
            const uris = asStringArray(args["trackUris"]).map((v) => toUri("track", v));
            if (uris.length === 0) throw new SpotifyError('remove_tracks requires a non-empty "trackUris"');
            await client.request("DELETE", `/playlists/${playlistId}/tracks`, {
              body: { tracks: uris.map((uri) => ({ uri })) },
            });
            return `removed ${uris.length} track(s) from playlist ${playlistId}`;
          }
          default:
            throw new SpotifyError(`unknown action "${action}"`);
        }
      } catch (err) {
        return toolError(err);
      }
    },
  };
}

export const SPOTIFY_LIBRARY_TOOL: ToolSpec = {
  name: "spotify_library",
  description: "Manage the current user's saved (\"liked\") tracks or albums. Actions: list, save, remove, check.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", description: "list | save | remove | check" },
      itemType: { type: "string", description: '"track" or "album" (default: "track")' },
      ids: { type: "string", description: "for save/remove/check: ids/URIs, as a JSON array or comma-separated list" },
      limit: { type: "number", description: "for list, max results 1-50 (default 20)" },
    },
    required: ["action"],
  },
};

function spotifyLibraryTool(client: SpotifyClient): ToolRegistration {
  return {
    toolset: "spotify",
    spec: SPOTIFY_LIBRARY_TOOL,
    handler: async (args) => {
      try {
        const action = requireString(args, "action");
        const itemType = args["itemType"] === "album" ? "album" : "track";
        const basePath = itemType === "album" ? "/me/albums" : "/me/tracks";
        switch (action) {
          case "list": {
            const page = await client.request<{ items: { track?: { id: string; name: string }; album?: { id: string; name: string } }[] }>(
              "GET",
              basePath,
              { query: { limit: clampLimit(args["limit"]) } },
            );
            return JSON.stringify(page.items.map((i) => i.track ?? i.album));
          }
          case "save": {
            const ids = asStringArray(args["ids"]).map(idFromUriOrId);
            if (ids.length === 0) throw new SpotifyError('save requires a non-empty "ids"');
            await client.request("PUT", basePath, { query: { ids: ids.join(",") } });
            return `saved ${ids.length} ${itemType}(s)`;
          }
          case "remove": {
            const ids = asStringArray(args["ids"]).map(idFromUriOrId);
            if (ids.length === 0) throw new SpotifyError('remove requires a non-empty "ids"');
            await client.request("DELETE", basePath, { query: { ids: ids.join(",") } });
            return `removed ${ids.length} ${itemType}(s)`;
          }
          case "check": {
            const ids = asStringArray(args["ids"]).map(idFromUriOrId);
            if (ids.length === 0) throw new SpotifyError('check requires a non-empty "ids"');
            const result = await client.request<boolean[]>("GET", `${basePath}/contains`, { query: { ids: ids.join(",") } });
            return JSON.stringify(Object.fromEntries(ids.map((id, i) => [id, result[i] ?? false])));
          }
          default:
            throw new SpotifyError(`unknown action "${action}"`);
        }
      } catch (err) {
        return toolError(err);
      }
    },
  };
}

/** Shared by all three tools: none of them can do anything useful without a connected account,
 *  so a single reason-check applied uniformly here (rather than repeated in each tool factory)
 *  is what a workflow-level dependency check (see @flowlathe/core's findMissingToolsets) reports
 *  back to a flow author as "why is Spotify missing." */
function unavailableReason(client: SpotifyClient): () => string | undefined {
  return () => (client.isConnected() ? undefined : "Spotify is not connected — connect it from Providers");
}

export function createSpotifyToolset(client: SpotifyClient): ToolRegistration[] {
  const reason = unavailableReason(client);
  return [spotifySearchTool(client), spotifyPlaylistsTool(client), spotifyLibraryTool(client)].map((reg) => ({
    ...reg,
    unavailableReason: reason,
  }));
}
