
// netlify/functions/tutor.mjs (v11 ESM) — optional Edge Functions variant
export default async (req, context) => {
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Use POST' }), { status: 405 });
  const { OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL } = process.env;
  if (!OPENAI_API_KEY || !OPENAI_BASE_URL) return new Response(JSON.stringify({ error: 'Missing OPENAI_API_KEY or OPENAI_BASE_URL' }), { status: 500 });
  let payload={}; try{ payload = await req.json(); } catch{ return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

  const TIMEOUT_MS = 22000, BATCH_SIZE=4, CONCURRENCY=2, MAX_TOKENS=1200;
  const TYPES_ALL = ['choice','error','transform','fill','rearrange','reading'];
  const clampInt=(n,lo,hi,d=10)=>{ const x=parseInt(n??d,10); return Math.max(lo, Math.min(hi, isNaN(x)? d : x)); };
  const pickTypes=(arr)=> (Array.isArray(arr)&&arr.length? arr: TYPES_ALL).filter(x=>TYPES_ALL.includes(String(x)));
  const sanitize=(s,max=400)=> String(s||'').replace(/\u200b/g,'').trim().slice(0,max);
  const sanitizeStem=(s)=> sanitize(s,400).replace(/(?:参考答案|答案)\s*[:：].*$/i,'').trim();
  const sanitizeOptions=(opts)=> Array.isArray(opts)? opts.slice(0,4).map((op,i)=>({ value:['A','B','C','D'][i]||'A', text: sanitize((op?.text??op)||'',160).replace(/^\s*[A-D]\s*[\)\.\u3001、]\s*/i,'') })).filter(o=>o.text) : [];
  const sanitizeAnswer=(type,ans)=> (type==='choice'||type==='reading') ? (['A','B','C','D'].includes(String(ans||'A').toUpperCase())? String(ans||'A').toUpperCase() : 'A') : (Array.isArray(ans)? (ans.map(s=>sanitize(s,120)).filter(Boolean)||'') : sanitize(ans,160));
  const sanitizeExplain=(s)=> sanitize(s,1200);
  const sanitizeHint=(s)=> sanitize(s,160);

  const sysPrompt=({mode,count,types,level,focus})=>`你是一名小学英语教研员…（同 CJS 版本，略）数量:${count} 题型:${types.join(', ')}`;
  const userPrompt=({count,types,level,focus,mode})=>`请生成 ${count} 道题…严格只返回 {"items":[...]}`;

  async function callUpstream(systemContent, userContent){
    const url = `${OPENAI_BASE_URL.replace(/\/+$/,'')}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), TIMEOUT_MS);
    try{
      const resp = await fetch(url, {
        method:'POST', headers:{ 'Authorization':`Bearer ${OPENAI_API_KEY}`, 'Content-Type':'application/json' },
        body: JSON.stringify({ model: OPENAI_MODEL||'gpt-4o-mini', temperature:0.5, max_tokens:MAX_TOKENS, messages:[{role:'system',content:systemContent},{role:'user',content:userContent}] }),
        signal: controller.signal
      });
      if(!resp.ok) return { ok:false, status: resp.status, detail: await resp.text().catch(()=> '') };
      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content?.trim() || '';
      let json; try{ json = JSON.parse(content) } catch(e){ const m=content.match(/```json\s*([\s\S]*?)```/i); if(m){ json=JSON.parse(m[1]) } else { return { ok:false, status:502, detail:'invalid JSON' } } }
      return { ok:true, data: Array.isArray(json?.items)? json.items : [] };
    }catch(err){ return { ok:false, status:504, detail: 'timeout or fetch error: '+(err?.message||String(err)) } }
    finally{ clearTimeout(timer); }
  }

  const total = clampInt(payload.count, 1, 20, 10);
  const types = pickTypes(payload.types);
  const level = ['easy','normal','hard'].includes(payload.level) ? payload.level : 'normal';
  const focus = (payload.focus || '').toString();
  const mode = (payload.mode === 'tense') ? 'tense' : 'grammar';

  const batches=[]; let remain=total; while(remain>0){ const c=Math.min(BATCH_SIZE, remain); batches.push(c); remain-=c; }
  let items=[];
  const first = await Promise.all(batches.map(async (cnt)=> callUpstream(sysPrompt({mode,count:cnt,types,level,focus}), userPrompt({count:cnt,types,level,focus,mode})) ));
  const retry=[];
  first.forEach((r,i)=>{ if(r.ok && Array.isArray(r.data)) items=items.concat(r.data.map((it,idx)=> ({ id:`q${items.length+idx+1}`, type:String(it?.type||'choice').toLowerCase(), stem:sanitizeStem(it?.stem||''), options:(['choice','reading'].includes(String(it?.type).toLowerCase())? sanitizeOptions(it?.options||[]) : []), answer:sanitizeAnswer(String(it?.type||'choice').toLowerCase(), it?.answer), explain:sanitizeExplain(it?.explain||''), hint:sanitizeHint(it?.hint||'') }))); else retry.push({ need:batches[i], err:r }); });
  for(const r of retry){ const need=Math.min(3,r.need); const rr = await callUpstream(sysPrompt({mode,count:need,types,level,focus}), userPrompt({count:need,types,level,focus,mode})); if(rr.ok && Array.isArray(rr.data)){ items=items.concat(rr.data.map((it,idx)=> ({ id:`q${items.length+idx+1}`, type:String(it?.type||'choice').toLowerCase(), stem:sanitizeStem(it?.stem||''), options:(['choice','reading'].includes(String(it?.type).toLowerCase())? sanitizeOptions(it?.options||[]) : []), answer:sanitizeAnswer(String(it?.type||'choice').toLowerCase(), it?.answer), explain:sanitizeExplain(it?.explain||''), hint:sanitizeHint(it?.hint||'') }))); } }
  items = items.slice(0,total); while(items.length<total && items.length>0){ const n={...items[items.length-1]}; n.id=`q${items.length+1}`; items.push(n); }

  return new Response(JSON.stringify({ meta:{ version:'1.0', level, types }, items }), { status:200, headers:{ 'Content-Type':'application/json','Cache-Control':'no-store','Access-Control-Allow-Origin':'*' } });
};
