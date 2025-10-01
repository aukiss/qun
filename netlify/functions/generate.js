
// netlify/functions/generate.js
// v9 prompt patch — batched & resilient (fix 504 timeouts)
// Uses tutor-style prompt but outputs the v9 frontend schema.
// Splits total count into small batches to avoid upstream timeout.

const TIMEOUT_MS = 22000; // per-call timeout
const BATCH_SIZE = 4;     // questions per request
const CONCURRENCY = 2;    // parallel requests

function sanitizeOptionText(s){
  return String(s||'').replace(/^\s*[A-D]\s*[\)\.\u3001、]\s*/i,'').trim().slice(0,200);
}

function mapTypes(form, subtype){
  if (form === "mcq") return ["choice"];
  if (form === "short"){
    if (subtype === "short-correct") return ["error"];
    if (subtype === "short-transform") return ["transform"];
    if (subtype === "short-reorder") return ["rearrange"];
    return ["fill"];
  }
  return ["choice","error","transform","fill","rearrange"];
}

function buildTutorSystemPrompt({ mode, count, types, level="normal", focus="" }){
  return `你是一名小学英语教研员，熟悉六年级语法要求。请生成题库，并严格输出 JSON（不要多余文字）。
【目标】六年级题目：时态（一般现在/过去/进行）、主谓一致、代词、比较级、句型转换、连词成句、填空等。讲解口语化、分步骤、举例子，解释为什么错。
【难度】easy/normal/hard（本次：${level}）
【只输出 JSON】仅返回 {"items":[...]}，不要 markdown。
每题字段：
{ "type":"choice|error|transform|fill|rearrange",
  "stem":"英文题干（必要时中文操作提示可放在前缀，但英文内容不要翻译中文）",
  "options":[{"value":"A","text":"..."},{"value":"B","text":"..."},{"value":"C","text":"..."},{"value":"D","text":"..."}], // 仅 choice
  "answer":"A"|"文本"|["可接受多个"],
  "explain":"中文分步讲解：1) … 2) … 3) …（语气温和）",
  "hint":"中文一句提示"
}
【出题参数】模式:${mode}；数量:${count}；题型:${types.join(', ')}；知识点优先:"${focus}"。
【约束】选择题仅 1 个正确项；改错返回“改正后的完整句”；连词成句给打乱词；填空用 (   ) 表示空。`;
}

function buildTutorUserPrompt({ count, types, level="normal", focus="", mode }){
  return `请生成 ${count} 道题。题型：${types.join(', ')}；难度：${level}；知识点：${focus || '无'}；模式：${mode}。\n严格只返回 {"items":[...]}。`;
}

