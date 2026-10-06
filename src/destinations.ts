// Small curated catalogue so the planner can suggest things to do. Prices are rough per-person amounts in USD.
export interface Activity { name: string; blurb: string; usd: number; slot: 'morning' | 'afternoon' | 'evening' }
export interface Destination { name: string; airport: string; city: string; country: string; country_code: string; aliases: string[]; activities: Activity[] }

export const destinations: Destination[] = [
  { name: 'Cebu', airport: 'CEB', city: 'Cebu', country: 'Philippines', country_code: 'PH', aliases: ['cebu', 'cebu city'], activities: [
    { name: 'Walk through old Cebu City', blurb: "See Magellan's Cross, the Basilica del Santo Niño and Fort San Pedro.", usd: 5, slot: 'afternoon' },
    { name: 'Swim at Kawasan Falls', blurb: 'A full day trip to turquoise waterfalls. Lunch is often included.', usd: 45, slot: 'morning' },
    { name: 'Snorkel with sardines in Moalboal', blurb: 'Float above millions of tiny silver fish, and maybe spot a turtle.', usd: 30, slot: 'morning' },
    { name: 'Island hopping near Mactan', blurb: 'A small boat ride to beaches and clear water for swimming.', usd: 40, slot: 'morning' },
    { name: 'Taste Cebu lechon', blurb: "Cebu's famous crispy roast pork. Locals love it.", usd: 10, slot: 'evening' },
    { name: 'Sunset at Tops Lookout', blurb: 'A hilltop view over the whole city and the sea.', usd: 3, slot: 'evening' },
    { name: 'Visit the Taoist Temple', blurb: 'A colourful temple with great views, free to enter.', usd: 0, slot: 'afternoon' },
  ] },
  { name: 'Bangkok', airport: 'BKK', city: 'Bangkok', country: 'Thailand', country_code: 'TH', aliases: ['bangkok'], activities: [
    { name: 'Grand Palace and Wat Pho', blurb: 'Golden temples and the giant reclining Buddha.', usd: 20, slot: 'morning' },
    { name: 'Boat ride on the river', blurb: 'See the city from the water on a public ferry.', usd: 2, slot: 'afternoon' },
    { name: 'Street food at Chinatown', blurb: 'Noodles, mango sticky rice and more after dark.', usd: 12, slot: 'evening' },
    { name: 'Chatuchak weekend market', blurb: 'Thousands of stalls for gifts, snacks and clothes.', usd: 10, slot: 'morning' },
    { name: 'Thai cooking class', blurb: 'Learn to cook pad thai and green curry.', usd: 35, slot: 'afternoon' },
  ] },
  { name: 'Singapore', airport: 'SIN', city: 'Singapore', country: 'Singapore', country_code: 'SG', aliases: ['singapore'], activities: [
    { name: 'Gardens by the Bay', blurb: 'Giant glowing trees and the cloud forest dome.', usd: 18, slot: 'afternoon' },
    { name: 'Hawker centre dinner', blurb: 'Chicken rice, laksa and satay at small prices.', usd: 8, slot: 'evening' },
    { name: 'Singapore Zoo and River Wonders', blurb: 'A zoo with animals in open, natural homes.', usd: 35, slot: 'morning' },
    { name: 'Sentosa beach day', blurb: 'Sand, sea and rides on a small island.', usd: 15, slot: 'morning' },
    { name: 'Walk the Marina Bay light show', blurb: 'A free night show over the water.', usd: 0, slot: 'evening' },
  ] },
  { name: 'Bali', airport: 'DPS', city: 'Denpasar', country: 'Indonesia', country_code: 'ID', aliases: ['bali', 'denpasar'], activities: [
    { name: 'Ubud rice terraces', blurb: 'Green steps of rice fields and a short walk.', usd: 8, slot: 'morning' },
    { name: 'Uluwatu temple at sunset', blurb: 'A cliff-top temple with sea views and a dance show.', usd: 12, slot: 'evening' },
    { name: 'Beach afternoon in Seminyak', blurb: 'Relax, swim and watch the waves.', usd: 0, slot: 'afternoon' },
    { name: 'Monkey Forest in Ubud', blurb: 'Meet friendly monkeys in a shady forest.', usd: 7, slot: 'morning' },
    { name: 'Balinese cooking class', blurb: 'Shop at the market, then cook your lunch.', usd: 30, slot: 'afternoon' },
  ] },
  { name: 'Manila', airport: 'MNL', city: 'Manila', country: 'Philippines', country_code: 'PH', aliases: ['manila'], activities: [
    { name: 'Walk Intramuros', blurb: 'The old walled city with stone streets and churches.', usd: 5, slot: 'morning' },
    { name: 'Rizal Park stroll', blurb: 'Green park by the bay, free to enter.', usd: 0, slot: 'afternoon' },
    { name: 'Sunset on Manila Bay', blurb: 'One of the most famous sunsets in Asia.', usd: 0, slot: 'evening' },
    { name: 'Food crawl in Binondo', blurb: "The world's oldest Chinatown: dumplings, noodles, sweets.", usd: 15, slot: 'evening' },
  ] },
];

export const findDestination = (text: string) => {
  const lower = text.toLowerCase();
  return destinations
    .flatMap(d => d.aliases.map(alias => ({ d, alias, at: lower.search(new RegExp(`\\b${alias}\\b`)) })))
    .filter(m => m.at >= 0).sort((a, b) => a.at - b.at || b.alias.length - a.alias.length);
};
