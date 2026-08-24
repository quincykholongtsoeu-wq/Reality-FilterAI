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

async function yahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=5m&range=1d&includePrePost=true`;
  const r = await fetchWithTimeout(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`Market feed ${symbol} ${r.status}`);
  const j = await r.json();
  const result = j?.chart?.result?.[0];
  if (!result) return null;
  const meta = result.meta || {};
  const closes = result.indicators?.quote?.[0]?.close || [];
  const timestamps = result.timestamp || [];
  let last = null, prev = null, ts = null;
  for (let i = closes.length - 1; i >= 0; i--) {
    if (Number.isFinite(closes[i])) {
      if (last === null) { last = closes[i]; ts = timestamps[i] || null; }
      else { prev = closes[i]; break; }
    }
  }
  const ref = Number.isFinite(meta.chartPreviousClose) ? meta.chartPreviousClose : prev;
  return {
    symbol,
    price: last ?? meta.regularMarketPrice ?? null,
    previousClose: ref ?? null,
    changePct: (last != null && ref) ? ((last-ref)/ref)*100 : null,
    timestamp: ts ? new Date(ts*1000).toISOString() : null,
    currency: meta.currency || null,
    exchange: meta.exchangeName || null,
    instrumentType: meta.instrumentType || null
  };
}

function classify(data) {
  let score = 0;
  const reasons = [];
  const realCh = data.real10y?.change;
  const dxyCh = data.dxy?.changePct;
  const goldCh = data.gold?.changePct;

  if (Number.isFinite(realCh)) {
    if (realCh <= -0.02) { score += 3; reasons.push(`10Y real yield fell ${Math.abs(realCh).toFixed(3)} percentage points versus the prior FRED observation.`); }
    else if (realCh >= 0.02) { score -= 3; reasons.push(`10Y real yield rose ${realCh.toFixed(3)} percentage points versus the prior FRED observation.`); }
    else reasons.push('10Y real yield is broadly unchanged versus the prior FRED observation.');
  }

  if (Number.isFinite(dxyCh)) {
    if (dxyCh <= -0.15) { score += 2; reasons.push(`DXY is down ${Math.abs(dxyCh).toFixed(2)}% versus the prior close.`); }
    else if (dxyCh >= 0.15) { score -= 2; reasons.push(`DXY is up ${dxyCh.toFixed(2)}% versus the prior close.`); }
    else reasons.push(`DXY is near flat (${dxyCh >= 0 ? '+' : ''}${dxyCh.toFixed(2)}%).`);
  }

  if (Number.isFinite(goldCh)) {
    if (goldCh >= 0.35) { score += 1; reasons.push(`Gold is confirming strength (+${goldCh.toFixed(2)}%).`); }
    else if (goldCh <= -0.35) { score -= 1; reasons.push(`Gold is confirming weakness (${goldCh.toFixed(2)}%).`); }
  }

  if (!reasons.length) reasons.push('Insufficient live inputs. WAIT.');

  let bias = 'WAIT', confidence = 52;
  if (score >= 4) { bias = 'LONG BIAS'; confidence = Math.min(84, 58 + score*4); }
  if (score <= -4) { bias = 'SHORT BIAS'; confidence = Math.min(84, 58 + Math.abs(score)*4); }
  if (Math.abs(score) <= 1) confidence = 50;
  return { bias, confidence, score, reasons };
}

const valueOrNull = (settled) => settled.status === 'fulfilled' ? settled.value : null;
const errorOrNull = (settled) => settled.status === 'rejected' ? settled.reason?.name === 'AbortError' ? 'Feed timed out after 6s' : (settled.reason?.message || String(settled.reason)) : null;

export default async function handler(req, res) {
  res.setHeader('Cache-Control','s-maxage=60, stale-while-revalidate=120');

  const results = await Promise.allSettled([
    yahoo('GC=F'),
    yahoo('DX-Y.NYB'),
    fredLatest(FRED.us2y),
    fredLatest(FRED.us10y),
    fredLatest(FRED.real10y)
  ]);

  const [goldR,dxyR,us2yR,us10yR,real10yR] = results;
  const data = {
    gold: valueOrNull(goldR),
    dxy: valueOrNull(dxyR),
    us2y: valueOrNull(us2yR),
    us10y: valueOrNull(us10yR),
    real10y: valueOrNull(real10yR)
  };
  const errors = {
    gold: errorOrNull(goldR),
    dxy: errorOrNull(dxyR),
    us2y: errorOrNull(us2yR),
    us10y: errorOrNull(us10yR),
    real10y: errorOrNull(real10yR)
  };
  const read = classify(data);

  res.status(200).json({
    ok: true,
    generatedAt: new Date().toISOString(),
    data,
    errors,
    read,
    connections: {
      fredKeyPresent: Boolean(process.env.FRED_API_KEY),
      fred: Boolean(data.us2y || data.us10y || data.real10y),
      market: Boolean(data.gold || data.dxy)
    },
    notes: [
      'Each external feed now has a hard 6-second timeout.',
      'Gold feed uses COMEX Gold Futures (GC=F) as a market proxy, not broker XAUUSD spot.',
      'Treasury and real-yield observations are official FRED series and are not tick-by-tick.',
      'A failed Gold or DXY proxy no longer blocks FRED yields from loading.',
      'This is research intelligence, not an order-execution system.'
    ]
  });
}
