import React from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import { App } from "./App";
import { connect } from "./store";
import { applyOff, runDiag } from "./diag";

connect();
const params = new URLSearchParams(location.search);
if (params.get("off")) applyOff(params.get("off")!.split(","));
if (params.has("diag")) runDiag();
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
