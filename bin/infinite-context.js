#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const hasHelpFlag = argv.includes("--help") || argv.includes("-h");
const hasVersionFlag = argv.includes("--version") || argv.includes("-v");

if (hasHelpFlag) {
  console.log(`infinite-context

Usage:
  npx -y infinite-context [options]

Options:
  -h, --help     Show this help message
  -v, --version  Show CLI version
`);
  process.exit(0);
}

if (hasVersionFlag) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const packageJsonPath = resolve(__dirname, "../package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  console.log(packageJson.version);
  process.exit(0);
}

await import("../dist/index.js");
