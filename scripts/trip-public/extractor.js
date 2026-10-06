/* Paste into a Trip.com page's DevTools console, or import from Node.
 * Pure parser: never executes captured scripts and never sends requests.
 */
(() => {
  'use strict';
  const array = v => Array.isArray(v) ? v : [];
  const number = v => v !== '' && v != null && Number.isFinite(Number(v)) ? Number(v) : null;
  const pick = (v, keys) => Object.fromEntries(keys.filter(k => v?.[k] !== undefined).map(k => [k, v[k]]));
  const image = v => {
    try { const u = new URL(v); return u.protocol === 'https:' && u.hostname.endsWith('.tripcdn.com') ? u.href : null; }
    catch { return null; }
  };
  function texts(v, depth = 0) {
    if (!v || typeof v !== 'object' || depth > 12) return [];
    return Object.entries(v).flatMap(([k, x]) =>
      ['title', 'description', 'content', 'text', 'bold'].includes(k) && typeof x === 'string'
        ? [x] : texts(x, depth + 1));
  }
  function facilities(v, depth = 0) {
    if (!v || typeof v !== 'object' || depth > 12) return [];
    if (typeof v.facilityDesc === 'string') return [{
      name: v.facilityDesc, feeLabel: v.showTitle || null,
      details: array(v.facilityInfo).map(x => ({ title: x.title, text: array(x.text) }))
    }];
    return Object.values(v).flatMap(x => facilities(x, depth + 1));
  }
  function pageProps(v, depth = 0) {
    if (!v || typeof v !== 'object' || depth > 8) return null;
    if (v.hotelDetailResponse?.hotelBaseInfo) return v;
    for (const x of Object.values(v)) { const result = pageProps(x, depth + 1); if (result) return result; }
    return null;
  }
  function parse(html) {
    if (typeof html !== 'string' || html.length > 15_000_000) throw new Error('Expected HTML under 15 MB');
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
    const jsonld = [], diagnostics = [];
    let stream = '', state = null;
    for (const [, attrs, body] of scripts) {
      if (/type\s*=\s*["']application\/ld\+json["']/i.test(attrs)) {
        try { jsonld.push(JSON.parse(body)); } catch { diagnostics.push('Malformed JSON-LD'); }
      }
      if (/id\s*=\s*["']__NEXT_DATA__["']/i.test(attrs)) {
        try { state ||= pageProps(JSON.parse(body)); } catch { diagnostics.push('Malformed __NEXT_DATA__'); }
      }
      // Match only a complete literal array argument. No eval / Function / VM.
      const m = body.trim().match(/^(?:\(self\.__next_f=self\.__next_f\|\|\[\]\)|self\.__next_f)\.push\((\[[\s\S]*\])\)\s*;?$/);
      if (m) {
        try { const chunk = JSON.parse(m[1]); if (chunk[0] === 1 && typeof chunk[1] === 'string') stream += chunk[1]; }
        catch { diagnostics.push('Unsupported hydration chunk'); }
      }
    }
    for (const line of stream.split('\n')) {
      const m = line.match(/^J[^:]+:(.*)$/);
      if (m) { try { state ||= pageProps(JSON.parse(m[1])); } catch { diagnostics.push('Unsupported hydration record'); } }
    }
    return { state, jsonld, diagnostics };
  }
  function normalize(state, url) {
    const h = state.hotelDetailResponse, b = h.hotelBaseInfo, p = h.hotelPositionInfo || {};
    const c = state.hotelCommentResponse?.commentRating || {};
    const dimensions = ['Location', 'Facility', 'Service', 'Room'].map(key => ({
      label: c[`rating${key}ShowItem`] || key,
      value: number(c[`rating${key}`]),
      sameTypeAverageReported: number(c[`rating${key}Ext`]?.sameTypeAvg)
    }));
    const uniqueFacilities = new Map(facilities(h.hotelFacilityPopV2).map(x => [x.name, x]));
    const roomMap = state.seoSSRData?.seoHotelRooms?.physicRoomMap || {};
    return {
      sourceUrl: url, source: 'Trip.com public frontend hydration',
      id: String(b.masterHotelId), name: b.nameInfo?.name, stars: number(b.starInfo?.level),
      city: b.cityName, country: b.countryName, openedYear: b.openYear,
      address: p.addressVisible === true ? p.address : null,
      coordinates: p.preciseCoordinatesVisible === true ? { latitude: number(p.lat), longitude: number(p.lng) } : null,
      neighborhood: p.zoneName, transit: p.trafficInfo?.trafficDesc,
      nearby: array(p.placeInfo?.wholePoiInfoList).map(x => pick(x, ['poiName', 'descWithType', 'distance', 'distType'])),
      photos: [...new Set(array(h.hotelTopImage?.imgUrlList).map(x => image(x.imgUrl)).filter(Boolean))],
      topImageCountReported: number(h.hotelTopImage?.total), description: h.hotelDescriptionInfo?.description,
      amenities: [...uniqueFacilities.values()],
      policies: Object.fromEntries(['checkInAndOut', 'childPolicy', 'cribAndExtraBed', 'breakfast', 'deposit', 'pet', 'ageLimit']
        .filter(k => h.hotelPolicyInfo?.[k]).map(k => [k, [...new Set(texts(h.hotelPolicyInfo[k]))]])),
      rating: { value: number(c.ratingAll), scale: number(c.fullRating), reviewCount: number(c.showCommentNum), dimensions },
      rooms: Object.values(roomMap).map(r => ({
        id: String(r.id), name: r.name, personCapacityReported: number(r.person), childCapacityReported: number(r.children),
        beds: r.bedInfo?.title, area: r.areaInfo?.title, floor: r.floorInfo?.title,
        window: r.windowInfo?.title, smoking: r.smokeInfo?.title,
        amenities: array(r.baseFacilityInfo).map(x => x.name || x.title),
        photos: array(r.pictureInfo).map(x => image(x.url)).filter(Boolean)
      })),
      rates: [], rateStatus: 'not_extracted',
      rateEvidence: { embeddedResponsePresent: Object.keys(state.ssrHotelRoomListResponse || {}).length > 0,
        search: pick(state.ssrHotelRoomListRequest?.search, ['checkIn', 'checkOut', 'roomQuantity', 'adult']) }
    };
  }
  function extract(html, { url, observedAt = new Date().toISOString(), access = 'saved_page_unknown_session' } = {}) {
    const { state, jsonld, diagnostics } = parse(html);
    const hotels = [];
    const walk = v => {
      if (!v || typeof v !== 'object') return;
      if (v['@type'] === 'Hotel') hotels.push(v);
      else for (const x of Object.values(v)) walk(x);
    };
    jsonld.forEach(walk);
    const results = state ? [normalize(state, url)] : hotels.map(h => ({
      sourceUrl: url, source: 'Trip.com public JSON-LD', id: h.url?.match(/hotel-detail-(\d+)/)?.[1] || null,
      name: h.name, url: h.url, stars: number(h.starRating?.ratingValue),
      photos: [image(h.image)].filter(Boolean), address: h.address?.streetAddress,
      rating: { value: number(h.aggregateRating?.ratingValue), scale: number(h.aggregateRating?.bestRating), reviewCount: number(h.aggregateRating?.reviewCount) },
      indicativePriceText: h.priceRange || null, rates: [], rateStatus: 'not_extracted'
    }));
    if (!results.length) throw new Error('No supported public hotel state found; stop and inspect the page manually');
    return { schemaVersion: 1, observedAt, access, anonymousStateConfirmed: state?.hotelDetailResponse?.authInfo?.isLogin === false,
      diagnostics, hotels: results };
  }
  async function fetchAnonymous(url = location.href) {
    const target = new URL(url);
    if (target.origin !== 'https://www.trip.com' || !target.pathname.startsWith('/hotels/') || target.username || target.password)
      throw new Error('Only public https://www.trip.com/hotels/ URLs are supported');
    const response = await fetch(target.href, { method: 'GET', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}; stop, no automatic retries`);
    if (!/text\/html/i.test(response.headers.get('content-type') || '')) throw new Error('Expected a public HTML page');
    return extract(await response.text(), { url: target.href, access: 'anonymous_credentials_omit' });
  }
  globalThis.TripPublicResearch = Object.freeze({ extract, fetchAnonymous });
})();
