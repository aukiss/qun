
// netlify/functions/generate.js
// v9 + user prompt (v3.2 final):
// - question: ONLY English sentence/material (strip any "【操作】..." CN prefix)
// - always provide explanation; subtype-aware heuristics
// - keep v9 UI schema; batched to avoid 504

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

// ---- system prompt with user's wording ----
function buildSystemPrompt({ mode, count, types, level="normal", focus="" }){
  const header = `你是一名小学英语教研员，熟悉“译林版”六年级下/上册语法要求。请根据参数生成题库，并严格输出 JSON（不要多余文字）。
【目标】生成适合六年级学生的题目，覆盖：时态（一般现在/过去/进行）、主谓一致、代词（物主/反身）、形容词/副词比较级与最高级、句型转换、连词成句、短文语法选择。讲解要口语化、分步骤、举例子，解释为什么错。
【难度】
- easy：概念直给+明显提示
- normal：常规课内
- hard：选择更易混点、加干扰项
【格式】只输出 JSON（面向学生的操作提示用中文，例如“把下列句子改为否定句/一般疑问句/选择正确形式”；英语例句本身保持英文）`;

  const details = `题干：仅英文材料/句子（不得包含中文；填空用 (   ) 表示空）。
解析模板："参考答案：...\\n分步讲解：\\n1) 先看时间状语…\\n2) 主语是三单…\\n3) 规则/不规则变化…\\n举例：This/That…\\n提示：一句话提醒"
【出题参数】
- 模式: ${mode}（grammar=语法综合；tense=时态专项，仅围绕一般现在/一般过去/现在进行混合）
- 数量: ${count}
- 题型: ${types.join(', ')}
- 难度: ${level}
- 知识点优先: "${focus || '无'}"
【约束】
- 操作指令不需要放入题干（不要输出“【操作】...”）；题干只保留英文。
- 模式为 tense 时：每题都聚焦三类时态，解析强调“看时间状语→判时态→动词形式/句型转换”。
- 严格可判分：选择题 answer 用 "A/B/C/D"；填空给出唯一或可接受数组；改错题提供“错因+正确句子”。
- 题干简洁，贴六年级生活语境（上学、课余、家庭、校园活动）。
- 解析要让“做错的孩子也能看懂”，避免术语堆砌，强调“如何快速判断”。`;

  const schema = `请严格只输出 **JSON 数组**（不要 markdown 代码块）。数组长度为 N（${count}）。每个元素对象必须包含：
{
  "question_type": "mcq|short",
  "subtype": "choice|error|transform|fill|rearrange|null",  // 可选
  "question": "英文题目/材料（空用 (   ) ）",
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

// ---- Upstream call ----
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
        max_tokens: 1200,
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

// ---- Heuristic helpers ----
const tenseMarkers = [
  { re: /\bevery (day|morning|afternoon|evening|week|month)\b|\balways\b|\boften\b|\busually\b|\bsometimes\b|\bon (Mondays?|Tuesdays?|Wednesdays?|Thursdays?|Fridays?|Saturdays?|Sundays?)\b/i, label: '一般现在时', tip: '看习惯频率词 → 一般现在时' },
  { re: /\byesterday\b|\blast (night|week|month|year)\b|\bago\b|\bin 20\d{2}\b/i, label: '一般过去时', tip: '看过去时间词 → 一般过去时' },
  { re: /\bnow\b|\bright now\b|\bat the moment\b|\bcurrently\b|\btoday\b|\blook!|\blisten!/i, label: '现在进行时', tip: '看 now/正在发生 → 现在进行时' }
];
function detectTense(line){
  for (const m of tenseMarkers){
    if (m.re.test(line)) return { label: m.label, tip: m.tip };
  }
  return { label: '（根据语境判断时态）', tip: '先看时间词，再看动词形式' };
}
function detectSubject(line){
  const lower = (line||'').toLowerCase();
  const subjs = ['i','you','he','she','it','we','they'];
  for (const s of subjs){
    const re = new RegExp('\\b'+s+'\\b');
    if (re.test(lower)) return s;
  }
  return '';
}
function buildHeuristicSteps(qt, enLine, options, answer_letter, answer_text, subtype){
  const steps = [];
  if (qt === 'mcq'){
    const tense = detectTense(enLine);
    steps.push(`1) 先看时间状语：${tense.tip}。`);
    const subj = detectSubject(enLine);
    if (subj){
      const zh = {i:'第一人称', you:'第二人称', he:'第三人称单数', she:'第三人称单数', it:'第三人称单数', we:'复数', they:'复数'}[subj] || subj;
      steps.push(`2) 主语是 ${subj}（${zh}），据此选择动词形式。`);
    }else{
      steps.push(`2) 看主语的单复数（he/she/it 为第三人称单数需要加 -s）。`);
    }
    const correctOpt = options.find(o => o.startsWith(answer_letter + ')')) || '';
    const word = correctOpt.replace(/^[A-D]\)\s*/,'').split(/\s+/)[0];
    if (/ing$/.test(word)) steps.push(`3) 现在进行时用 be + V-ing；若不是正在发生的动作，不选 "-ing"。`);
    else if (/ed$/.test(word)) steps.push(`3) 一般过去时用动词过去式；若是经常性动作，不选 "-ed"。`);
    else steps.push(`3) 一般现在时第三人称单数要加 -s/-es。`);
    const example = enLine.replace(/\(\s*\)/, word||answer_text||'the correct form');
    steps.push(`举例：${example}`);
    return steps.join('\n');
  }
  if (subtype === 'error'){
    steps.push('1) 找出句中错误（时态、主谓一致、拼写/大小写等）。');
    steps.push('2) 按规则改正，保留原意与语序。');
    steps.push('3) 检查首字母大小写与句号。');
    if (answer_text) steps.push(`举例：${/[.!?]$/.test(answer_text)?answer_text:(answer_text+'.')}`);
    return steps.join('\n');
  }
  if (subtype === 'transform'){
    steps.push('1) 明确目标句型（一般疑问句/否定句/祈使句等）。');
    steps.push('2) 根据主语与时态选择助动词与动词形式。');
    steps.push('3) 注意语序与标点（问号/句号）。');
    if (answer_text) steps.push(`举例：${/[!?]$/.test(answer_text)?answer_text:(answer_text+'?')}`);
    return steps.join('\n');
  }
  if (subtype === 'rearrange'){
    steps.push('1) 先找主语和谓语，再放时间/地点等。');
    steps.push('2) 注意首字母大写与句末标点。');
    steps.push('3) 检查词序是否符合英文表达习惯。');
    if (answer_text) steps.push(`举例：${/[.!?]$/.test(answer_text)?answer_text:(answer_text+'.')}`);
    return steps.join('\n');
  }
  steps.push('1) 结合时间词判断时态或词性。');
  steps.push('2) 根据主语人称数选择形式。');
  steps.push('3) 注意词形变化与拼写。');
  if (answer_text) steps.push(`举例：${/[.!?]$/.test(answer_text)?answer_text:(answer_text+'.')}`);
  return steps.join('\n');
}

function extractEnglishOnly(raw){
  const q = String(raw||'').replace(/(?:参考答案|答案)\s*[:：].*$/i,'').trim();
  const lines = q.split(/\n+/).map(s=>s.trim()).filter(Boolean);
  // prefer the line with letters and no CJK
  for (const l of lines){
    if (/[A-Za-z]/.test(l) && !/[\u4e00-\u9fff]/.test(l)) return l;
  }
  // fallback: strip any leading Chinese brackets like 【操作】
  return q.replace(/^【[^】]*】\s*/,'').trim();
}

function buildExplanation(item, qt, options, answer_letter, answer_text, enLine, subtype){
  let ex = String(item.answer_explanation || '').trim();
  const hasSteps = /分步讲解/.test(ex);
  const hasRef = /参考答案|正确答案/.test(ex);
  if (!ex || !(hasSteps && hasRef)){
    const ref = qt==='mcq' ? `参考答案：${answer_letter}` : `参考答案：${answer_text||''}`;
    const steps = String(item.explain || '').trim() || buildHeuristicSteps(qt, enLine, options, answer_letter, answer_text, subtype);
    const hint = String(item.hint || '').trim() || '先看时间词，再判断时态与主谓一致。';
    ex = `${ref}\n分步讲解：\n${steps}\n提示：${hint}`;
  }
  return ex.slice(0, 2000);
}

// ---- map to v9 schema ----
function toV9Schema(item){
  const qt = String(item.question_type || '').toLowerCase() === 'short' ? 'short' : 'mcq';
  const subtype = String(item.subtype || '').toLowerCase() || (qt==='mcq'?'choice':'');
  const rawQ = item.question ?? '';
  const options = Array.isArray(item.options) ? ensureABCD(item.options) : [];
  let answer_letter = qt==='mcq' ? toMcqLetter(item.answer_letter) : '';
  let answer_text = String(item.answer_text || '').slice(0, 400);
  if (qt==='mcq' && !answer_text && options.length){
    const idx = {A:0,B:1,C:2,D:3}[answer_letter] ?? 0;
    answer_text = options[idx]?.replace(/^\s*[A-D]\)\s*/,'') || '';
  }

  const en = extractEnglishOnly(rawQ);
  const answer_explanation = buildExplanation(item, qt, options, answer_letter, answer_text, en, subtype);
  return {
    question_type: qt,
    question: en.slice(0, 600),
    options,
    answer_letter,
    answer_text,
    answer_explanation
  };
}

// ---- concurrency ----
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

// ---- handler ----
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

    // batches
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
