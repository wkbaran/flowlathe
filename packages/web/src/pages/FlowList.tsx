import {
  Alert,
  AppBar,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  List,
  ListItemButton,
  ListItemText,
  TextField,
  Toolbar,
  Typography,
} from "@mui/material";
import { useEffect, useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import { createFlow, importFlowText, listFlows, type FlowSummary } from "../api.js";

export function FlowList() {
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  const [name, setName] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    listFlows().then(setFlows);
  }, []);

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) return;
    const flow = await createFlow(trimmed);
    navigate(`/flows/${flow.id}`);
  }

  /** Paste-to-import (PLAN-FLOW-DSL.md S4): pasted `.flow` text becomes a real flow via the same
   *  `POST /api/flows/import` a `flowlathe flows import` run against a real file would hit. */
  async function handleImport() {
    setImportError(null);
    try {
      const flow = await importFlowText(importText);
      setImportOpen(false);
      setImportText("");
      navigate(`/flows/${flow.id}`);
    } catch (err) {
      setImportError((err as Error).message);
    }
  }

  return (
    <div>
      <AppBar position="static">
        <Toolbar>
          <Typography variant="h6" sx={{ flexGrow: 1 }}>
            flowlathe
          </Typography>
          <Button color="inherit" component={RouterLink} to="/providers">
            Providers
          </Button>
        </Toolbar>
      </AppBar>
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 16, maxWidth: 480 }}>
        <div style={{ display: "flex", gap: 8 }}>
          <TextField
            label="New flow name"
            size="small"
            value={name}
            onChange={(e) => setName(e.target.value)}
            slotProps={{ htmlInput: { "aria-label": "New flow name" } }}
          />
          <Button variant="contained" onClick={handleCreate}>
            New Flow
          </Button>
          <Button variant="outlined" onClick={() => setImportOpen(true)}>
            Import from text
          </Button>
        </div>
        <List>
          {flows.map((flow) => (
            <ListItemButton key={flow.id} onClick={() => navigate(`/flows/${flow.id}`)}>
              <ListItemText primary={flow.name} secondary={flow.updatedAt} />
            </ListItemButton>
          ))}
        </List>
      </div>
      <Dialog open={importOpen} onClose={() => setImportOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Import a flow from DSL text</DialogTitle>
        <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
          <Typography variant="body2" color="text.secondary">
            Paste a <code>.flow</code> file's contents. A name matching an existing flow saves a new version of it;
            otherwise a new flow is created.
          </Typography>
          <TextField
            multiline
            minRows={10}
            fullWidth
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            slotProps={{ htmlInput: { "aria-label": "Flow DSL text to import", spellCheck: false } }}
            sx={{ fontFamily: "monospace", "& textarea": { fontFamily: "monospace" } }}
          />
          {importError && <Alert severity="error">{importError}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setImportOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={() => void handleImport()} disabled={!importText.trim()}>
            Import
          </Button>
        </DialogActions>
      </Dialog>
    </div>
  );
}
