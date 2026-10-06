# Trip.com public frontend research

Investigated on 2026-10-06. Result: **useful hotel metadata can be extracted from public HTML without the official API**. A dependable live rate or availability source was not established. This is a standalone research prototype; it is not wired into the travel API or deployed.

## Evidence

| Surface | Observed data | Practical use |
| --- | --- | --- |
| [Hotel homepage](https://www.trip.com/hotels/) | Server-rendered cards and Next/Flight hydration chunks | Discover public hotel links and indicative summaries |
| [Singapore landing page](https://www.trip.com/hotels/singapore-hotels-list-73/) | JSON-LD `ItemList` of nine hotels with URLs, stars, image, rating scale and review counts; neighborhood and travel-style links | Small seed list for discovery, not a complete city inventory |
| [Yotel detail](https://www.trip.com/hotels/singapore-hotel-detail-8497129/yotel-singapore-orchard-road/) | Hotel details, room catalog and review aggregates in embedded state | Enrichment with policies, amenities, room features, photos, coordinates and nearby places |
| [Hotel Boss detail](https://www.trip.com/hotels/singapore-hotel-detail-3801236/hotel-boss-singapore/) | Same state structure on a second hotel | Confirms the prototype beyond one property |

The initial interactive detail page used the browser's existing login. We then made ordinary same-origin GET requests with `credentials: 'omit'` and `redirect: 'error'`. Both returned HTTP 200 and their embedded `hotelDetailResponse.authInfo.isLogin` was `false`. The anonymous response was parsed as data, never executed. This establishes cookie-free access to those samples from this browser/network, not universal access from every server or region.

Yotel's anonymous sample contains 11 room types, 27 distinct amenities, 11 top-image URLs, seven policy categories, ten nearby places, and coordinates `1.306441, 103.831243`. Its rating was 9.1/10 from 3,455 reviews, with location 9.4, amenities 8.7, cleanliness 9.3 and service 8.9. Hotel Boss returned ten room types and 43 amenities, rating 8.5/10 from 7,533 reviews. These are observations, not fixed values.

## Data flow

The detail page's public document includes literal `self.__next_f.push([1, "..."])` chunks. Concatenate the string payloads, parse the `J...:` JSON records, and find the component props containing `hotelDetailResponse`. After hydration, the inspected page also exposes this data through `window.__NEXT_DATA__.props.pageProps`.

The useful paths are:

- `hotelDetailResponse.hotelBaseInfo`: hotel ID, names, stars, city/country, opening year.
- `hotelDetailResponse.hotelPositionInfo`: address, visibility flags, coordinates, neighborhood, transit text, nearby POIs and walking/driving distance labels.
- `hotelDetailResponse.hotelFacilityPopV2`: facilities with fee labels and structured details, including parking charges and accessibility amenities.
- `hotelDetailResponse.hotelPolicyInfo`: check-in/out, children, extra beds, breakfast including fee tables, deposit, pets and minimum age.
- `hotelDetailResponse.hotelTopImage`: photo URLs already delivered in the page; not the entire album.
- `hotelCommentResponse.commentRating`: overall score, count, named dimensions and `sameTypeAvg` figures. The exact comparison cohort behind `sameTypeAvg` is unverified.
- `seoSSRData.seoHotelRooms.physicRoomMap`: room names, beds, area, floor, windows, smoking information, amenity names and room photos. Capacity values preserve the site's reported fields; their occupancy rules are not inferred.
- `ssrHotelRoomListRequest` / `ssrHotelRoomListResponse`: date/occupancy context and a possible rate-response slot. The response was empty in our samples.

The prototype parses literal JSON only. It does not evaluate JavaScript assignments or captured page code. It omits login/header data, visitor IDs, tracking fields, contact details and individual reviewer identities/text. Coordinate and address fields are exported only when their corresponding frontend visibility flag is true.

## Network observations

The browser's resource timing entries showed these requests during normal detail-page loading:

| Observed path | Likely purpose, inferred from name and UI |
| --- | --- |
| `/restapi/soa2/28820/ctgethotelalbum` | Photo gallery |
| `/restapi/soa2/34308/getHotelCommentInfo` | Reviews |
| `/restapi/soa2/28820/ctGetNearbyPlaceInfo` | Nearby places |
| `/restapi/soa2/33269/getDetailAdditionalInfo` | Additional details |
| `/restapi/soa2/28820/ctGetHotelPriceCalendar` | Price calendar |
| `/restapi/soa2/28820/ctGetNearbyHotelList` | Nearby hotels |
| `/restapi/soa2/27147/run` | Unresolved generic service |

These are observed internal frontend endpoints, not tested anonymous integrations. Request bodies and response schemas were not established, and no direct replay was attempted. A temporary passive fetch observer recorded no useful additional request and was removed. An ordinary attempt to click “Check Availability” was blocked by an overlapping page element; no forced click or overlay removal was used.

An additional cookie-free detail GET with `?checkIn=2026-10-13&checkOut=2026-10-14&adult=2&crn=1` produced normalized dates `20261013` and `20261014` in the embedded request, but the rate response remained empty. The normal UI showed room types with “Check Availability”, rather than bookable prices. Room catalog presence does not establish availability.

## Run the prototype

Open a normal public Trip.com hotel page. Paste the complete contents of [extractor.js](../../../scripts/trip-public/extractor.js) into that page's DevTools console. It installs `TripPublicResearch`; installation itself sends no requests.

Extract the document already loaded:

```js
const result = TripPublicResearch.extract(document.documentElement.outerHTML, {
  url: location.href,
  access: 'current_browser_document'
});
console.log(JSON.stringify(result, null, 2));
```

Or make one cookie-free public page request from that browser:

```js
const result = await TripPublicResearch.fetchAnonymous(location.href);
console.log(JSON.stringify(result, null, 2));
// Chrome DevTools convenience function, if you want to save it:
copy(JSON.stringify(result, null, 2));
```

There is no crawler, automatic retry, endpoint replay, proxy, fingerprint modification, authentication flow or CAPTCHA handling. The helper restricts requests to HTTPS public hotel pages on `www.trip.com`, rejects redirects and HTTP errors, and fails if supported hotel state is absent. Stop if a page requires authentication or presents a challenge. The pure parser can also read locally saved HTML:

```sh
node scripts/trip-public/parse.mjs saved-page.html 'https://www.trip.com/hotels/your-public-page/' > hotel.json
node --test scripts/trip-public/extractor.test.mjs
```

The CLI is offline and never requests Trip.com. Saved HTML can contain session-specific data; keep raw captures private. The checked-in [Yotel sample](yotel-sample.json) contains normalized hotel metadata only.

## Fit for the hackathon

Use this as an enrichment sidecar: start with a public hotel link, export metadata and observation time, and attach it to a candidate hotel. Match across suppliers with name, address and coordinates; Trip.com IDs are not supplier IDs. Route booking and live prices through the existing supplier integration or a normal Trip.com link.

The city landing page had experimental-looking markup (“test hotel box”). Its Yotel review count was 3,439 while the detail page returned 3,455; its displayed price, FAQ price and detail-page indicative price also differed. Prefer field-level provenance and timestamps, preserve rating scales, and treat SEO summaries as potentially stale. The parser deliberately returns `rates: []` and `rateStatus: 'not_extracted'` even if a future page contains rate state; that would require separate validation.

No specific Trip.com documented API/schema was provided, so this does **not** prove that these fields are richer than a particular partner API. It proves that substantial hotel metadata is delivered to an ordinary anonymous frontend client. Coverage beyond these two properties, long-term schema stability, permission for reuse, and server-side fetching reliability remain unverified.
