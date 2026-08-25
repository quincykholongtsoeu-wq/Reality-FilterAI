const TIMEOUT_MS=7000;
const FRED_BASE='https://api.stlouisfed.org/fred';

async function fetchWithTimeout(url,options={}){
  const c=new AbortController();
  const t=setTimeout(()=>c.abort(),TIMEOUT_MS);
  try{return await fetch(url,{...options,signal:c.signal})}
  finally{clearTimeout(t)}
}

function day(s){return String(s||'').slice(0,10)}
function nowIso(){return new Date().toISOString()}
function pctChange(a,b){return Number.isFinite(a)&&Number.isFinite(b)&&b!==0?((a-b)/Math.abs(b))*100:null}

const SPECS=[
  {
    id:'CPI',
    title:'US Consumer Price Index (CPI)',
    releaseMatchers:['consumer price index'],
    series:'CPIAUCSL',
    family:'INFLATION',
    unit:'index',
    goldRule:'Higher inflation can pressure gold if it lifts rate/yield expectations; softer inflation can support gold if yields fall.'
  },
  {
    id:'CORE_CPI',
    title:'US Core CPI',
    releaseMatchers:['consumer price index'],
    series:'CPILFESL',
    family:'INFLATION',
    unit:'index',
    goldRule:'A hotter core trend is typically a gold headwind through yields/USD; a cooler trend can be supportive.'
  },
  {
    id:'NFP',
    title:'US Nonfarm Payrolls',
    releaseMatchers:['employment situation'],
    series:'PAYEMS',
    family:'LABOR',
    unit:'thousand jobs',
    goldRule:'Stronger labor can support yields/USD and weigh on gold; weaker labor can do the opposite.'
  },
  {
    id:'UNRATE',
    title:'US Unemployment Rate',
    releaseMatchers:['employment situation'],
    series:'UNRATE',
    family:'LABOR',
    unit:'percent',
    invert:true,
    goldRule:'A higher unemployment rate can reduce rate pressure and support gold; a lower rate can support yields/USD.'
  },
  {
    id:'CORE_PCE',
    title:'US Core PCE Price Index',
    releaseMatchers:['personal income and outlays','personal income'],
    series:'PCEPILFE',
    family:'INFLATION',
    unit:'index',
    goldRule:'Core PCE is a key Fed inflation gauge. Softer inflation is generally gold-supportive through lower yield pressure.'
  },
  {
    id:'GDP',
    title:'US Real GDP',
    releaseMatchers:['gross domestic product'],
    series:'GDPC1',
    family:'GROWTH',
    unit:'billions chained dollars',
    goldRule:'Stronger growth can support yields/USD; weaker growth can support gold when it reduces rate expectations.'
  }
];

function fredUrl(path,key,params={}){
  const u=new URL(`${FRED_BASE}/${path}`);
  u.searchParams.set('api_key',key);
  u.searchParams.set('file_type','json');
  for(const[k,v]of Object.entries(params))if(v!==undefined&&v!==null)u.searchParams.set(k,String(v));
  return u;
}

async function getJson(url){
  const r=await fetchWithTimeout(url,{headers:{'user-agent':'gold-desk/0.9.1'}});
  if(!r.ok)throw new Error(`FRED HTTP ${r.status}`);
  return r.json();
}

async function getReleases(key){
  const j=await getJson(fredUrl('releases',key,{limit:1000,order_by:'name',sort_order:'asc'}));
  return Array.isArray(j?.releases)?j.releases:[];
}

function matchRelease(releases,matchers){
  const ms=matchers.map(x=>x.toLowerCase());
  return releases.find(r=>ms.some(m=>String(r?.name||'').toLowerCase().includes(m)))||null;
}

async function getReleaseDates(key,releaseId){
  if(!releaseId)return[];
  const today=new Date();
  const start=new Date(today.getTime()-2*86400000).toISOString().slice(0,10);
  const end=new Date(today.getTime()+45*86400000).toISOString().slice(0,10);
  const j=await getJson(fredUrl('release/dates',key,{
    release_id:releaseId,
    realtime_start:start,
    realtime_end:end,
    include_release_dates_with_no_data:'true',
    limit:1000,
    sort_order:'asc'
  }));
  return Array.isArray(j?.release_dates)?j.release_dates:[];
}

async function getLatestSeries(key,series){
  const j=await getJson(fredUrl('series/observations',key,{
    series_id:series,
    sort_order:'desc',
    limit:12
  }));
  const vals=[];
  for(const o of j?.observations||[]){
    if(o?.value==='.'||o?.value==null)continue;
    const v=Number(o.value);
    if(Number.isFinite(v))vals.push({date:o.date,value:v});
    if(vals.length>=2)break;
  }
  return vals;
}

