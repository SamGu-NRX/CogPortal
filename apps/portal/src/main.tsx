import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@fontsource-variable/source-serif-4/index.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles/app.css";

import { App } from "./App";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error('Could not start the app: the page has no element with id "root".');
}
createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
