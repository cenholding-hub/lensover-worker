/**
 * Lensover Worker — OSM Overpass tabanlı, API key gerektirmez
 * Cron: her 6 saatte foto spot çeker, D1'e kaydeder
 * GET /spots?lat=&lng=&radius=&limit=   → yakın spotlar
 * GET /spots/trending?limit=            → trend spotlar
 * GET /spots/:id                        → tek spot
 */

const SEED_LOCATIONS = [
  { lat: 41.0082, lng: 28.9784 }, // Istanbul
  { lat: 36.8969, lng: 30.7133 }, // Antalya
  { lat: 38.4237, lng: 27.1428 }, // Izmir
  { lat: 39.9334, lng: 32.8597 }, // Ankara
  { lat: 51.5074, lng: -0.1278 }, // London
  { lat: 48.8566, lng: 2.3522  }, // Paris
  { lat: 40.7128, lng: -74.006 }, // New York
  { lat: 35.6762, lng: 139.6503}, // Tokyo
  { lat: 41.9028, lng: 12.4964 }, // Rome
  { lat: 52.3702, lng: 4.8952  }, // Amsterdam
];

const OSM_QUERY = (lat, lng, radius = 15000) => `
[out:json][timeout:25];
(
  node["tourism"="viewpoint"](around:${radius},${lat},${lng});
  node["tourism"="attraction"](around:${radius},${lat},${lng});
  node["natural"="peak"](around:${radius},${lat},${lng});
  node["natural"="waterfall"](around:${radius},${lat},${lng});
  node["natural"="beach"](around:${radius},${lat},${lng});
  node["historic"="monument"](around:${radius},${lat},${lng});
  node["leisure"="park"]["name"](around:${radius},${lat},${lng});
);
out body 20;
`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    };

    if (path === '/spots/trending') {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50);
      const rows = await env.DB.prepare(
        'SELECT * FROM spots ORDER BY trending_score DESC LIMIT ?'
      ).bind(limit).all();
      return Response.json({ spots: rows.results }, { headers });
    }

    if (path.match(/^\/spots\/[^\/]+$/)) {
      const id = decodeURIComponent(path.slice(7));
      const row = await env.DB.prepare('SELECT * FROM spots WHERE id = ?').bind(id).first();
      if (!row) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers });
      return Response.json({ spot: row }, { headers });
    }

    if (path === '/spots') {
      const lat = parseFloat(url.searchParams.get('lat'));
      const lng = parseFloat(url.searchParams.get('lng'));
      const radius = Math.min(parseFloat(url.searchParams.get('radius') || '50'), 200);
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '30'), 100);
      const category = url.searchParams.get('category');

      if (isNaN(lat) || isNaN(lng)) {
        return Response.json({ error: 'lat and lng required' }, { status: 400, headers });
      }

      const latDelta = radius / 111.0;
      const lngDelta = radius / (111.0 * Math.cos(lat * Math.PI / 180));

      let query = `SELECT *, ((latitude-?)*(latitude-?)+(longitude-?)*(longitude-?)) AS dist_sq
        FROM spots
        WHERE latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?`;
      const params = [lat, lat, lng, lng, lat-latDelta, lat+latDelta, lng-lngDelta, lng+lngDelta];

      if (category) { query += ' AND category = ?'; params.push(category); }
      query += ' ORDER BY dist_sq ASC LIMIT ?';
      params.push(limit);

      const rows = await env.DB.prepare(query).bind(...params).all();
      return Response.json({ spots: rows.results, count: rows.results.length }, { headers });
    }

    return new Response(JSON.stringify({ service: 'Lensover Worker', version: '1.0', endpoints: ['/spots', '/spots/trending', '/spots/:id'] }), { headers });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(fetchAndStoreSpots(env));
  },
};

async function fetchAndStoreSpots(env) {
  for (const loc of SEED_LOCATIONS) {
    try {
      await fetchOSMSpots(env, loc.lat, loc.lng);
      await sleep(1000);
    } catch (e) {
      console.error(`Failed ${loc.lat},${loc.lng}: ${e.message}`);
    }
  }
}

async function fetchOSMSpots(env, lat, lng) {
  const query = OSM_QUERY(lat, lng);
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: `data=${encodeURIComponent(query)}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  if (!res.ok) return;
  const data = await res.json();
  if (!data.elements) return;

  const stmt = env.DB.prepare(`
    INSERT INTO spots (id, name, latitude, longitude, description, category, photo_url, rating, rating_count, source, trending_score, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'osm', ?, unixepoch())
    ON CONFLICT(id) DO UPDATE SET updated_at = unixepoch()
  `);

  for (const el of data.elements) {
    if (!el.tags?.name) continue;
    const category = el.tags.tourism || el.tags.natural || el.tags.historic || el.tags.leisure || 'attraction';
    const wikimediaPhoto = el.tags.wikimedia_commons
      ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(el.tags.wikimedia_commons)}?width=800`
      : null;

    await stmt.bind(
      `osm_${el.id}`,
      el.tags.name,
      el.lat,
      el.lon,
      el.tags.description || el.tags['description:en'] || null,
      category,
      wikimediaPhoto,
      null, null,
      0
    ).run();
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