async function callLLM({ BASE, KEY, MODEL, systemContent, userContent, count }){
  const url = `${BASE.replace(/\/+$/,'')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), TIMEOUT_MS);
  try{
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL || 'gpt-4o-mini',
        temperature: 0.45,
        max_tokens: 1100,
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
    // Try parse JSON
    let json;
    try { json = JSON.parse(content); }
    catch(e){
      const m = content.match(/```json\s*([\s\S]*?)```/i);
      if(m){ json = JSON.parse(m[1]); } else {
        // crude salvage: find "items":[ ... ]
        const m2 = content.match(/"items"\s*:\s*(\[[\s\S]*\])/);
        if(m2){ json = { items: JSON.parse(m2[1]) }; }
      }
    }
    const items = Array.isArray(json?.items) ? json.items.slice(0, count) : [];
    return { ok:true, data: items };
  }catch(err){
    return { ok:false, status: 504, detail: 'timeout or fetch error: ' + (err?.message || String(err)) };
  }finally{
    clearTimeout(timer);
  }
}

function toV9Schema(item){
  const t = String(item.type || '').toLowerCase();
  const isMCQ = t === 'choice';
  const question_type = isMCQ ? 'mcq' : 'short';
  const question = String(item.stem || '').slice(0, 500);
  const options = isMCQ && Array.isArray(item.options)
    ? item.options.slice(0,4).map((op,i)=>{
        const text = sanitizeOptionText(op?.text ?? op);
        const alpha = ['A','B','C','D'][i] || 'A';
        return `${alpha}) ${text}`;
      })
    : [];
  let answer_letter = '';
  let answer_text = '';
  if (isMCQ){
    const v = String(item.answer || 'A').toUpperCase();
    answer_letter = ['A','B','C','D'].includes(v) ? v : 'A';
    const idx = {A:0,B:1,C:2,D:3}[answer_letter] ?? 0;
    answer_text = options[idx] ? options[idx].replace(/^\s*[A-D]\)\s*/,'') : '';
  } else {
    if (Array.isArray(item.answer)){
      answer_text = String(item.answer[0] || '').slice(0, 200);
    } else {
      answer_text = String(item.answer || '').slice(0, 200);
    }
  }
  const explain = String(item.explain || '').slice(0, 1200);
  const hint = String(item.hint || '').slice(0, 200);
  const answer_explanation = [
    isMCQ ? `参考答案：${answer_letter}` : (answer_text ? `参考答案：${answer_text}` : '参考答案：'),
    explain ? `分步讲解：\n${explain}` : '',
    hint ? `\n提示：${hint}` : ''
  ].join('\n').trim();

  return { question_type, question, options, answer_letter, answer_text, answer_explanation };
}

// Simple concurrency control
async function mapLimit(arr, limit, iteratee){
  const ret = [];
  const executing = [];
  for (const item of arr){
    const p = Promise.resolve().then(()=>iteratee(item));
    ret.push(p);
    const e = p.then(()=> executing.splice(executing.indexOf(e),1));
    executing.push(e);
    if(executing.length >= limit){
      await Promise.race(executing);
    }
  }
  return Promise.all(ret);
}

exports.handler = async (event) => {
  try{
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }
    const body = JSON.parse(event.body || '{}');
    const questionType = body.questionType || 'grammar'; // grammar | tenses
    const form = body.form || 'mixed'; // mcq | short | mixed
    const subtype = body.subtype || ''; // short-correct | short-transform | short-reorder
    const total = Math.min(Math.max(parseInt(body.questionCount || 10, 10), 1), 40);

    const BASE = process.env.OPENAI_BASE_URL;
    const KEY = process.env.OPENAI_API_KEY;
    const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    if (!BASE || !KEY){
      return { statusCode: 500, body: JSON.stringify({ error: 'Server not configured: missing OPENAI_BASE_URL or OPENAI_API_KEY' }) };
    }

    const types = mapTypes(form, subtype);
    const mode = (questionType === 'tenses') ? 'tense' : 'grammar';
    const level = 'normal';
    const focus = '';

    // Build batch tasks
    const batches = [];
    let remain = total;
    while(remain > 0){
      const c = Math.min(BATCH_SIZE, remain);
      batches.push(c);
      remain -= c;
    }

    let results = [];
    const first = await mapLimit(batches, CONCURRENCY, async (count)=>{
      const systemPrompt = buildTutorSystemPrompt({ mode, count, types, level, focus });
      const userPrompt = buildTutorUserPrompt({ count, types, level, focus, mode });
      const res = await callLLM({ BASE, KEY, MODEL, systemContent: systemPrompt, userContent: userPrompt, count });
      return res;
    });

    const retry = [];
    first.forEach((r, i)=>{
      if (r.ok && Array.isArray(r.data)) results = results.concat(r.data.map(toV9Schema));
      else retry.push({ need: batches[i], err: r });
    });

    if (retry.length){
      // retry with smaller count (max 3) sequentially
      for (const r of retry){
        const need = Math.min(3, r.need);
        const systemPrompt = buildTutorSystemPrompt({ mode, count: need, types, level, focus });
        const userPrompt = buildTutorUserPrompt({ count: need, types, level, focus, mode });
        const res2 = await callLLM({ BASE, KEY, MODEL, systemContent: systemPrompt, userContent: userPrompt, count: need });
        if (res2.ok && Array.isArray(res2.data)){
          results = results.concat(res2.data.map(toV9Schema));
        }
      }
    }

    // Trim / pad
    results = results.slice(0, total);
    while (results.length < total && results.length>0){
      results.push(results[results.length-1]);
    }

    if (!results.length){
      return { statusCode: 504, body: JSON.stringify({ error: 'Upstream timeout or invalid response.' }) };
    }

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(results) };
  }catch(err){
    return { statusCode: 500, body: JSON.stringify({ error: err.message || String(err) }) };
  }
};
