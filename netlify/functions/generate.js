
// netlify/functions/generate.js
// Fresh rewrite for V9 UI (keep UI untouched, PDF untouched)
// - Endpoint: /.netlify/functions/generate (same as旧版)
// - Uses the same prompt spec as tutor.js, but outputs V9 schema [6 fields]
// - Robust: batching, timeout, JSON-in-code-block rescue, explanation fallback

const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || '22000', 10);
const BATCH = parseInt(process.env.BATCH || '5', 10);
const PARALLEL = parseInt(process.env.PARALLEL || '2', 10);

const ALPHA = ['A','B','C','D'];

function cleanOption(s){ return String(s||'').replace(/^\s*[A-D]\s*[\)\.\u3001、]\s*/i,'').trim(); }
function ensureABCD(arr){
  const xs = (arr||[]).slice(0,4).map((t,i)=>`${ALPHA[i]}) ${cleanOption(t?.text ?? t)}`);
  while (xs.length<4) xs.push(`${ALPHA[xs.length]}) `);
  return xs;
}
function letter(v){ const x = String(v||'A').toUpperCase(); return ALPHA.includes(x) ? x : 'A'; }

function toV9(item){
  const type = String(item.type||'choice').toLowerCase();
  const qt = (type === 'choice') ? 'mcq' : 'short';
  const options = (qt==='mcq') ? ensureABCD(item.options) : [];
  const ansLetter = (qt==='mcq') ? letter(item.answer) : '';
  let ansText = '';
  if (qt==='mcq'){
    const idx = {A:0,B:1,C:2,D:3}[ansLetter] ?? 0;
    ansText = cleanOption((item.options?.[idx]?.text) || (options[idx]||'').replace(/^[A-D]\)\s*/,''));
  }else{
    ansText = Array.isArray(item.answer) ? item.answer.join(' / ') : String(item.answer||'').trim();
  }
  // Build explanation: ensure has steps + hint (no exclamations)
  const steps = (String(item.explain||'').trim() || '').replace(/\r/g,'').split(/\n+/).filter(Boolean);
  let explain = '';
  if (!steps.length){
    // heuristic fallback
    const stem = String(item.stem||'').toLowerCase();
    let lines = ["1) 先看时间状语；", "2) 判断主语（是否三单）；", "3) 根据时态与主谓一致选择或改写；", "举例：将答案放入句中检查通顺。"];
    if (/yesterday|last|ago|in \d{4}/i.test(stem)) lines[0] = "1) 出现过去时间词 → 一般过去时；";
    if (/every|always|often|usually|sometimes|on (monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?/i.test(stem)) lines[0] = "1) 习惯/频率词 → 一般现在时；";
    if (/now|right now|at the moment|look!|listen!/i.test(stem)) lines[0] = "1) 正在发生 → 现在进行时；";
    explain = `分步讲解：\n${lines.join('\n')}`;
  }else{
    // normalize numbering
    const norm = steps.map(s=> s.replace(/^\d+\s*[\)\.、）]\s*/,'').replace(/^[①②③④⑤⑥⑦⑧⑨]\s*/,'').trim());
    explain = `分步讲解：\n${norm.map((s,i)=>`${i+1}) ${s}`).join('\n')}`;
  }
  let hint = String(item.hint||'先看时间词，再判断时态与主谓一致。').replace(/[!！]+/g,'。').replace(/。。+/g,'。');
  const ref = (qt==='mcq') ? `参考答案：${ansLetter}` : `参考答案：${ansText}`;
  const answer_explanation = `${ref}\n${explain}\n提示：${hint}`.slice(0, 2200);

  return {
    question_type: qt,
    question: String(item.stem||'').trim().slice(0,600),
    options,
    answer_letter: ansLetter,
    answer_text: ansText,
    answer_explanation
  };
}

