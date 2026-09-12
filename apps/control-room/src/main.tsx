import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.js";
import { createMockControlRoomClient } from "./services/mock-client.js";
import "./styles.css";
// Composition root: replace this client with a local API or desktop IPC adapter.
const client = createMockControlRoomClient();
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App client={client} />
  </React.StrictMode>,
);
