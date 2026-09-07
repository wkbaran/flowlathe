import type { PluginManifest } from "@flowlathe/core";

/** Static — doesn't depend on whether SPOTIFY_CLIENT_ID is actually set, so the server can
 *  report this plugin's display name and setup instructions even when unconfigured (see
 *  PLAN-INTEGRATIONS.md §2.3 and `routes/plugins.ts`). */
export const SPOTIFY_MANIFEST: PluginManifest = {
  toolset: "spotify",
  displayName: "Spotify",
  description: "Search and manage the current user's Spotify library and playlists.",
  env: [
    {
      name: "SPOTIFY_CLIENT_ID",
      description: "OAuth client id from a Spotify Developer Dashboard app",
      required: true,
      secret: false,
      docsUrl: "https://developer.spotify.com/documentation/web-api/concepts/apps",
    },
    {
      name: "SPOTIFY_REDIRECT_URI",
      description: "OAuth redirect URI (defaults to this server's own callback route)",
      required: false,
      secret: false,
    },
  ],
  connect: { startPath: "/api/plugins/spotify/oauth/start", disconnectPath: "/api/plugins/spotify/disconnect" },
};