function buildSystemPrompt({count, types, level, focus, mode}){
  // Copied to match tutor.js spec so题质一致
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
      "options": [ { "value": "A", "text": "选项文本" }, ... ], // 非选择题可省略
      "answer": "A" | "答案文本" | ["可接受多个"],
      "explain": "分步讲解：\n1) 先看时间状语…\n2) 主语是三单…\n3) 规则/不规则变化…\n举例：This/That…",
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
function buildUserPrompt({count, types, level, focus, mode}){
  return `请生成 ${count} 道题。题型：${types.join(', ')}；难度：${level}；知识点优先：${focus || '无特别指定'}；模式：${mode}。\n严格只返回 JSON。`;
}

async function callLLM(batchCount, params, signal){
  const { OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL } = process.env;
  const url = `${OPENAI_BASE_URL.replace(/\/+$/,'')}/chat/completions`;
  const system = buildSystemPrompt({ ...params, count: batchCount });
  const user   = buildUserPrompt({ ...params, count: batchCount });
  const body = {
    model: OPENAI_MODEL || 'gpt-4o-mini',
    temperature: 0.55,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type':'application/json' },
    body: JSON.stringify(body),
    signal
  });
  if (!resp.ok){
    const t = await resp.text().catch(()=>'');
    throw new Error(`Upstream ${resp.status}: ${t.slice(0,1200)}`);
  }
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content?.trim() || '';
  let json;
  try{ json = JSON.parse(content); }
  catch(e){
    const m = content.match(/```json\s*([\s\S]*?)```/i);
    if (m){ json = JSON.parse(m[1]); }
    else { throw new Error('模型未返回合法 JSON'); }
  }
  if (!json || !Array.isArray(json.items)) throw new Error('返回 JSON 缺少 items 数组');
  return json.items.map(toV9);
}

async function mapLimit(arr, limit, iteratee){
  const ret=[]; const pool=[];
  for (const it of arr){
    const p = Promise.resolve().then(()=>iteratee(it));
    ret.push(p);
    const done = p.finally(()=> pool.splice(pool.indexOf(done),1));
    pool.push(done);
    if (pool.length >= limit) await Promise.race(pool);
  }
  return Promise.all(ret);
}

exports.handler = async (event) => {
  try{
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Use POST' };

    const { OPENAI_API_KEY, OPENAI_BASE_URL } = process.env;
    if (!OPENAI_API_KEY || !OPENAI_BASE_URL){
      return { statusCode: 500, body: JSON.stringify({ error: 'Missing OPENAI_API_KEY or OPENAI_BASE_URL' }) };
    }

    let payload = {};
    try{ payload = JSON.parse(event.body || '{}'); }
    catch{ return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

    // Map from V9 UI fields -> tutor params
    const total = Math.max(1, Math.min(40, Number(payload.questionCount)||10));
    const mode = (payload.questionType === 'tenses') ? 'tense' : 'grammar';
    const form = String(payload.form || 'mixed'); // mcq | short | mixed
    const subtype = String(payload.subtype || '');

    // Translate to tutor types
    let types = [];
    if (form === 'mcq') types = ['choice'];
    else if (form === 'short'){
      if (subtype === 'short-correct') types = ['error'];
      else if (subtype === 'short-transform') types = ['transform'];
      else if (subtype === 'short-reorder') types = ['rearrange'];
      else types = ['fill'];
    }else{
      types = ['choice','error','transform','fill','rearrange','reading'];
    }

    const level = ['easy','normal','hard'].includes(payload.level) ? payload.level : 'normal';
    const focus = String(payload.focus || '');

    // batching
    const batches = []; let rest = total;
    while(rest>0){ const c = Math.min(BATCH, rest); batches.push(c); rest -= c; }

    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), Math.max(25000, TIMEOUT_MS + 3000));

    let results = [];
    const params = { count:0, types, level, focus, mode };
    const parts = await mapLimit(batches, PARALLEL, async (c)=>{
      return await callLLM(c, params, controller.signal);
    });
    parts.forEach(x=> results = results.concat(x));
    clearTimeout(timer);

    results = results.slice(0, total);
    if (!results.length) return { statusCode: 504, body: JSON.stringify({ error: 'Empty result' }) };

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify(results)
    };
  }catch(err){
    const m = (err && (err.message || String(err))).slice(0,1200);
    return { statusCode: 500, body: JSON.stringify({ error: m }) };
  }
};
