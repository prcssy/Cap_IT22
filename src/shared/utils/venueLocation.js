/* Whether a venue (from venuesConfig/global.venues) has location info set
   by an admin — see the venue location fields in firestoreService.js. */
export function hasPin(venue) {
  return Number.isFinite(venue?.mapX) && Number.isFinite(venue?.mapY);
}

export function hasLocation(venue) {
  return Boolean(venue && (hasPin(venue) || venue.photo || (venue.directions || '').trim() || venue.mapsUrl));
}
