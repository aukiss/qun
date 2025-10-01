
// netlify/functions/tutor.js  (v11 — backend rewrite, UI unchanged)
// Keep schema compatible with your current index.html:
//   { meta, items: [ { id, type, stem, options?, answer, explain, hint } ] }
const TIMEOUT_MS = 22000;  // each upstream call
const BATCH_SIZE = 4;      // items per batch
const CONCURRENCY = 2;     // parallel upstream calls
const MAX_TOKENS = 1200;   // cap tokens per batch

function clampInt(n, lo, hi, d=10){ const x = parseInt(n ?? d, 10); return Math.max(lo, Math.min(hi, isNaN(x)? d : x)); }
const TYPES_ALL = ['choice','error','transform','fill','rearrange','reading'];
function pickTypes(arr){ const t = Array.isArray(arr) && arr.length ? arr : TYPES_ALL; return t.filter(x=>TYPES_ALL.includes(String(x))); }

function sysPrompt({mode, count, types, level, focus}){
  return `你是一名小学英语教研员，熟悉六年级（译林版）语法要求。根据参数生成题库，并**严格输出 JSON**（不要多余文字）。
【目标】题目贴近六年级：时态（一般现在/过去/现在进行）、主谓一致、代词（物主/反身）、形容词/副词比较级、句型转换、连词成句、填空等。
【风格】讲解口语化、**分步骤**、举例子，解释“为什么错”和“如何快速判断”。
【难度】本次：${level}
【只输出 JSON】：
{
  "meta": { "version": "1.0", "level": "easy|normal|hard", "types": ["choice", ...] },
  "items": [
    {
      "id": "q1",
      "type": "choice|error|transform|fill|rearrange|reading",
      "stem": "题干（中文操作指令 + 英文材料/句子；如为填空，用 (   ) 表示空）",
      "options": [ { "value": "A", "text": "选项文本" }, { "value": "B", "text": "..." }, { "value": "C", "text": "..." }, { "value": "D", "text": "..." } ], // 仅 choice/reading 需要
      "answer": "A" | "答案文本" | ["可接受多个写法"],
      "explain": "分步讲解：\\n1) 先看时间状语…\\n2) 判断时态/主谓一致…\\n3) 应用规则…\\n举例：This/That…",
      "hint": "一句中文提示，可空"
    }
  ]
}
【出题参数】
- 模式: ${mode}（grammar=语法综合；tense=时态专项）
- 数量: ${count}
- 题型: ${types.join(', ')}
- 难度: ${level}
- 知识点优先: "${focus || '无'}"
【约束】
- **可判分**：choice 的 answer 用 "A/B/C/D"；其他题型的 answer 用文本或可接受数组；
- 改错：只包含 1 处典型小错；答案必须给“改正后的完整句”；
- 句型转换：限定肯否/一般疑问句/三大常见时态转换；
- 连词成句：5–8 个常见词，注意大写和标点；
- 填空：用 (   ) 表示空；答案简短明确；
- 题干简洁、生活化语境（校园/家庭/兴趣活动）；
- **严格返回 JSON**，不要 markdown 代码块。`;
}

function userPrompt({count, types, level, focus, mode}){
  return `请生成 ${count} 道题。题型：${types.join(', ')}；难度：${level}；知识点优先：${focus || '无'}；模式：${mode}。\\n严格只返回 {"items":[...]}。`;
}

function sanitizeStr(s, max=400){ return String(s||'').replace(/\u200b/g,'').trim().slice(0,max); }
function sanitizeStem(stem){ 
  // 避免把“参考答案：”这类提示误塞进题干
  return sanitizeStr(stem, 400).replace(/(?:参考答案|答案)\s*[:：].*$/i, '').trim();
}
function sanitizeOptions(opts){
  if(!Array.isArray(opts)) return [];
  const letters = ['A','B','C','D'];
  return opts.slice(0,4).map((op, i)=>{
    const text = sanitizeStr((op && (op.text ?? op)) || '', 160).replace(/^\s*[A-D]\s*[\)\.\u3001、]\s*/i,'');
    return { value: letters[i] || 'A', text };
  }).filter(o=>o.text);
}
function sanitizeAnswer(type, ans){
  if(type==='choice' || type==='reading'){
    const v = String(ans||'A').toUpperCase();
    return ['A','B','C','D'].includes(v) ? v : 'A';
  }
  if(Array.isArray(ans)){
    const arr = ans.map(s=> sanitizeStr(s, 120)).filter(Boolean);
    return arr.length ? arr : '';
  }
  return sanitizeStr(ans, 160);
}
function sanitizeExplain(s){ return sanitizeStr(s, 1200); }
function sanitizeHint(s){ return sanitizeStr(s, 160); }

