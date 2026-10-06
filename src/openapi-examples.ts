// Build fresh dates for every documentation request, including warm deployments.
export function searchExamples(now = Date.now()) {
  const day = (offset: number) => new Date(now + offset * 86400000).toISOString().slice(0, 10);
  const flights = { slices: [{ origin: 'SIN', destination: 'BKK', departure_date: day(30) }], passengers: [{ type: 'adult' }], cabin_class: 'economy', max_connections: 1 };
  const stays = { check_in_date: day(30), check_out_date: day(33), rooms: [{ adults: 2 }], location: { city: 'Bangkok', country_code: 'TH' }, currency: 'USD', guest_nationality: 'US', limit: 5 };
  return { '/v1/flights/search': flights, '/v1/stays/search': stays, '/v1/trips/search': { flights, stays } };
}

export function withSearchExamples<T>(document: T): T {
  const spec: any = structuredClone(document);
  for (const [path, example] of Object.entries(searchExamples())) {
    const operation = spec.paths?.[path]?.post;
    if (!operation) continue;
    const media = operation.requestBody.content['application/json'];
    media.example = example;
    operation.description = (path === '/v1/stays/search'
      ? 'Search Bangkok for two adults over three nights. Check-out must be after check-in. '
      : 'Search Singapore to Bangkok with future travel dates. ') +
      'The example dates refresh daily. Results come from the configured supplier; provider and environment identify production or sandbox data. Availability and prices can change.';
    for (const [code, description] of Object.entries({ 400: 'Invalid input, including past dates or check-out on/before check-in.', 429: 'Request or supplier rate limit exceeded.', 502: 'Supplier rejected the request or returned an invalid response.', 503: 'Supplier credentials are not configured.', 504: 'Supplier did not respond before the timeout.' })) {
      operation.responses[code] = { description, content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} }, required: ['code', 'message'] } }, required: ['error'] } } } };
    }
  }
  return spec;
}
