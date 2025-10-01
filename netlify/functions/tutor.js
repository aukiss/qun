
// netlify/functions/tutor.js  (v10.1) —— 仅更新“出题逻辑 & 解析逻辑”，前端保持不变
// 目标：
// - 题干仅英文（不夹中文翻译）；
// - 结构完全贴合前端：{ items: [ { type, stem, options?, answer, explain, hint } ] }
// - 解析风格：孩子喜欢的“分步讲解 + 简短提示（中文）”；参考答案单独给在 answer 字段即可；
// - 选择题 4 选 1（A-D），干扰项贴近真实错误；
// - 改错/句型转换/连词成句/填空：答案可以是字符串或 ["可接受多个"]；
// - 避免超纲，围绕小学六年级语法&时态。

const TIMEOUT_MS = 12000;

function clampInt(n, lo, hi, d=10){
  const x = parseInt(n ?? d, 10);
  return Math.max(lo, Math.min(hi, isNaN(x)? d : x));
}

function buildTypeGuidance(type){
  switch(type){
    case 'choice':
      return `出题类型：选择题（四选一）
- 题干（stem）必须全英文、简短自然；
- 提供 4 个选项 options：[{ "value":"A","text":"..." }, ...]；仅 1 个正确；
- 干扰项要贴近常错点（主谓一致、时态、冠词/介词、代词形式、比较级等）。
- answer 用 "A"/"B"/"C"/"D" 指示正确项；explain 用中文做“分步讲解”；hint 用一句话中文提示。`;
    case 'error':
      return `出题类型：改错题
- 给 1 句含 1 处常见小错误的英文句子（单三 s、时态、大小写、复数/不可数、介词/冠词等）；
- 学生任务：改成正确句子；
- stem 仅英文；answer 给“改正后的完整句子”，如可接受多种写法可返回数组；
- explain 中文“分步讲解”，hint 中文简短提示。`;
    case 'transform':
      return `出题类型：句型转换
- 常见转换：肯定↔否定、一般疑问句↔陈述句、一般现在/过去/进行/将来、同义改写（小学难度）；
- stem 仅英文；answer 为“转换后的目标句”（或可接受的多种写法数组）；
- explain 中文“分步讲解”，hint 中文简短提示。`;
    case 'rearrange':
      return `出题类型：连词成句
- 给出 5–8 个被打乱顺序的常见词/短语；
- stem 仅英文，包含打乱的词；answer 为“还原后的完整句”；
- explain 中文“分步讲解”，hint 中文简短提示。`;
    case 'fill':
      return `出题类型：填空/简答
- 在句中用 (   ) 表示空；
- stem 仅英文；answer 为正确词/短语/短句（如有同义可返回数组）；
- explain 中文“分步讲解”，hint 中文简短提示。`;
    case 'reading':
      return `出题类型：阅读理解（可选）
- 20–60 词英文短文 + 1 个理解问题；
- stem 为英文问题；如需上下文，可把短文放在 stem 开头一行后再给问题；
- answer 给出正确要点短句；explain 中文“分步讲解”，hint 中文提示。`;
    default:
      return '';
  }
}

function buildSystemPrompt({mode, types, level, topic, count}){
  const typeNotes = (types||['choice']).map(buildTypeGuidance).join('\n\n');
  const topicLine = topic ? `- 选做知识点倾向：${topic}` : '- 选做知识点倾向：常见小学生语法/时态';
  return `你是小学六年级英语出题老师。请生成 ${count} 道题。
【出题总要求】
- 题干（stem）必须**全英文**，不要出现任何中文翻译或中文提示；生活化、简洁；
- 难度：${level || '基础到中等'}；聚焦小学常见语法与四大时态；避免生僻词与复杂从句；
- 每题都给出：answer（参考答案）、explain（中文分步讲解，编号 1) 2) 3) …）、hint（中文一句提示）。
- 严格按 JSON 输出：{ "items": [ ... ] }，不要 markdown 代码块。

【模式说明】
- 模式：${mode==='tense'?'时态专项（一般现在/过去/进行/将来）':'语法综合'}。
${topicLine}

${typeNotes}

【JSON 架构】
{
  "items":[
    {
      "type": "choice|error|transform|rearrange|fill|reading",
      "stem": "Question in ENGLISH only (use (   ) for blanks when needed). No Chinese.",
      "options": [ { "value": "A", "text": "..." }, { "value": "B", "text": "..." }, { "value": "C", "text": "..." }, { "value": "D", "text": "..." } ], // 仅 choice 需要
      "answer": "A" | "text" | ["text1","text2"], // choice 用字母；其他题型给文本或多个可接受答案
      "explain": "中文分步讲解：1) … 2) … 3) … （语气温和，针对小学生）",
      "hint": "中文一句提示"
    }
  ]
}`;
}

