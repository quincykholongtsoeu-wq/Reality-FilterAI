const TIMEOUT_MS=30000;

async function callOpenAI(key,payload){
  const c=new AbortController();
  const t=setTimeout(()=>c.abort(),TIMEOUT_MS);
  try{
    return await fetch('https://api.openai.com/v1/responses',{
      method:'POST',
      signal:c.signal,
      headers:{'content-type':'application/json','authorization':`Bearer ${key}`},
      body:JSON.stringify(payload)
    });
  }finally{clearTimeout(t)}
}

function extractText(j){
  if(typeof j?.output_text==='string'&&j.output_text.trim())return j.output_text.trim();
  const parts=[];
  for(const item of j?.output||[]){
    for(const c of item?.content||[]){
      if(typeof c?.text==='string')parts.push(c.text);
    }
  }
  return parts.join('\n').trim();
}

export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');

  if(req.method==='GET'){
    const configured=Boolean(process.env.OPENAI_API_KEY||process.env.OPENAI_PI_KEY);
    return res.status(200).json({
      ok:true,
      version:'0.9.1',
      aiKeyConfigured:configured,
      acceptedEnvNames:['OPENAI_API_KEY','OPENAI_PI_KEY'],
      model:'gpt-5.6-luna'
    });
  }

  if(req.method!=='POST')return res.status(405).json({ok:false,error:'POST only'});

  // Compatibility fix: the project originally stored the variable as OPENAI_PI_KEY.
  // Prefer the correctly named variable, but accept the existing typo so the app works immediately.
  const key=process.env.OPENAI_API_KEY||process.env.OPENAI_PI_KEY||req.headers['x-openai-key'];
  if(!key)return res.status(503).json({
    ok:false,
    code:'AI_KEY_MISSING',
    error:'OpenAI key is not visible to the deployment. Set OPENAI_API_KEY in Vercel Production and Preview.'
  });

  const body=req.body||{};
  const market=body.market;
  const events=body.events||[];
  const tradePlan=body.tradePlan||null;
  if(!market)return res.status(400).json({ok:false,error:'Missing market snapshot'});

  const prompt=`You are GOLD DESK V0.9, a disciplined XAU/USD macro research desk. Analyze ONLY the supplied machine data. Never invent live prices, news, events, technical levels, or price confirmation. Never promise profit and never convert macro bias into an automatic trade order. Confidence means evidence alignment, not probability of profit. Planned account risk ceiling is 0.25% and daily loss ceiling is 0.75%.

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
price_confirmation_needed: generic confirmation criteria such as rejection, break-retest or momentum alignment; do not invent a price level;
execution_state: LOCKED|WATCHLIST|ARMED_WAIT_CONFIRMATION|DEMO_ELIGIBLE;
risk_note: preserve 0.25% max planned risk and no revenge sizing;
next_action: one disciplined next action.

MARKET=${JSON.stringify(market)}
EVENTS=${JSON.stringify(events)}
TRADE_PLAN=${JSON.stringify(tradePlan)}`;

  try{
    const r=await callOpenAI(key,{
      model:'gpt-5.6-luna',
      input:prompt,
      max_output_tokens:1400
    });
    const j=await r.json();

    if(!r.ok){
      const msg=j?.error?.message||'OpenAI request failed';
      const code=j?.error?.code||j?.error?.type||'OPENAI_ERROR';
      return res.status(r.status).json({ok:false,code,error:msg});
    }

    const text=extractText(j);
    if(!text)return res.status(502).json({ok:false,code:'EMPTY_AI_RESPONSE',error:'OpenAI returned no readable text.'});

    let analysis;
    try{
      analysis=JSON.parse(text.replace(/^```json\s*|\s*```$/g,''));
    }catch{
      return res.status(502).json({
        ok:false,
        code:'AI_JSON_PARSE_FAILED',
        error:'AI responded, but the brief was not valid JSON. Try Generate AI Brief again.'
      });
    }

    return res.status(200).json({
      ok:true,
      version:'0.9.1',
      model:'gpt-5.6-luna',
      generatedAt:new Date().toISOString(),
      analysis
    });
  }catch(e){
    return res.status(500).json({
      ok:false,
      code:e?.name==='AbortError'?'AI_TIMEOUT':'AI_RUNTIME_ERROR',
      error:e?.name==='AbortError'?'AI brief timed out after 30 seconds':(e?.message||String(e))
    });
  }
}
