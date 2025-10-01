
// netlify/functions/generate.js
// Clean rewrite for V9 UI: returns exactly 6 fields per item.
// Uses the same prompt spec as tutor.js (user-provided).
// Robust batching, timeout, codeblock-JSON rescue, explanation fallback.

const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || '22000', 10);
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '5', 10);
const PARALLEL   = parseInt(process.env.PARALLEL   || '2', 10);

const ABCD = ['A','B','C','D'];

function clean(s){ return String(s||'').trim(); }
function stripLabel(x){ return clean(x).replace(/^\s*[A-D]\s*[\)\.\u3001、]\s*/i,''); }
function ensureABCD(options){
  const arr = (Array.isArray(options)? options: []).slice(0,4);
  const out = [];
  for (let i=0;i<4;i++){
    const t = arr[i];
    const txt = (t && (t.text ?? t)) ? String(t.text ?? t) : '';
    out.push(`${ABCD[i]}) ${stripLabel(txt)}`);
  }
  return out;
}
function toLetter(a){ const x = String(a||'A').toUpperCase(); return ABCD.includes(x)?x:'A'; }

function normalizeSteps(explain, stem){
  const raw = clean(explain);
  if (!raw){
    // heuristic
    const l = stem.toLowerCase();
    const steps = [];
    if (/yesterday|last\s+(night|week|month|year)|ago|in\s+20\d{2}/i.test(stem)) steps.push('1) 先看时间词：过去时信号 → 一般过去时。');
    else if (/now|right now|at the moment|look!|listen!/i.test(stem)) steps.push('1) 先看时间词：正在发生 → 现在进行时。');
    else steps.push('1) 先看时间词：频率/习惯词 → 一般现在时。');
    steps.push('2) 判断主语人称数（he/she/it 为第三人称单数）。');
    steps.push('3) 选择正确形式或按要求改写。');
    steps.push('举例：把答案放回句子读一读是否通顺。');
    return '分步讲解：\n' + steps.join('\n');
  }
  // normalize numbering
  const lines = raw.replace(/\r/g,'').split(/\n+/).map(s=>s.trim()).filter(Boolean);
  const norm = lines.map((s,i)=> s.replace(/^\d+\s*[\)\.、）]\s*/,'').replace(/^[①②③④⑤⑥⑦⑧⑨]\s*/,'')).map((s,i)=>`${i+1}) ${s}`);
  return '分步讲解：\n' + norm.join('\n');
}

function tutorSystemPrompt({count, types, level, focus, mode}){
  return `你是一名小学英语教研员，熟悉“译林版”六年级下/上册语法要求。请根据参数生成题库，并严格输出 JSON（不要多余文字）。
【目标】生成适合六年级学生的题目，覆盖：时态（一般现在/过去/进行）、主谓一致、代词（物主/反身）、形容词/副词比较级与最高级、句型转换、连词成句、短文语法选择。讲解要口语化、分步骤、举例子，解释为什么错。
【难度】
- easy：概念直给+明显提示
- normal：常规课内
- hard：选择更易混点、加干扰项
【格式】只输出 JSON（面向学生的操作提示用中文，例如“把下列句子改为否定句/一般疑问句/选择正确形式”；英语例句本身保持英文）：
{
  "meta": { "version": "1.0", "level": "normal|easy|hard", "types": ["choice", ...] },
  "items": [
    {
      "id": "q1",
      "type": "choice|error|transform|fill|rearrange|reading",
      "stem": "题干（中文或英文+必要上下文）",
      "options": [ { "value": "A", "text": "选项文本" }, ... ],
      "answer": "A" | "答案文本" | ["可接受多个"],
      "explain": "分步讲解：\\n1) 先看时间状语…\\n2) 主语是三单…\\n3) 规则/不规则变化…\\n举例：This/That…",
      "hint": "给学生的小提示，可空"
    }
  ]
}
【出题参数】
- 模式: ${mode}（grammar=语法综合；tense=时态专项，仅围绕一般现在/一般过去/现在进行混合）
- 数量: ${count}
- 题型: ${types.join(', ')}
- 难度: ${level}
- 知识点优先: "${focus}"
【约束】
- 操作指令必须中文；避免出现“Transform this sentence ...”这类英文提示。
- 模式为 tense 时：每题都聚焦三类时态，解析强调“看时间状语→判时态→动词形式/句型转换”。
- 严格可判分：选择题 answer 用 "A/B/C/D"；填空给出唯一或可接受数组；改错题提供“错因+正确句子”。
- 题干简洁，贴六年级生活语境（上学、课余、家庭、校园活动）。
- 解析要让“做错的孩子也能看懂”，避免术语堆砌，强调“如何快速判断”。`;
}
function tutorUserPrompt({count, types, level, focus, mode}){
  return `请生成 ${count} 道题。题型：${types.join(', ')}；难度：${level}；知识点优先：${focus || '无特别指定'}；模式：${mode}。\\n严格只返回 JSON。`;
}

