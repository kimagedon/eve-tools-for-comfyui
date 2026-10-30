import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installSampleExporter } from "./samples";
import { setFilm, setMonochrome } from "./lib/monochrome";
import "./styles.css";

// window.__eveExportProject(id) on a local server only (scripts/export-sample.mjs).
installSampleExporter();

// Every visit starts in the default look (Color, Digital); B&W / Film are per-set choices.
setMonochrome(false);
setFilm(false);

// Browsers keep a per-origin favicon cache (e.g. a dev server's old icon); a fresh
// <link> inserted at run time makes the tab pick up the lens every time.
for (const old of document.querySelectorAll('link[rel="icon"]')) old.remove();
const icon = document.createElement("link");
icon.rel = "icon";
icon.type = "image/png";
icon.href = `${import.meta.env.BASE_URL}favicon.png?v=${Date.now()}`;
document.head.appendChild(icon);

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
