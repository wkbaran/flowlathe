import { Route, Routes } from "react-router-dom";
import { Canvas } from "./pages/Canvas.js";
import { FlowList } from "./pages/FlowList.js";
import { ProvidersPage } from "./pages/ProvidersPage.js";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<FlowList />} />
      <Route path="/providers" element={<ProvidersPage />} />
      <Route path="/flows/:flowId" element={<Canvas />} />
    </Routes>
  );
}
