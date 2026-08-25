const TIMEOUT_MS = 6000;

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeEvent(e) {
  const title = e?.Event || e?.Category || 'US macro event';
  const date = e?.Date || null;
  const actual = e?.Actual ?? null;
  const forecast = e?.Forecast ?? null;
  const previous = e?.Previous ?? null;
  const importance = e?.Importance ?? null;
  return { title, date, actual, forecast, previous, importance };
}

function relevant(e) {
  const t = `${e?.Event || ''} ${e?.Category || ''}`.toLowerCase();
  return [
    'consumer price', 'cpi', 'non farm', 'non-farm', 'payroll', 'fomc',
    'interest rate', 'federal reserve', 'pce', 'personal consumption', 'powell'
  ].some(k => t.includes(k));
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const now = new Date();
  const start = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0,10);
  const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0,10);
  const key = process.env.TRADING_ECONOMICS_API_KEY;
  const credential = key || 'guest:guest';
  const url = `https://api.tradingeconomics.com/calendar/country/united%20states/${start}/${end}?c=${encodeURIComponent(credential)}&importance=3&f=json`;

  try {
    const r = await fetchWithTimeout(url, { headers: { 'user-agent': 'gold-desk/0.5' } });
    if (!r.ok) throw new Error(`Calendar feed HTTP ${r.status}`);
    const j = await r.json();
    const events = Array.isArray(j) ? j.filter(relevant).map(normalizeEvent).slice(0, 12) : [];

    return res.status(200).json({
      ok: true,
      source: key ? 'Trading Economics API' : 'Trading Economics guest access',
      hasPrivateKey: Boolean(key),
      generatedAt: new Date().toISOString(),
      events,
      note: key ? null : 'Guest access is limited. Add TRADING_ECONOMICS_API_KEY later for stronger coverage and reliability.'
    });
  } catch (e) {
    return res.status(200).json({
      ok: false,
      source: 'Trading Economics',
      generatedAt: new Date().toISOString(),
      events: [],
      error: e?.name === 'AbortError' ? 'Calendar feed timed out after 6s' : (e?.message || String(e))
    });
  }
}
