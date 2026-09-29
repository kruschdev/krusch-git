#!/usr/bin/env node

const nodeVersion = process.versions.node;
const majorVersion = parseInt(nodeVersion.split('.')[0], 10);
if (majorVersion < 22) {
    console.error(`\x1b[31m❌ Error: krusch-git requires Node.js >= 22.0.0.\x1b[0m`);
    console.error(`Current version: v${nodeVersion}. Please upgrade Node before running.`);
    process.exit(1);
}

import '../server/mcp.js';
