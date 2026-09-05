import {
  AppBar,
  Button,
  List,
  ListItemButton,
  ListItemText,
  TextField,
  Toolbar,
  Typography,
} from "@mui/material";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createFlow, listFlows, type FlowSummary } from "../api.js";

export function FlowList() {
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  const [name, setName] = useState("");
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

  return (
    <div>
      <AppBar position="static">
        <Toolbar>
          <Typography variant="h6">flowlathe</Typography>
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
        </div>
        <List>
          {flows.map((flow) => (
            <ListItemButton key={flow.id} onClick={() => navigate(`/flows/${flow.id}`)}>
              <ListItemText primary={flow.name} secondary={flow.updatedAt} />
            </ListItemButton>
          ))}
        </List>
      </div>
    </div>
  );
}
