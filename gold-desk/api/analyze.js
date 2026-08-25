const TIMEOUT_MS=15000;
async function callOpenAI(key,payload){const c=new AbortController();const t=setTimeout(()=>c.abort(),TIMEOUT_MS);try{return await fetch('https://api.openai.com/v1/responses',{method:'POST',signal:c.signal,headers:{'content-type':'application/json','authorization':`Bearer ${key}`},body:JSON.stringify(payload)})}finally{clearTimeout(t)}}
export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='POST')return res.status(405).json({ok:false,error:'POST only'});
  const key=process.env.OPENAI_API_KEY||req.headers['x-openai-key'];
  if(!key)return res.status(503).json({ok:false,error:'OPENAI_API_KEY is not configured on the server.'});
  const body=req.body||{};const market=body.market;const events=body.events||[];const tradePlan=body.tradePlan||null;
  if(!market)return res.status(400).json({ok:false,error:'Missing market snapshot'});
  const prompt=`You are GOLD DESK V0.9, a disciplined XAU/USD macro research desk. Analyze ONLY the supplied machine data. Never invent live prices, news, events or technical confirmation. Never promise profit and never convert macro bias into an automatic trade order. Confidence means evidence alignment, not probability of profit. Risk ceiling is 0.25% planned account risk and daily loss ceiling is 0.75%.

Return VALID JSON ONLY with exactly these keys:
headline: short desk headline;
regime: one sentence;
bias: LONG BIAS|SHORT BIAS|WAIT|NO TRADE;
confidence: integer 0-100;
macro_thesis: concise explanation of real yields, nominal yields, DXY and gold momentum;
event_risk: concise upcoming-event assessment based only on supplied events;
surprise_watch: what actual-vs-forecast outcomes would matter most, without predicting the release;
bull_case: strongest bullish path;
bear_case: strongest bearish path;
invalidation: what evidence would invalidate the current thesis;
price_confirmation_needed: concrete but generic confirmation criteria, e.g. rejection/break-retest/momentum alignment; do not invent a level;
execution_state: LOCKED|WATCHLIST|ARMED_WAIT_CONFIRMATION|DEMO_ELIGIBLE;
risk_note: must preserve 0.25% max planned risk and no revenge sizing;
next_action: one disciplined next action.

MARKET=${JSON.stringify(market)}
EVENTS=${JSON.stringify(events)}
TRADE_PLAN=${JSON.stringify(tradePlan)}`;
  try{
    const r=await callOpenAI(key,{model:'gpt-5-mini',input:prompt});
    const j=await r.json();
    if(!r.ok)return res.status(r.status).json({ok:false,error:j?.error?.message||'OpenAI request failed'});
    const text=j.output_text||j?.output?.flatMap(o=>o.content||[]).map(c=>c.text||'').join('')||'';
    let analysis;try{analysis=JSON.parse(text.replace(/^```json\s*|\s*```$/g,''))}catch{analysis={headline:'AI brief returned unstructured output',raw:text,bias:'WAIT',confidence:0,execution_state:'LOCKED',risk_note:'Max planned risk remains 0.25%.'}}
    return res.status(200).json({ok:true,version:'0.9',generatedAt:new Date().toISOString(),analysis});
  }catch(e){return res.status(500).json({ok:false,error:e?.name==='AbortError'?'AI brief timed out after 15 seconds':(e?.message||String(e))})}
}
