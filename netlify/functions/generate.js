
// netlify/functions/generate.js
// v9 + user custom prompt (小学六年级 · 译林版) — keep v9 UI schema
// Returns an ARRAY of questions (not wrapped), fields:
//  - question_type: 'mcq' | 'short'
//  - question: string
//  - options: ["A) ...","B) ...","C) ...","D) ..."]  // mcq only
//  - answer_letter: 'A'|'B'|'C'|'D'                  // mcq
//  - answer_text: string                              // short；mcq 也给文本
//  - answer_explanation: string ("参考答案" + "分步讲解" + "提示")
//
// Batched generation to reduce 504 timeouts.

const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || '22000', 10);
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '4', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '2', 10);

function sanitizeOptionText(s){
  return String(s||'').replace(/^\s*[A-D]\s*[\)\.\u3001、]\s*/i,'').trim().slice(0,200);
}
function ensureABCD(options){
  const alpha = ['A','B','C','D'];
  return (options||[]).slice(0,4).map((txt,i)=>{
    const clean = sanitizeOptionText(txt);
    const head = alpha[i] || 'A';
    return clean.startsWith(head+')') ? clean : `${head}) ${clean}`;
  });
}
function toMcqLetter(v){
  const x = String(v||'A').toUpperCase();
  return ['A','B','C','D'].includes(x) ? x : 'A';
}

// Map front-end form/subtype -> logical types (for prompt only)
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

// ===== User-provided system prompt (hardcoded) =====
function buildSystemPrompt({ mode, count, types, level="normal", focus="" }){
  const header = `你是一名小学英语教研员，熟悉“译林版”六年级下/上册语法要求。请根据参数生成题库，并严格输出 JSON（不要多余文字）。
【目标】生成适合六年级学生的题目，覆盖：时态（一般现在/过去/进行）、主谓一致、代词（物主/反身）、形容词/副词比较级与最高级、句型转换、连词成句、短文语法选择。讲解要口语化、分步骤、举例子，解释为什么错。
【难度】
- easy：概念直给+明显提示
- normal：常规课内
- hard：选择更易混点、加干扰项
【格式】只输出 JSON（面向学生的操作提示用中文，例如“把下列句子改为否定句/一般疑问句/选择正确形式”；英语例句本身保持英文）`;

  const details = `2.题干（中文或英文+必要上下文）
3."分步讲解：\\n1) 先看时间状语…\\n2) 主语是三单…\\n3) 规则/不规则变化…\\n举例：This/That…"
4.【出题参数】
- 模式: ${mode}（grammar=语法综合；tense=时态专项，仅围绕一般现在/一般过去/现在进行混合）
- 数量: ${count}
- 题型: ${types.join(', ')}
- 难度: ${level}
- 知识点优先: "${focus || '无'}"
【约束】
- 操作指令必须中文；避免出现“Transform this sentence ...”这类英文提示。
- 模式为 tense 时：每题都聚焦三类时态，解析强调“看时间状语→判时态→动词形式/句型转换”。
- 严格可判分：选择题 answer 用 "A/B/C/D"；填空给出唯一或可接受数组；改错题提供“错因+正确句子”。
- 题干简洁，贴六年级生活语境（上学、课余、家庭、校园活动）。
- 解析要让“做错的孩子也能看懂”，避免术语堆砌，强调“如何快速判断”。`;

  // Schema hard constraint (v9 UI expects these exact fields)
  const schema = `请严格只输出 **JSON 数组**（不要 markdown 代码块）。数组长度为 N（${count}）。每个元素对象必须包含：
{
  "question_type": "mcq|short",
  "question": "题干（中文或英文+必要上下文；如需填空，用 (   ) 表示空）",
  "options": ["A) ...","B) ...","C) ...","D) ..."], // 仅 question_type 为 mcq 时需要
  "answer_letter": "A|B|C|D",                       // 仅 mcq
  "answer_text": "正确答案文本（short 题；若有多个可接受写法，用 ' / ' 连接；mcq 也补充正确项文本）",
  "answer_explanation": "参考答案：A 或 正确答案：xxx\\n分步讲解：\\n1) 先看时间状语…\\n2) 主语是三单…\\n3) 规则/不规则变化…\\n举例：This/That…\\n提示：一句话提醒"
}`;

  return `${header}\n\n${details}\n\n${schema}`;
}

function buildUserPrompt(count){
  return `请生成 ${count} 道题，严格只返回 JSON 数组（不要 markdown 代码块）。所有对象字段必须完整、符合上面的 schema。`;
}

