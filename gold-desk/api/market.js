const FRED = {
  us2y: 'DGS2',
  us10y: 'DGS10',
  real10y: 'DFII10'
};

async function fredLatest(series) {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(series)}`;
  const r = await fetch(url, { headers: { 'user-agent': 'gold-desk/0.3' } });
  if (!r.ok) throw new Error(`FRED ${series} ${r.status}`);
  const text = await r.text();
  const lines = text.trim().split(/\r?\n/).slice(1).reverse();
  const vals = [];
  for (const line of lines) {
    const [date, raw] = line.split(',');
    const v = Number(raw);
    if (Number.isFinite(v)) vals.push({ date, value: v });
    if (vals.length >= 2) break;
  }
  if (!vals.length) return null;
  return { value: vals[0].value, date: vals[0].date, change: vals.length > 1 ? vals[0].value - vals[1].value : null };
}

async function yahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=5m&range=1d&includePrePost=true`;
  const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
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
  return { symbol, price: last ?? meta.regularMarketPrice ?? null, previousClose: ref ?? null, changePct: (last != null && ref) ? ((last-ref)/ref)*100 : null, timestamp: ts ? new Date(ts*1000).toISOString() : null, currency: meta.currency || null, exchange: meta.exchangeName || null, instrumentType: meta.instrumentType || null };
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
  let bias = 'WAIT', confidence = 52;
  if (score >= 4) { bias = 'LONG BIAS'; confidence = Math.min(84, 58 + score*4); }
  if (score <= -4) { bias = 'SHORT BIAS'; confidence = Math.min(84, 58 + Math.abs(score)*4); }
  if (Math.abs(score) <= 1) confidence = 50;
  return { bias, confidence, score, reasons };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control','s-maxage=60, stale-while-revalidate=120');
  try {
    const [gold,dxy,us2y,us10y,real10y] = await Promise.all([yahoo('GC=F'), yahoo('DX-Y.NYB'), fredLatest(FRED.us2y), fredLatest(FRED.us10y), fredLatest(FRED.real10y)]);
    const data = { gold, dxy, us2y, us10y, real10y };
    const read = classify(data);
    res.status(200).json({ok:true, generatedAt:new Date().toISOString(), data, read, notes:['Gold feed uses COMEX Gold Futures (GC=F) as a live-market proxy, not broker XAUUSD spot.','Treasury and real-yield observations are official FRED series and are not tick-by-tick.','This is research intelligence, not an order-execution system.']});
  } catch (e) { res.status(500).json({ok:false,error:e.message}); }
}
