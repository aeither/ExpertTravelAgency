import { readFile } from 'node:fs/promises';
import './extractor.js';

const [file, url] = process.argv.slice(2);
if (!file || !url) {
  console.error('Usage: node scripts/trip-public/parse.mjs saved-page.html https://www.trip.com/hotels/...');
  process.exitCode = 1;
} else {
  try {
    const result = globalThis.TripPublicResearch.extract(await readFile(file, 'utf8'), { url });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
