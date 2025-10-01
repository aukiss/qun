
// netlify/functions/generate.js
// v9 prompt patch — use the tutor-style prompt while preserving v9 schema
// Frontend expects an array of questions with fields:
//   question_type ("mcq" | "short"), question, options[A-D], answer_letter, answer_text, answer_explanation
// This function calls the LLM with the tutor-style system prompt (mode/types/count)
// and then maps its {items:[{type,stem,options,answer,explain,hint}]} to the v9 schema.

const TIMEOUT_MS = 12000;

function sanitizeOptionText(s){
  return String(s||'').replace(/^\s*[A-D]\s*[\)\.\u3001、]\s*/i,'').trim().slice(0,200);
}

function mapTypes(form, subtype){
  // v9 frontend passes: form: "mcq" | "short" | "mixed"; subtype for short: short-correct/short-transform/short-reorder
  if (form === "mcq") return ["choice"];
  if (form === "short"){
    if (subtype === "short-correct") return ["error"];
    if (subtype === "short-transform") return ["transform"];
    if (subtype === "short-reorder") return ["rearrange"];
    return ["fill"];
  }
  // mixed
  return ["choice","error","transform","fill","rearrange"];
}

function buildTutorSystemPrompt({ mode, count, types, level="normal", focus="" }){
  // Borrowed from user's tutor.js prompt with minimal edits for clarity.
  // (See user's file for the full original wording.)
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
      "type": "choice|error|transform|fill|rearrange|reading",
      "stem": "题干（中文或英文+必要上下文）",
      "options": [ { "value": "A", "text": "选项文本" }, ... ], // 非选择题可省略
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

function buildTutorUserPrompt({ count, types, level="normal", focus="", mode }){
  return `请生成 ${count} 道题。题型：${types.join(', ')}；难度：${level}；知识点优先：${focus || '无特别指定'}；模式：${mode}。
严格只返回 JSON。`;
}

async function callLLM({ BASE, KEY, MODEL, systemContent, userContent }){
  const url = `${BASE.replace(/\/+$/,'')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), TIMEOUT_MS);
  try{
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL || 'gpt-4o-mini',
        temperature: 0.7,
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
    // Try parse JSON or fenced JSON
    let json;
    try { json = JSON.parse(content); }
    catch(e){
      const m = content.match(/```json\s*([\s\S]*?)```/i);
      if(m){ json = JSON.parse(m[1]); } else {
        return { ok:false, status: 502, detail:'invalid JSON from model', raw: content };
      }
    }
    const items = Array.isArray(json.items) ? json.items : [];
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

    const systemPrompt = buildTutorSystemPrompt({ mode, count: total, types, level, focus });
    const userPrompt = buildTutorUserPrompt({ count: total, types, level, focus, mode });

    const res = await callLLM({ BASE, KEY, MODEL, systemContent: systemPrompt, userContent: userPrompt });
    if(!res.ok){
      return { statusCode: res.status || 500, body: JSON.stringify({ error: res.detail || 'upstream error' }) };
    }
    let items = res.data.map(toV9Schema);

    // Ensure length
    while(items.length < total && items.length>0) items.push(items[items.length-1]);
    items = items.slice(0, total);

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(items) };
  }catch(err){
    return { statusCode: 500, body: JSON.stringify({ error: err.message || String(err) }) };
  }
};
