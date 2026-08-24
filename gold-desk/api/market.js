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

  const r = await fetchWithTimeout(url, { headers: { 'user-agent': 'gold-desk/0.5' } });
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

async function goldLatest() {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=5m&range=1d&includePrePost=true';
  const r = await fetchWithTimeout(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`Gold proxy ${r.status}`);
  const j = await r.json();
  const result = j?.chart?.result?.[0];
  if (!result) throw new Error('Gold proxy returned no result');

  const meta = result.meta || {};
  const closes = result.indicators?.quote?.[0]?.close || [];
  const timestamps = result.timestamp || [];
  let last = null;
  let ts = null;

  for (let i = closes.length - 1; i >= 0; i--) {
    if (Number.isFinite(closes[i])) {
      last = closes[i];
      ts = timestamps[i] || null;
      break;
    }
  }

  const previousClose = Number.isFinite(meta.chartPreviousClose) ? meta.chartPreviousClose : null;
  const price = last ?? meta.regularMarketPrice ?? null;
  const changePct = (Number.isFinite(price) && Number.isFinite(previousClose) && previousClose !== 0)
    ? ((price - previousClose) / previousClose) * 100
    : null;

  return {
    symbol: 'GC=F',
    price,
    previousClose,
    changePct,
    timestamp: ts ? new Date(ts * 1000).toISOString() : null,
    source: 'Yahoo Finance COMEX Gold Futures proxy'
  };
}

function classify(data) {
  let score = 0;
  const reasons = [];
  const realCh = data.real10y?.change;
  const goldCh = data.gold?.changePct;

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

  if (Number.isFinite(goldCh)) {
    if (goldCh >= 0.35) {
      score += 1;
      reasons.push(`Gold futures are confirming strength (+${goldCh.toFixed(2)}% versus prior close).`);
    } else if (goldCh <= -0.35) {
      score -= 1;
      reasons.push(`Gold futures are confirming weakness (${goldCh.toFixed(2)}% versus prior close).`);
    } else {
      reasons.push(`Gold futures are near flat (${goldCh >= 0 ? '+' : ''}${goldCh.toFixed(2)}%).`);
    }
  }

  if (!reasons.length) reasons.push('Not enough live inputs yet. WAIT.');

  let bias = 'WAIT';
  let confidence = 50;
  if (score >= 3) { bias = 'LONG BIAS'; confidence = Math.min(72, 58 + score * 3); }
  if (score <= -3) { bias = 'SHORT BIAS'; confidence = Math.min(72, 58 + Math.abs(score) * 3); }

  return { bias, confidence, score, reasons };
}

const valueOrNull = (settled) => settled.status === 'fulfilled' ? settled.value : null;
const errorOrNull = (settled) => settled.status === 'rejected'
  ? (settled.reason?.name === 'AbortError' ? 'Feed timed out after 6s' : (settled.reason?.message || String(settled.reason)))
  : null;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const results = await Promise.allSettled([
    fredLatest(FRED.us2y),
    fredLatest(FRED.us10y),
    fredLatest(FRED.real10y),
    goldLatest()
  ]);

  const [us2yR, us10yR, real10yR, goldR] = results;

  const data = {
    gold: valueOrNull(goldR),
    dxy: null,
    us2y: valueOrNull(us2yR),
    us10y: valueOrNull(us10yR),
    real10y: valueOrNull(real10yR)
  };

  const errors = {
    gold: errorOrNull(goldR),
    dxy: 'DXY temporarily isolated while Gold is validated',
    us2y: errorOrNull(us2yR),
    us10y: errorOrNull(us10yR),
    real10y: errorOrNull(real10yR)
  };

  const read = classify(data);

  return res.status(200).json({
    ok: true,
    mode: 'FRED_PLUS_GOLD_VALIDATION',
    generatedAt: new Date().toISOString(),
    data,
    errors,
    read,
    connections: {
      fredKeyPresent: Boolean(process.env.FRED_API_KEY),
      fred: Boolean(data.us2y || data.us10y || data.real10y),
      gold: Boolean(data.gold),
      dxy: false
    },
    notes: [
      'Gold has been reconnected as an isolated COMEX Gold Futures proxy with a hard 6-second timeout.',
      'DXY remains disabled until Gold is proven stable.',
      'FRED remains the official source for Treasury and real-yield observations.',
      'This is research intelligence, not an order-execution system.'
    ]
  });
}
