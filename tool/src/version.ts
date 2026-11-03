// ABOUTME: The ceremony tool's version, read from package.json.
// ABOUTME: Contributions are refused unless it equals the manifest's requiredToolVersion.

import fs from 'node:fs';
import path from 'node:path';

export const TOOL_VERSION: string = (JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version: string }).version;
