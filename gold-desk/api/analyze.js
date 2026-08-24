export default async function handler(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'POST only'});
  const key=req.headers['x-openai-key'];
  if(!key) return res.status(400).json({error:'No API key supplied. Add it inside GOLD DESK; it is sent only for this request and is not stored by the server.'});
  const market=(req.body||{}).market;
  if(!market) return res.status(400).json({error:'Missing market snapshot'});
  const prompt=`You are GOLD DESK, a conservative macro research assistant for XAU/USD. Do not promise profits or instruct automatic execution. Analyze the supplied snapshot, separating facts from interpretation. Output JSON only with keys: regime, gold_bias (LONG BIAS|SHORT BIAS|WAIT|NO TRADE), confidence (0-100; evidence strength, not probability of profit), bull_case, bear_case, what_changes_our_mind, event_risk, execution_note. execution_note must emphasize confirmation and max planned risk 0.25%. Snapshot: ${JSON.stringify(market)}`;
  try{
    const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${key}`},body:JSON.stringify({model:'gpt-5-mini',input:prompt})});
    const j=await r.json();
    if(!r.ok) return res.status(r.status).json({error:j?.error?.message||'OpenAI request failed'});
    const text=j.output_text || j?.output?.flatMap(o=>o.content||[]).map(c=>c.text||'').join('') || '';
    let parsed; try{parsed=JSON.parse(text)}catch{parsed={raw:text}}
    res.status(200).json({ok:true,analysis:parsed});
  }catch(e){res.status(500).json({error:e.message})}
}
