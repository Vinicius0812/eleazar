import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.js";
import { createHttpControlRoomClient } from "./services/http-client.js";
import "./styles.css";
const client = createHttpControlRoomClient();
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App client={client} />
  </React.StrictMode>,
);