async function callUpstream({ BASE, KEY, MODEL, sysPrompt }){
  const url = `${BASE.replace(/\/+$/,'')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL || 'gpt-4o-mini',
        temperature: 0.5,
        max_tokens: 1600,
        messages: [
          { role: 'system', content: sysPrompt },
          { role: 'user', content: '请严格按上面的 JSON 模式输出。' }
        ]
      }),
      signal: controller.signal
    });
    if(!resp.ok){
      const t = await resp.text();
      return { ok:false, status: resp.status, detail: t.slice(0,1500) };
    }
    const data = await resp.json();
    const raw = data?.choices?.[0]?.message?.content ?? '{}';
    const cleaned = raw.replace(/```json|```/g,'').trim();
    let json;
    try{
      json = JSON.parse(cleaned);
    }catch(e){
      return { ok:false, status: 502, detail:'invalid JSON', raw: cleaned };
    }

    // 规范化：确保字段存在，修剪过长文本，清洗选项
    const items = Array.isArray(json.items) ? json.items : [];
    const norm = items.map((it, idx)=>{
      const type = String(it.type || 'choice').toLowerCase();
      const stem = String(it.stem || '').replace(/[\u4e00-\u9fa5]/g,'').trim().slice(0,400);
      let options = Array.isArray(it.options) ? it.options.slice(0,4).map((op,i)=>({
        value: ['A','B','C','D'][i] || 'A',
        text: String((op?.text ?? op)).replace(/^\s*[A-D]\s*[\)\.\u3001、]\s*/i,'').trim().slice(0,160)
      })) : [];
      if(type!=='choice'){ options = []; }
      let answer = it.answer;
      if(type==='choice'){
        const v = String(answer || 'A').toUpperCase();
        answer = ['A','B','C','D'].includes(v) ? v : 'A';
      }else{
        if(Array.isArray(answer)){
          answer = answer.map(s=>String(s||'').slice(0,120)).filter(Boolean);
          if(!answer.length) answer = '';
        }else{
          answer = String(answer||'').slice(0,160);
        }
      }
      const explain = String(it.explain || '').slice(0,1200);
      const hint = String(it.hint || '').slice(0,160);
      return { type, stem, options, answer, explain, hint };
    });

    return { ok:true, data: { items: norm } };
  } catch(err){
    return { ok:false, status: 504, detail: 'timeout or fetch error: ' + (err?.message || String(err)) };
  } finally{
    clearTimeout(timer);
  }
}

exports.handler = async (event, context) => {
  try{
    if(event.httpMethod !== 'POST'){
      return { statusCode: 405, body: JSON.stringify({ error: 'Use POST' }) };
    }

    const { OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL } = process.env;
    if(!OPENAI_API_KEY || !OPENAI_BASE_URL){
      return { statusCode: 500, body: JSON.stringify({ error: 'Missing OPENAI_API_KEY or OPENAI_BASE_URL' }) };
    }

    let body = {};
    try{ body = JSON.parse(event.body || '{}'); }catch{ body = {}; }

    const mode = (body.mode === 'tense') ? 'tense' : 'grammar';
    const count = clampInt(body.count, 1, 30, 10);
    const types = Array.isArray(body.types) && body.types.length ? body.types : ['choice'];
    const level = body.level || 'basic';
    const topic = body.topic || '';

    const sysPrompt = buildSystemPrompt({ mode, types, level, topic, count });
    const res = await callUpstream({ BASE: OPENAI_BASE_URL, KEY: OPENAI_API_KEY, MODEL: OPENAI_MODEL, sysPrompt });

    if(!res.ok){
      return { statusCode: res.status || 500, body: JSON.stringify({ error: res.detail || 'upstream error' }) };
    }

    // 若返回题量不足，直接复制补齐（避免前端崩）
    let items = res.data.items || [];
    while(items.length < count && items.length>0){
      items.push(items[items.length-1]);
    }
    items = items.slice(0, count);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ items })
    };
  }catch(err){
    return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: err.message }) };
  }
};
