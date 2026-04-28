#!/usr/bin/env node
import { loadSettings } from "./config/settings.js";
import { createMemoryStores } from "./memory/create-stores.js";
import { runMcpServer } from "./mcp-server.js";

async function main() {
  const settings = loadSettings();
  const { sqlite, semantic } = createMemoryStores(settings);
  await runMcpServer(settings, sqlite, semantic);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