async function callUpstream({ BASE, KEY, MODEL, systemContent, userContent }){
  const url = `${BASE.replace(/\/+$/,'')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), TIMEOUT_MS);
  try{
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL || 'gpt-4o-mini',
        temperature: 0.5,
        max_tokens: MAX_TOKENS,
        messages: [
          { role: 'system', content: systemContent },
          { role: 'user', content: userContent }
        ]
      }),
      signal: controller.signal
    });
    if(!resp.ok){
      const t = await resp.text().catch(()=>'');
      return { ok:false, status: resp.status, detail: t.slice(0,1500) };
    }
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content?.trim() || '';
    let json;
    try{ json = JSON.parse(content); }
    catch(e){
      const m = content.match(/```json\s*([\s\S]*?)```/i);
      if(m){ json = JSON.parse(m[1]); } else {
        return { ok:false, status: 502, detail: 'invalid JSON', raw: content };
      }
    }
    const items = Array.isArray(json?.items) ? json.items : [];
    return { ok:true, data: items };
  }catch(err){
    return { ok:false, status: 504, detail: 'timeout or fetch error: ' + (err?.message || String(err)) };
  }finally{
    clearTimeout(timer);
  }
}

// simple concurrency
async function mapLimit(arr, limit, iteratee){
  const ret=[]; const executing=[];
  for(const item of arr){
    const p = Promise.resolve().then(()=>iteratee(item));
    ret.push(p);
    const e = p.then(()=> executing.splice(executing.indexOf(e),1));
    executing.push(e);
    if(executing.length >= limit) await Promise.race(executing);
  }
  return Promise.all(ret);
}

// Normalize one item to our schema
function normItem(it, idx){
  const type = String(it?.type || 'choice').toLowerCase();
  const id = String(it?.id || `q${idx+1}`);
  const stem = sanitizeStem(it?.stem || '');
  const options = sanitizeOptions(it?.options || []);
  const answer = sanitizeAnswer(type, it?.answer);
  const explain = sanitizeExplain(it?.explain || '');
  const hint = sanitizeHint(it?.hint || '');
  return { id, type, stem, options: (type==='choice'||type==='reading') ? options : [], answer, explain, hint };
}

exports.handler = async (event) => {
  try{
    if(event.httpMethod !== 'POST'){
      return { statusCode: 405, body: JSON.stringify({ error: 'Use POST' }) };
    }
    const { OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL } = process.env;
    if(!OPENAI_API_KEY || !OPENAI_BASE_URL){
      return { statusCode: 500, body: JSON.stringify({ error: 'Missing OPENAI_API_KEY or OPENAI_BASE_URL' }) };
    }
    let payload={};
    try{ payload = JSON.parse(event.body || '{}'); }
    catch{ return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

    const total = clampInt(payload.count, 1, 20, 10);
    const types = pickTypes(payload.types);
    const level = ['easy','normal','hard'].includes(payload.level) ? payload.level : 'normal';
    const focus = (payload.focus || '').toString();
    const mode = (payload.mode === 'tense') ? 'tense' : 'grammar';

    // Split to batches
    const batches=[]; let remain=total;
    while(remain>0){ const c=Math.min(BATCH_SIZE, remain); batches.push(c); remain-=c; }

    let items=[];
    const first = await mapLimit(batches, CONCURRENCY, async (cnt)=>{
      const sp = sysPrompt({mode, count: cnt, types, level, focus});
      const up = userPrompt({count: cnt, types, level, focus, mode});
      return callUpstream({ BASE: OPENAI_BASE_URL, KEY: OPENAI_API_KEY, MODEL: OPENAI_MODEL, systemContent: sp, userContent: up });
    });

    const retry=[];
    first.forEach((r,i)=>{
      if(r.ok && Array.isArray(r.data)) items = items.concat(r.data.map((it,idx)=> normItem(it, i*BATCH_SIZE+idx)));
      else retry.push({ need: batches[i], err: r });
    });

    // retry smaller
    for(const r of retry){
      const need = Math.min(3, r.need);
      const sp = sysPrompt({mode, count: need, types, level, focus});
      const up = userPrompt({count: need, types, level, focus, mode});
      const rr = await callUpstream({ BASE: OPENAI_BASE_URL, KEY: OPENAI_API_KEY, MODEL: OPENAI_MODEL, systemContent: sp, userContent: up });
      if(rr.ok && Array.isArray(rr.data)){
        items = items.concat(rr.data.map((it,idx)=> normItem(it, items.length+idx)));
      }
    }

    // Trim/pad
    items = items.slice(0, total);
    while(items.length < total && items.length>0){
      const n = { ...items[items.length-1] };
      n.id = `q${items.length+1}`;
      items.push(n);
    }

    const meta = { version: '1.0', level, types };
    const body = JSON.stringify({ meta, items });

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
      },
      body
    };
  }catch(err){
    return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: err.message || String(err) }) };
  }
};
