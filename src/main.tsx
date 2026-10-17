import React from "react";
import ReactDOM from "react-dom/client";
import { AppShell } from "./ui/shell/AppShell";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppShell />
  </React.StrictMode>,
);
  