import { githubPlugin, initializeGitHubPlugin } from "./github";
import { initializeOpenClawPlugin, openclawPlugin } from "./openclaw";
import { initializeEventSubscriptions, registerPlugin } from "./registry";

export function initializePlugins() {
  console.log("Initializing plugins...");

  registerPlugin(githubPlugin);
  registerPlugin(openclawPlugin);

  initializeGitHubPlugin();
  initializeOpenClawPlugin();

  initializeEventSubscriptions();

  console.log("✅ Plugins initialized");
}

export * from "./registry";
export * from "./types";
