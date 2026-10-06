import { writeFile } from 'node:fs/promises';
import { buildApp } from '../src/app.js';
import { getConfig } from '../src/config.js';
import { withSearchExamples } from '../src/openapi-examples.js';
const { app } = await buildApp(getConfig({ DATA_PATH: ':memory:' }), { poll: false });
await writeFile('docs/openapi.json', JSON.stringify(withSearchExamples(app.swagger()), null, 2) + '\n');
await app.close();
console.log('Wrote docs/openapi.json');
