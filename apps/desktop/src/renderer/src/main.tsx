import "./assets/globals.css";
import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { queryClient } from "./lib/daemon.ts";

// The shadcn dark variant keys off the `dark` class; follow the OS scheme so
// the shell and the pierre/shiki code surfaces (themeType: "system") agree.
const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
const applyColorScheme = (): void => {
  document.documentElement.classList.toggle("dark", colorScheme.matches);
};
applyColorScheme();
colorScheme.addEventListener("change", applyColorScheme);

const root = document.getElementById("root");
if (root === null) throw new Error("missing #root element");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
