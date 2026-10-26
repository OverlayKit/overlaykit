import { cleanup, privateJson, settings } from './core.mjs';
try { cleanup(settings(await privateJson(process.argv[2]))); }
catch { console.error('owned-container-cleanup-failed'); process.exitCode = 1; }
