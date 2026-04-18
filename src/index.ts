#!/usr/bin/env node
import { loadSettings } from "./config/settings.js";
import { SqliteMemoryStore } from "./memory/sqlite-store.js";
import { SemanticMemoryStore } from "./memory/semantic-store.js";
import { runMcpServer } from "./mcp-server.js";

async function main() {
  const settings = loadSettings();
  const sqlite = new SqliteMemoryStore(settings.dataDir);
  const semantic = SemanticMemoryStore.fromSettings(settings);
  await runMcpServer(settings, sqlite, semantic);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