// ===== Upstream call =====
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
        max_tokens: 1150,
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
    // Expect an array; accept fenced JSON too
    let arr;
    try{ arr = JSON.parse(content); }
    catch(e){
      const m = content.match(/```json\s*([\s\S]*?)```/i);
      if(m){ arr = JSON.parse(m[1]); }
    }
    if(!Array.isArray(arr)) return { ok:false, status: 502, detail:'invalid JSON from model', raw: content };
    return { ok:true, data: arr.slice(0, count) };
  }catch(err){
    return { ok:false, status: 504, detail: 'timeout or fetch error: ' + (err?.message || String(err)) };
  }finally{
    clearTimeout(timer);
  }
}

// ===== Sanitization to v9 schema =====
function toV9Schema(item){
  const qt = String(item.question_type || '').toLowerCase() === 'short' ? 'short' : 'mcq';
  const question = String(item.question || '').replace(/(?:参考答案|答案)\s*[:：].*$/i,'').slice(0, 600);
  const options = Array.isArray(item.options) ? ensureABCD(item.options) : [];
  let answer_letter = qt==='mcq' ? toMcqLetter(item.answer_letter) : '';
  let answer_text = String(item.answer_text || '').slice(0, 400);
  if (qt==='mcq' && !answer_text && options.length){
    const idx = {A:0,B:1,C:2,D:3}[answer_letter] ?? 0;
    answer_text = options[idx]?.replace(/^\s*[A-D]\)\s*/,'') || '';
  }
  const ex = String(item.answer_explanation || '').slice(0, 1800);
  return { question_type: qt, question, options, answer_letter, answer_text, answer_explanation: ex };
}

// Simple concurrency limit
async function mapLimit(arr, limit, iteratee){
  const ret=[]; const executing=[];
  for (const item of arr){
    const p = Promise.resolve().then(()=>iteratee(item));
    ret.push(p);
    const e = p.then(()=> executing.splice(executing.indexOf(e),1));
    executing.push(e);
    if(executing.length >= limit) await Promise.race(executing);
  }
  return Promise.all(ret);
}

// ===== Handler =====
exports.handler = async (event) => {
  try{
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }
    const body = JSON.parse(event.body || '{}');
    const questionType = body.questionType || 'grammar'; // grammar | tenses
    const form = body.form || 'mixed'; // mcq | short | mixed
    const subtype = body.subtype || ''; // short-correct|short-transform|short-reorder
    const total = Math.min(Math.max(parseInt(body.questionCount || 10, 10), 1), 40);

    const BASE = process.env.OPENAI_BASE_URL;
    const KEY = process.env.OPENAI_API_KEY;
    const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    if (!BASE || !KEY){
      return { statusCode: 500, body: JSON.stringify({ error: 'Server not configured: missing OPENAI_BASE_URL or OPENAI_API_KEY' }) };
    }

    const types = mapTypes(form, subtype);
    const mode = (questionType === 'tenses') ? 'tense' : 'grammar';
    const level = process.env.CUSTOM_LEVEL || 'normal';
    const focus = process.env.CUSTOM_FOCUS || '';

    // Build batches
    const batches=[]; let remain = total;
    while(remain > 0){ const c = Math.min(BATCH_SIZE, remain); batches.push(c); remain -= c; }

    let results = [];
    const first = await mapLimit(batches, CONCURRENCY, async (count)=>{
      const systemPrompt = buildSystemPrompt({ mode, count, types, level, focus });
      const userPrompt = buildUserPrompt(count);
      const res = await callLLM({ BASE, KEY, MODEL, systemContent: systemPrompt, userContent: userPrompt, count });
      return res;
    });

    const retry = [];
    first.forEach((r, i)=>{
      if (r.ok && Array.isArray(r.data)) results = results.concat(r.data.map(toV9Schema));
      else retry.push({ need: batches[i], err: r });
    });

    // Retry with smaller count (max 3) sequentially
    for (const r of retry){
      const need = Math.min(3, r.need);
      const systemPrompt = buildSystemPrompt({ mode, count: need, types, level, focus });
      const userPrompt = buildUserPrompt(need);
      const res2 = await callLLM({ BASE, KEY, MODEL, systemContent: systemPrompt, userContent: userPrompt, count: need });
      if (res2.ok && Array.isArray(res2.data)){
        results = results.concat(res2.data.map(toV9Schema));
      }
    }

    results = results.slice(0, total);
    while (results.length < total && results.length>0) results.push(results[results.length-1]);

    if (!results.length){
      return { statusCode: 504, body: JSON.stringify({ error: 'Upstream timeout or invalid response.' }) };
    }
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(results) };
  }catch(err){
    return { statusCode: 500, body: JSON.stringify({ error: err.message || String(err) }) };
  }
};