function directionalRead(spec,latest,previous){
  if(!Number.isFinite(latest)||!Number.isFinite(previous))return{label:'AWAITING OFFICIAL DATA',goldImpulse:'UNKNOWN',delta:null,changePct:null};
  const delta=latest-previous;
  const cp=pctChange(latest,previous);
  const eps=Math.max(Math.abs(previous)*0.0005,0.0001);
  if(Math.abs(delta)<=eps)return{label:'LITTLE CHANGE VS PREVIOUS',goldImpulse:'NEUTRAL',delta,changePct:cp};
  let stronger=delta>0;
  if(spec.invert)stronger=!stronger;
  let label;
  if(spec.family==='INFLATION')label=delta>0?'HOTTER TREND VS PREVIOUS':'COOLER TREND VS PREVIOUS';
  else if(spec.family==='LABOR')label=stronger?'STRONGER LABOR TREND':'WEAKER LABOR TREND';
  else if(spec.family==='GROWTH')label=delta>0?'STRONGER GROWTH TREND':'WEAKER GROWTH TREND';
  else label=delta>0?'HIGHER VS PREVIOUS':'LOWER VS PREVIOUS';
  const goldImpulse=stronger?'BEARISH GOLD PRESSURE':'BULLISH GOLD PRESSURE';
  return{label,goldImpulse,delta,changePct:cp};
}

function chooseUpcoming(dates){
  const cutoff=Date.now()-24*60*60*1000;
  for(const d of dates){
    const ts=Date.parse(d?.date);
    if(Number.isFinite(ts)&&ts>=cutoff)return d;
  }
  return dates[dates.length-1]||null;
}

async function buildEvent(spec,releases,key){
  const rel=matchRelease(releases,spec.releaseMatchers);
  const [datesResult,seriesResult]=await Promise.allSettled([
    getReleaseDates(key,rel?.id),
    getLatestSeries(key,spec.series)
  ]);
  const dates=datesResult.status==='fulfilled'?datesResult.value:[];
  const vals=seriesResult.status==='fulfilled'?seriesResult.value:[];
  const latest=vals[0]||null,previous=vals[1]||null;
  const scheduled=chooseUpcoming(dates);
  const read=directionalRead(spec,latest?.value,previous?.value);
  return{
    id:spec.id,
    title:spec.title,
    date:scheduled?.date||null,
    actual:latest?.value??null,
    actualDate:latest?.date||null,
    forecast:null,
    previous:previous?.value??null,
    previousDate:previous?.date||null,
    unit:spec.unit,
    family:spec.family,
    releaseName:rel?.name||null,
    releaseId:rel?.id||null,
    source:'FRED',
    surprise:{
      available:false,
      family:spec.family,
      label:'NO CONSENSUS FORECAST — OFFICIAL TREND ONLY',
      delta:read.delta,
      goldImpulse:read.goldImpulse
    },
    officialTrend:read,
    goldRule:spec.goldRule,
    diagnostics:{
      releaseDatesOk:datesResult.status==='fulfilled',
      seriesOk:seriesResult.status==='fulfilled',
      releaseDatesError:datesResult.status==='rejected'?(datesResult.reason?.message||String(datesResult.reason)):null,
      seriesError:seriesResult.status==='rejected'?(seriesResult.reason?.message||String(seriesResult.reason)):null
    }
  };
}

export default async function handler(req,res){
  res.setHeader('Cache-Control','s-maxage=300, stale-while-revalidate=900');
  const key=process.env.FRED_API_KEY;
  if(!key)return res.status(200).json({
    ok:false,
    version:'0.9.1',
    source:'FRED',
    generatedAt:nowIso(),
    events:[],
    error:'FRED_API_KEY is missing',
    note:'Zero-cost Event Engine requires the existing FRED_API_KEY.'
  });
  try{
    const releases=await getReleases(key);
    const settled=await Promise.allSettled(SPECS.map(s=>buildEvent(s,releases,key)));
    const events=settled.filter(x=>x.status==='fulfilled').map(x=>x.value).filter(e=>e.date||e.actual!==null);
    events.sort((a,b)=>{
      const ad=a.date?Date.parse(a.date):Number.MAX_SAFE_INTEGER;
      const bd=b.date?Date.parse(b.date):Number.MAX_SAFE_INTEGER;
      return ad-bd;
    });
    const degraded=settled.filter(x=>x.status==='rejected').length;
    const bullish=events.filter(e=>e.officialTrend?.goldImpulse==='BULLISH GOLD PRESSURE').length;
    const bearish=events.filter(e=>e.officialTrend?.goldImpulse==='BEARISH GOLD PRESSURE').length;
    return res.status(200).json({
      ok:true,
      version:'0.9.1',
      engine:'ZERO_COST_FIRST_PARTY_EVENT_ENGINE',
      source:'FRED official release calendar + FRED official series',
      generatedAt:nowIso(),
      events:events.slice(0,12),
      surpriseSummary:{
        trueConsensusSurprises:0,
        bullishGoldTrendSignals:bullish,
        bearishGoldTrendSignals:bearish,
        degradedFeeds:degraded
      },
      capabilities:{
        officialReleaseSchedule:true,
        officialActuals:true,
        previousValues:true,
        paidConsensusForecasts:false,
        actualVsForecastSurprise:false,
        actualVsPreviousTrend:true
      },
      note:'Zero-cost mode uses official FRED schedules and official data. Consensus forecasts are intentionally unavailable, so Gold Desk does not pretend to calculate an Actual-vs-Forecast surprise.'
    });
  }catch(e){
    return res.status(200).json({
      ok:false,
      version:'0.9.1',
      source:'FRED',
      generatedAt:nowIso(),
      events:[],
      error:e?.name==='AbortError'?'FRED Event Engine timed out':(e?.message||String(e)),
      note:'Core Gold/DXY/yield engine can continue even if the event engine is degraded.'
    });
  }
}
