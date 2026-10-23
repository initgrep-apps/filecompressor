// Yard — offline batch file compression
// Copyright (C) 2026 Yard Contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

import "@fontsource-variable/inter";
import "./index.css";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { detectPlatform } from "./lib/platform";
import { PlatformProvider } from "./providers/PlatformProvider";

document.documentElement.classList.toggle(
  "dark",
  window.matchMedia("(prefers-color-scheme: dark)").matches,
);

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Fatal: #root element missing from index.html — build corrupted");
}
const platform = detectPlatform();
ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <ErrorBoundary>
      <PlatformProvider platform={platform}>
        <App />
      </PlatformProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
