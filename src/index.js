/**
 * Lensover Worker
 * - Cron: her 6 saatte Google Places'ten foto spot çeker, D1'e kaydeder
 * - GET /spots?lat=&lng=&radius=&limit=  → yakın spotlar
 * - GET /spots/trending?limit=           → trend spotlar
 * - GET /spots/:id                       → tek spot detayı
 */

const PHOTO_TYPES = [
  'tourist_attraction', 'natural_feature', 'park', 'point_of_interest',
  'art_gallery', 'museum', 'church', 'mosque', 'hindu_temple',
  'waterfall', 'beach', 'mountain_pass', 'lake', 'forest'
];

const SEED_LOCATIONS = [
  { lat: 41.0082, lng: 28.9784, name: 'Istanbul' },
  { lat: 41.0151, lng: 28.9795, name: 'Bosphorus' },
  { lat: 36.8969, lng: 30.7133, name: 'Antalya' },
  { lat: 38.4237, lng: 27.1428, name: 'Izmir' },
  { lat: 38.6748, lng: 39.2225, name: 'Eastern Turkey' },
  { lat: 51.5074, lng: -0.1278, name: 'London' },
  { lat: 48.8566, lng: 2.3522, name: 'Paris' },
  { lat: 40.7128, lng: -74.0060, name: 'New York' },
  { lat: 35.6762, lng: 139.6503, name: 'Tokyo' },
  { lat: -33.8688, lng: 151.2093, name: 'Sydney' },
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    };

    if (path === '/spots/trending') {
      const limit = parseInt(url.searchParams.get('limit') || '20');
      const rows = await env.DB.prepare(
        'SELECT * FROM spots ORDER BY trending_score DESC LIMIT ?'
      ).bind(limit).all();
      return Response.json({ spots: rows.results }, { headers });
    }

    if (path.startsWith('/spots/') && path.length > 7) {
      const id = path.slice(7);
      const row = await env.DB.prepare('SELECT * FROM spots WHERE id = ?').bind(id).first();
      if (!row) return new Response('Not found', { status: 404, headers });
      return Response.json({ spot: row }, { headers });
    }

    if (path === '/spots') {
      const lat = parseFloat(url.searchParams.get('lat'));
      const lng = parseFloat(url.searchParams.get('lng'));
      const radius = parseFloat(url.searchParams.get('radius') || '50');
      const limit = parseInt(url.searchParams.get('limit') || '30');
      const category = url.searchParams.get('category');

      if (isNaN(lat) || isNaN(lng)) {
        return Response.json({ error: 'lat and lng required' }, { status: 400, headers });
      }

      const latDelta = radius / 111.0;
      const lngDelta = radius / (111.0 * Math.cos(lat * Math.PI / 180));

      let query = `SELECT *, (
        (latitude - ?) * (latitude - ?) + (longitude - ?) * (longitude - ?)
      ) AS dist_sq FROM spots
      WHERE latitude BETWEEN ? AND ?
        AND longitude BETWEEN ? AND ?`;
      const params = [lat, lat, lng, lng, lat - latDelta, lat + latDelta, lng - lngDelta, lng + lngDelta];

      if (category) {
        query += ' AND category = ?';
        params.push(category);
      }

      query += ' ORDER BY dist_sq ASC LIMIT ?';
      params.push(limit);

      const rows = await env.DB.prepare(query).bind(...params).all();
      return Response.json({ spots: rows.results }, { headers });
    }

    return new Response('Lensover Worker v1.0', { headers });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(fetchAndStoreSpots(env));
  },
};

async function fetchAndStoreSpots(env) {
  const apiKey = env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) { console.error('GOOGLE_PLACES_API_KEY not set'); return; }

  for (const location of SEED_LOCATIONS) {
    for (const type of PHOTO_TYPES.slice(0, 4)) {
      await fetchNearby(env, apiKey, location.lat, location.lng, type);
      await sleep(200);
    }
  }
}

async function fetchNearby(env, apiKey, lat, lng, type) {
  const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json` +
    `?location=${lat},${lng}&radius=10000&type=${type}&key=${apiKey}`;

  const res = await fetch(url);
  if (!res.ok) return;
  const data = await res.json();
  if (!data.results) return;

  const stmt = env.DB.prepare(`
    INSERT INTO spots (id, name, latitude, longitude, description, category, photo_url, rating, rating_count, source, trending_score, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'google', ?, unixepoch())
    ON CONFLICT(id) DO UPDATE SET
      rating = excluded.rating,
      rating_count = excluded.rating_count,
      trending_score = excluded.trending_score,
      updated_at = unixepoch()
  `);

  for (const place of data.results.slice(0, 10)) {
    const photoRef = place.photos?.[0]?.photo_reference;
    const photoUrl = photoRef
      ? `https://maps.googleapis.com/maps/api/place/photo?maxwidth=800&photoreference=${photoRef}&key=${apiKey}`
      : null;

    const trending = (place.rating || 0) * Math.log1p(place.user_ratings_total || 0);

    await stmt.bind(
      `gp_${place.place_id}`,
      place.name,
      place.geometry.location.lat,
      place.geometry.location.lng,
      place.vicinity || null,
      type,
      photoUrl,
      place.rating || null,
      place.user_ratings_total || 0,
      trending
    ).run();
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
