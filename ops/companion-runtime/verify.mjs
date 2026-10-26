import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verify } from '../local-runtime/runtime.mjs';
await verify(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
