import test from 'node:test';
import assert from 'node:assert/strict';
import './extractor.js';

const props = () => ({ hotelDetailResponse: {
  hotelBaseInfo: { masterHotelId: 42, nameInfo: { name: 'Example' }, starInfo: { level: 4 } },
  authInfo: { isLogin: false },
  hotelPositionInfo: { address: 'hidden', lat: '1', lng: '2', addressVisible: false, preciseCoordinatesVisible: false }
}, hotelCommentResponse: { commentRating: { ratingRoom: 9, ratingRoomShowItem: 'Cleanliness' }, groupList: [{ commentList: [{ userName: 'private-name' }] }] },
seoSSRData: { seoHotelRooms: { physicRoomMap: { 7: { id: 7, name: 'Queen', bedInfo: { title: '1 Queen bed' } } } } },
vid: 'private-session-id', ssrHotelRoomListResponse: {} });
const script = payload => `<script>self.__next_f.push(${JSON.stringify([1, payload])})</script>`;

test('parses a record split across hydration chunks, excludes session/reviewer data and hidden coordinates', () => {
  const record = `Jd:${JSON.stringify(['$', '@10', null, props()])}\n`;
  const html = script(record.slice(0, 71)) + script(record.slice(71));
  const r = TripPublicResearch.extract(html, { url: 'https://www.trip.com/hotels/example/' });
  assert.equal(r.hotels[0].name, 'Example');
  assert.equal(r.hotels[0].rooms[0].beds, '1 Queen bed');
  assert.equal(r.hotels[0].coordinates, null);
  assert.equal(r.hotels[0].address, null);
  assert.equal(r.hotels[0].rating.dimensions[3].label, 'Cleanliness');
  assert.equal(r.anonymousStateConfirmed, true);
  assert.doesNotMatch(JSON.stringify(r), /private-name|private-session-id/);
  assert.deepEqual(r.hotels[0].rates, []);
});

test('does not execute script expressions or guess unsupported state', () => {
  globalThis.tripParserExecutionProbe = 0;
  assert.throws(() => TripPublicResearch.extract('<script>self.__next_f.push((globalThis.tripParserExecutionProbe=1, [1,"Jd:{}"]))</script>'), /No supported/);
  assert.equal(globalThis.tripParserExecutionProbe, 0);
});

test('JSON-LD list fallback preserves the rating scale and labels indicative prices', () => {
  const html = '<script type="application/ld+json">' + JSON.stringify({ '@type': 'ItemList', itemListElement: [{ item: {
    '@type': 'Hotel', name: 'Example', url: 'https://www.trip.com/hotels/example-hotel-detail-42/name/', priceRange: 'From US$100',
    aggregateRating: { ratingValue: '9.1', bestRating: 10, reviewCount: '10' }
  } }] }) + '</script>';
  const r = TripPublicResearch.extract(html);
  assert.equal(r.hotels[0].id, '42');
  assert.equal(r.hotels[0].rating.scale, 10);
  assert.equal(r.hotels[0].indicativePriceText, 'From US$100');
  assert.deepEqual(r.hotels[0].rates, []);
});

test('anonymous fetch rejects non-public URLs before sending a request', async () => {
  await assert.rejects(TripPublicResearch.fetchAnonymous('https://www.trip.com/account/'), /Only public/);
  await assert.rejects(TripPublicResearch.fetchAnonymous('https://example.com/hotels/'), /Only public/);
});