async function callLLM(batchCount, params, signal){
  const { OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL } = process.env;
  const url = `${OPENAI_BASE_URL.replace(/\/+$/,'')}/chat/completions`;
  const body = {
    model: OPENAI_MODEL || 'gpt-4o-mini',
    temperature: 0.55,
    messages: [
      { role: 'system', content: tutorSystemPrompt({ ...params, count: batchCount }) },
      { role: 'user',   content: tutorUserPrompt  ({ ...params, count: batchCount }) }
    ]
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  });
  if (!resp.ok){
    const t = await resp.text().catch(()=>'');
    throw new Error(`Upstream ${resp.status}: ${t.slice(0,1200)}`);
  }
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content?.trim() || '';
  let j;
  try{ j = JSON.parse(content); }
  catch(e){
    const m = content.match(/```json\s*([\s\S]*?)```/i);
    if (m){ j = JSON.parse(m[1]); }
    else { throw new Error('模型未返回合法 JSON'); }
  }
  if (!j || !Array.isArray(j.items)) throw new Error('返回 JSON 缺少 items 数组');
  return j.items;
}

function toV9(item){
  const type = String(item.type||'choice').toLowerCase();
  const qt = (type === 'choice') ? 'mcq' : 'short';
  const options = (qt==='mcq') ? ensureABCD(item.options) : [];
  const ansLetter = (qt==='mcq') ? toLetter(item.answer) : '';
  let ansText = '';
  if (qt==='mcq'){
    const idx = {A:0,B:1,C:2,D:3}[ansLetter] ?? 0;
    const src = (item.options && item.options[idx]) ? (item.options[idx].text ?? item.options[idx]) : options[idx] || '';
    ansText = stripLabel(src);
  }else{
    ansText = Array.isArray(item.answer) ? item.answer.join(' / ') : clean(item.answer);
  }
  const steps = normalizeSteps(item.explain || '', item.stem || '');
  let hint = clean(item.hint || '先看时间词，再判断时态与主谓一致。').replace(/[!！]+/g,'。').replace(/。。+/g,'。');
  const ref = (qt==='mcq') ? `参考答案：${ansLetter}` : `参考答案：${ansText}`;
  return {
    question_type: qt,
    question: clean(item.stem).slice(0,600),
    options,
    answer_letter: ansLetter,
    answer_text: ansText,
    answer_explanation: `${ref}\n${steps}\n提示：${hint}`.slice(0,2200)
  };
}

async function runBatches(total, params){
  const batches=[]; let remain=total;
  while(remain>0){ const c=Math.min(BATCH_SIZE, remain); batches.push(c); remain-=c; }
  const pool=[]; const results=[];
  for (const c of batches){
    const p = (async()=>{
      const controller = new AbortController();
      const timer = setTimeout(()=>controller.abort(), TIMEOUT_MS);
      try{
        const items = await callLLM(c, params, controller.signal);
        items.forEach(x=> results.push(toV9(x)));
      }finally{ clearTimeout(timer); }
    })();
    pool.push(p);
    if (pool.length >= PARALLEL){ await Promise.race(pool); }
  }
  await Promise.all(pool);
  return results;
}

exports.handler = async (event) => {
  try{
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Use POST' };

    const { OPENAI_API_KEY, OPENAI_BASE_URL } = process.env;
    if (!OPENAI_API_KEY || !OPENAI_BASE_URL){
      return { statusCode: 500, body: JSON.stringify({ error: 'Missing OPENAI_API_KEY or OPENAI_BASE_URL' }) };
    }

    let body = {};
    try{ body = JSON.parse(event.body || '{}'); }
    catch{ return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

    const total = Math.max(1, Math.min(40, Number(body.questionCount)||10));
    const mode  = body.questionType === 'tenses' ? 'tense' : 'grammar';
    const form  = String(body.form || 'mixed');
    const sub   = String(body.subtype || '');
    let types = [];
    if (form==='mcq') types=['choice'];
    else if (form==='short'){
      types = sub==='short-correct' ? ['error']
            : sub==='short-transform' ? ['transform']
            : sub==='short-reorder' ? ['rearrange']
            : ['fill'];
    }else{
      types = ['choice','error','transform','fill','rearrange','reading'];
    }
    const level = ['easy','normal','hard'].includes(body.level) ? body.level : 'normal';
    const focus = String(body.focus || '');

    const params = { types, level, focus, mode };
    const items = await runBatches(total, params);
    const out = items.slice(0,total);
    if (!out.length) return { statusCode: 504, body: JSON.stringify({ error: 'Empty result' }) };

    return { statusCode: 200, headers:{'Content-Type':'application/json','Cache-Control':'no-store'}, body: JSON.stringify(out) };
  }catch(err){
    return { statusCode: 500, body: JSON.stringify({ error: err.message || String(err) }) };
  }
};
