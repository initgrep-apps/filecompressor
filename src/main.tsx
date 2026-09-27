import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Fatal: #root element missing from index.html — build corrupted");
}
ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);