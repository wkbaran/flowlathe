import {
  AppBar,
  Box,
  Button,
  Chip,
  Divider,
  IconButton,
  List,
  ListItem,
  ListItemText,
  MenuItem,
  Paper,
  Select,
  TextField,
  Toolbar,
  Typography,
} from "@mui/material";
import { useEffect, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import {
  createModel,
  createProvider,
  deleteModel,
  deleteProvider,
  disconnectSpotify,
  getSchedulerStats,
  getSpotifyStatus,
  listModels,
  listProviders,
  type ModelRecord,
  type ProviderKind,
  type ProviderRecord,
  type SchedulerStats,
  type SpotifyPluginStatus,
} from "../api.js";

const KINDS: ProviderKind[] = ["mock", "ollama", "openai-compat"];

export function ProvidersPage() {
  const [providers, setProviders] = useState<ProviderRecord[]>([]);
  const [stats, setStats] = useState<Record<string, SchedulerStats>>({});
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, ModelRecord[]>>({});
  const [spotifyStatus, setSpotifyStatus] = useState<SpotifyPluginStatus>({ configured: false, connected: false });

  const [name, setName] = useState("");
  const [kind, setKind] = useState<ProviderKind>("openai-compat");
  const [baseUrl, setBaseUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [swapCostMs, setSwapCostMs] = useState("");

  const [newModelName, setNewModelName] = useState<Record<string, string>>({});

  async function refresh() {
    const list = await listProviders();
    setProviders(list);
    const entries = await Promise.all(list.map(async (p) => [p.id, await listModels(p.id)] as const));
    setModelsByProvider(Object.fromEntries(entries));
  }

  useEffect(() => {
    void refresh();
    void getSpotifyStatus().then(setSpotifyStatus);
    const interval = setInterval(() => void getSchedulerStats().then(setStats), 2000);
    return () => clearInterval(interval);
  }, []);

  async function handleDisconnectSpotify() {
    await disconnectSpotify();
    setSpotifyStatus(await getSpotifyStatus());
  }

  async function handleCreateProvider() {
    if (!name.trim()) return;
    await createProvider({
      name: name.trim(),
      kind,
      baseUrl: baseUrl.trim() || undefined,
      secret: secret.trim() || undefined,
      swapCostMs: swapCostMs.trim() ? Number(swapCostMs) : undefined,
    });
    setName("");
    setBaseUrl("");
    setSecret("");
    setSwapCostMs("");
    await refresh();
  }

  async function handleDeleteProvider(id: string) {
    await deleteProvider(id);
    await refresh();
  }

  async function handleAddModel(providerId: string) {
    const modelName = (newModelName[providerId] ?? "").trim();
    if (!modelName) return;
    await createModel(providerId, modelName);
    setNewModelName((prev) => ({ ...prev, [providerId]: "" }));
    await refresh();
  }

  return (
    <div>
      <AppBar position="static">
        <Toolbar>
          <Typography variant="h6" sx={{ flexGrow: 1 }}>
            Providers
          </Typography>
          <Button color="inherit" component={RouterLink} to="/">
            Flows
          </Button>
        </Toolbar>
      </AppBar>
      <Box sx={{ p: 2, display: "flex", flexDirection: "column", gap: 2, maxWidth: 720 }}>
        <Paper sx={{ p: 2 }}>
          <Typography variant="subtitle1">New provider</Typography>
          <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", mt: 1, alignItems: "center" }}>
            <TextField size="small" label="Name" value={name} onChange={(e) => setName(e.target.value)} />
            <Select size="small" value={kind} onChange={(e) => setKind(e.target.value as ProviderKind)}>
              {KINDS.map((k) => (
                <MenuItem key={k} value={k}>
                  {k}
                </MenuItem>
              ))}
            </Select>
            <TextField
              size="small"
              label="Base URL"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              disabled={kind === "mock"}
            />
            <TextField
              size="small"
              label="Secret (API key)"
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              disabled={kind === "mock"}
            />
            <TextField
              size="small"
              label="Swap cost (ms)"
              value={swapCostMs}
              onChange={(e) => setSwapCostMs(e.target.value)}
              disabled={kind !== "ollama"}
              helperText="local models only"
            />
            <Button variant="contained" onClick={handleCreateProvider}>
              Add
            </Button>
          </Box>
        </Paper>

        {providers.map((provider) => {
          const providerStats = stats[provider.id];
          return (
            <Paper key={provider.id} sx={{ p: 2 }} data-testid={`provider-${provider.name}`}>
              <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                <Typography variant="subtitle1" sx={{ flexGrow: 1 }}>
                  {provider.name}
                </Typography>
                <Chip size="small" label={provider.kind} />
                {provider.hasSecret && <Chip size="small" label="secret set" color="success" />}
                <IconButton size="small" onClick={() => void handleDeleteProvider(provider.id)} aria-label="delete">
                  ✕
                </IconButton>
              </Box>
              {provider.baseUrl && (
                <Typography variant="body2" color="text.secondary">
                  {provider.baseUrl}
                </Typography>
              )}
              {providerStats && (
                <Box sx={{ mt: 1, display: "flex", gap: 2, flexWrap: "wrap" }}>
                  <Typography variant="caption">swaps: {providerStats.swapCount}</Typography>
                  {Object.entries(providerStats.models).map(([modelId, m]) => (
                    <Typography variant="caption" key={modelId}>
                      {modelId}: queue={m.queueDepth} p50={Math.round(m.waitMsP50)}ms
                    </Typography>
                  ))}
                </Box>
              )}
              <Divider sx={{ my: 1 }} />
              <List dense>
                {(modelsByProvider[provider.id] ?? []).map((model) => (
                  <ListItem
                    key={model.id}
                    secondaryAction={
                      <IconButton size="small" onClick={() => void deleteModel(model.id).then(refresh)}>
                        ✕
                      </IconButton>
                    }
                  >
                    <ListItemText primary={model.modelName} />
                  </ListItem>
                ))}
              </List>
              <Box sx={{ display: "flex", gap: 1 }}>
                <TextField
                  size="small"
                  label="Model name"
                  value={newModelName[provider.id] ?? ""}
                  onChange={(e) => setNewModelName((prev) => ({ ...prev, [provider.id]: e.target.value }))}
                />
                <Button size="small" onClick={() => void handleAddModel(provider.id)}>
                  Add model
                </Button>
              </Box>
            </Paper>
          );
        })}

        <Paper sx={{ p: 2 }} data-testid="plugin-spotify">
          <Typography variant="subtitle1">Plugins</Typography>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, mt: 1 }}>
            <Typography variant="body2" sx={{ flexGrow: 1 }}>
              Spotify
            </Typography>
            {!spotifyStatus.configured && <Chip size="small" label="not configured" />}
            {spotifyStatus.configured && spotifyStatus.connected && (
              <Chip size="small" label="connected" color="success" />
            )}
            {spotifyStatus.configured && !spotifyStatus.connected && <Chip size="small" label="not connected" />}
            {spotifyStatus.configured && !spotifyStatus.connected && (
              <Button size="small" variant="contained" href="/api/plugins/spotify/oauth/start">
                Connect
              </Button>
            )}
            {spotifyStatus.configured && spotifyStatus.connected && (
              <Button size="small" onClick={() => void handleDisconnectSpotify()}>
                Disconnect
              </Button>
            )}
          </Box>
          {!spotifyStatus.configured && (
            <Typography variant="caption" color="text.secondary">
              Set SPOTIFY_CLIENT_ID (and optionally SPOTIFY_REDIRECT_URI) on the server to enable this plugin.
            </Typography>
          )}
        </Paper>
      </Box>
    </div>
  );
}
