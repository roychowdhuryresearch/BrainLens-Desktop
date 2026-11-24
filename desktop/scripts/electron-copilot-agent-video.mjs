#!/usr/bin/env node
process.env.DEMO_STORY ||= 'agent-driven';
await import('./electron-copilot-demo.mjs');
