#!/usr/bin/env node
import { main } from '../src/server.js';

main().catch((err) => {
  console.error('kenkage-mcp failed to start:', err);
  process.exit(1);
});
