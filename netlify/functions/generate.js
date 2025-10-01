// netlify/functions/generate.js
// 使用 Netlify Functions（Node 18 原生 fetch）。返回严格 JSON 数组。
// 每个元素包含：question, options[4], answer_letter(A/B/C/D), answer_explanation(多行文本).

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    const body = JSON.parse(event.body || "{}");
    const questionType = body.questionType || "grammar"; // grammar | tenses
    const questionCount = Math.min(Math.max(parseInt(body.questionCount || 10,10), 1), 50);

    const BASE = process.env.OPENAI_BASE_URL;        // e.g. https://api.videocaptioner.cn/v1
    const KEY  = process.env.OPENAI_API_KEY;         // your relay key
    const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

    if (!BASE || !KEY) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Server not configured: missing OPENAI_BASE_URL or OPENAI_API_KEY" })
      };
    }

    const url = `${BASE.replace(/\/+$/,"")}/chat/completions`;

    const topicHint = questionType === 'tenses'
      ? '侧重英语时态（一般现在时、一般过去时、现在进行时、一般将来时等），避免超纲。'
      : '侧重小学阶段常见语法（主谓一致、代词、介词短语、比较级/最高级的入门、冠词等），避免超纲。';

    const explainTemplate = [
      "解析思路：简要说明为什么选该项。",
      "分步讲解：",
      "1) 先看时间状语（如：every day, yesterday, now 等）；",
      "2) 判断时态或语法点；",
      "3) 套用规则，排除错误选项。",
      "举例：给出1句相同规则的英文例句。",
      "提示：给六年级学生的直观提示。"
    ].join("\n");

    const systemPrompt = `你是小学英语出题老师，为六年级学生生成选择题（四选一）。${topicHint}
输出严格 JSON 数组（不要 markdown 代码块）。数组长度为 ${questionCount}。每个元素必须是：
{
  "question": "中文引导 + 英文题干，避免太长",
  "options": ["A) ...","B) ...","C) ...","D) ..."],
  "answer_letter": "A|B|C|D 之一",
  "answer_explanation": "参考答案：A\n${explainTemplate}"
}
要求：
- 题干中若有空格填空，用 (   ) 表示空格；
- options 必须恰好 4 个，且显式带字母 A) B) C) D)；
- 题目难度适中，语料贴近生活校园场景。`;

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: "请生成题目。" }
    ];

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.6,
        messages
      })
    });

    if (!resp.ok) {
      const text = await resp.text();
      return {
        statusCode: resp.status,
        body: JSON.stringify({ error: `Upstream error ${resp.status}`, detail: text.slice(0,2000) })
      };
    }

    const data = await resp.json();
    const raw = data?.choices?.[0]?.message?.content ?? "[]";
    const cleaned = raw.replace(/```json|```/g, "").trim();

    let arr;
    try {
      arr = JSON.parse(cleaned);
      if (!Array.isArray(arr)) throw new Error("Model response is not an array.");
      // 进行基本字段校验与裁剪
      arr = arr.map((it, idx) => {
        const q = {};
        q.question = String(it.question || "").slice(0, 500);
        const opts = Array.isArray(it.options) ? it.options.slice(0,4) : [];
        while (opts.length < 4) opts.push("");
        q.options = opts.map(s => String(s).slice(0, 200));
        const letter = String(it.answer_letter || "").replace(/[^ABCD]/g,"") || "A";
        q.answer_letter = letter;
        q.answer_explanation = String(it.answer_explanation || "").slice(0, 1200);
        return q;
      });
    } catch (e) {
      return {
        statusCode: 502,
        body: JSON.stringify({ error: "Model did not return valid JSON", raw })
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(arr)
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message || String(err) }) };
  }
};
