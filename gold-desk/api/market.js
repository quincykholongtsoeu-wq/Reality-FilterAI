const FRED = {
  us2y: 'DGS2',
  us10y: 'DGS10',
  real10y: 'DFII10'
};

const FETCH_TIMEOUT_MS = 6000;

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fredLatest(series) {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) throw new Error('FRED_API_KEY is missing');

  const url = new URL('https://api.stlouisfed.org/fred/series/observations');
  url.searchParams.set('series_id', series);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('file_type', 'json');
  url.searchParams.set('sort_order', 'desc');
  url.searchParams.set('limit', '10');

  const r = await fetchWithTimeout(url, { headers: { 'user-agent': 'gold-desk/0.4' } });
  if (!r.ok) throw new Error(`FRED ${series} ${r.status}`);
  const j = await r.json();

  const vals = [];
  for (const o of j?.observations || []) {
    if (o?.value === '.' || o?.value == null) continue;
    const v = Number(o.value);
    if (Number.isFinite(v)) vals.push({ date: o.date, value: v });
    if (vals.length >= 2) break;
  }

  if (!vals.length) return null;
  return {
    value: vals[0].value,
    date: vals[0].date,
    change: vals.length > 1 ? vals[0].value - vals[1].value : null,
    source: 'FRED API'
  };
}

function classify(data) {
  let score = 0;
  const reasons = [];
  const realCh = data.real10y?.change;

  if (Number.isFinite(realCh)) {
    if (realCh <= -0.02) {
      score += 3;
      reasons.push(`10Y real yield fell ${Math.abs(realCh).toFixed(3)} percentage points versus the prior FRED observation.`);
    } else if (realCh >= 0.02) {
      score -= 3;
      reasons.push(`10Y real yield rose ${realCh.toFixed(3)} percentage points versus the prior FRED observation.`);
    } else {
      reasons.push('10Y real yield is broadly unchanged versus the prior FRED observation.');
    }
  }

  if (!reasons.length) reasons.push('FRED data not available yet. WAIT.');

  let bias = 'WAIT';
  let confidence = 50;
  if (score >= 3) { bias = 'LONG BIAS'; confidence = 64; }
  if (score <= -3) { bias = 'SHORT BIAS'; confidence = 64; }

  return { bias, confidence, score, reasons };
}

const valueOrNull = (settled) => settled.status === 'fulfilled' ? settled.value : null;
const errorOrNull = (settled) => settled.status === 'rejected'
  ? (settled.reason?.name === 'AbortError' ? 'Feed timed out after 6s' : (settled.reason?.message || String(settled.reason)))
  : null;

export default async function handler(req, res) {
  res.setHeader('Cache-Control','no-store');

  const results = await Promise.allSettled([
    fredLatest(FRED.us2y),
    fredLatest(FRED.us10y),
    fredLatest(FRED.real10y)
  ]);

  const [us2yR, us10yR, real10yR] = results;
  const data = {
    gold: null,
    dxy: null,
    us2y: valueOrNull(us2yR),
    us10y: valueOrNull(us10yR),
    real10y: valueOrNull(real10yR)
  };

  const errors = {
    gold: 'Market proxy temporarily disabled while debugging',
    dxy: 'Market proxy temporarily disabled while debugging',
    us2y: errorOrNull(us2yR),
    us10y: errorOrNull(us10yR),
    real10y: errorOrNull(real10yR)
  };

  const read = classify(data);

  return res.status(200).json({
    ok: true,
    mode: 'FRED_ONLY_DEBUG',
    generatedAt: new Date().toISOString(),
    data,
    errors,
    read,
    connections: {
      fredKeyPresent: Boolean(process.env.FRED_API_KEY),
      fred: Boolean(data.us2y || data.us10y || data.real10y),
      market: false
    },
    notes: [
      'Gold and DXY proxies are temporarily disabled so they cannot block FRED.',
      'Each FRED request has a hard 6-second timeout.',
      'This is research intelligence, not an order-execution system.'
    ]
  });
}
