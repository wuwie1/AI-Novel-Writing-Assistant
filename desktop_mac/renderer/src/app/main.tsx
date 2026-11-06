import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, matchRoutes, RouterProvider } from "react-router-dom";
import { ThemeProvider } from "@/components/theme/ThemeProvider";
import { Toaster } from "@/components/ui/toast";
import { createAppRoutes } from "@/router";
import { MacWorkspace } from "./MacWorkspace";
import { macPageOverrides, wrapMacRoutes } from "./routes";
import { macEnvironment } from "../platform/native";
import "./base.css";
import "../theme/index.css";
import "../theme/business.css";
import "../features/novels/shelf.css";
import "../features/tasks/records.css";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });
// A data router keeps browser URLs and provides the supported navigation-blocker API.
const routes = wrapMacRoutes(createAppRoutes({ layout: <MacWorkspace />, pageOverrides: macPageOverrides }));
const routeStorageKey = `mac:${macEnvironment()?.backendIdentity}:last-route`;
try {
  const saved = localStorage.getItem(routeStorageKey);
  if (window.location.pathname === "/" && saved?.startsWith("/") && !saved.startsWith("//")) {
    const matches = matchRoutes(routes, saved);
    if (matches?.length && matches.at(-1)?.route.path !== "*") window.history.replaceState(null, "", saved);
  }
} catch { /* An unavailable local preference must not prevent startup. */ }
const router = createBrowserRouter(routes);
router.subscribe(({ location }) => {
  try { localStorage.setItem(routeStorageKey, location.pathname + location.search); } catch { /* Keep the open page usable. */ }
});
const theme = { mode: "light", palette: "paper", density: "compact" } as const;
document.documentElement.dataset.appShell = "mac";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><ThemeProvider storageKey="ai-novel.mac.theme.preference" lockedPreference={theme}>
    <QueryClientProvider client={queryClient}><RouterProvider router={router}/><Toaster/></QueryClientProvider>
  </ThemeProvider></React.StrictMode>,
);
