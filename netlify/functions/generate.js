
// netlify/functions/generate.js (v5)
// 在 v4 的稳健基础上，支持选择题 + 简答/填空（短答案），按批次生成并重试。

async function mapLimit(arr, limit, iteratee) {
  const ret = [];
  const executing = [];
  for (const item of arr) {
    const p = Promise.resolve().then(() => iteratee(item));
    ret.push(p);
    if (limit <= arr.length) {
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= limit) await Promise.race(executing);
    }
  }
  return Promise.all(ret);
}

async function callUpstream({ BASE, KEY, MODEL, questionType, form, count }) {
  const url = `${BASE.replace(/\/+$/, "")}/chat/completions`;

  const topicHint =
    questionType === "tenses"
      ? "侧重英语时态（一般现在/过去/进行/将来等），避免超纲；解析语气温和、鼓励孩子。"
      : "侧重小学常见语法（主谓一致、代词、介词、比较级入门、冠词等），避免超纲；解析语气温和、鼓励孩子。";

  const formHint =
    form === "mcq"
      ? "全部出选择题（四选一）。"
      : form === "short"
      ? "全部出简答/填空题（短答案，英语词/短语/句子，不要超一行）。"
      : "选择题与简答混合（比例约 1:1）。";

  const schema = `输出严格 JSON 数组（不要 markdown 代码块）。数组长度为 ${count}。每个元素：
{
  "question_type": "mcq|short",
  "question": "中文引导 + 英文题干，填空用 (   ) 表示空格",
  "options": ["A) ...","B) ...","C) ...","D) ..."] // 仅当 question_type=mcq 时需要；short 时给 []
  "answer_letter": "A|B|C|D" // mcq 时需要
  "answer_text": "正确答案文本（用于简答；mcq 时也给出对应选项文本，便于导出）",
  "answer_explanation": "参考答案：A 或 正确答案：xxx\\n解析思路（温柔鼓励）：...\\n分步讲解：1) ... 2) ... 3) ...\\n举例：...\\n提示：给六年级学生的小提醒"
}`;

  const systemPrompt = `你是小学英语出题老师，为六年级学生生成练习题。${topicHint}
${formHint}
${schema}
要求：
- 题干简洁，生活化场景；
- 简答题的答案尽量短（1~6个词或一句常见短句），避免歧义；
- 选项严格 4 个，且显式带字母 A) B) C) D)；
- 解析语气温和，先鼓励，再指出要点。`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: "请生成题目。" },
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.5,
        max_tokens: 1400,
        messages,
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false, status: resp.status, detail: text.slice(0,2000) };
    }

    const data = await resp.json();
    const raw = data?.choices?.[0]?.message?.content ?? "[]";
    const cleaned = raw.replace(/```json|```/g, "").trim();

    let arr;
    try {
      arr = JSON.parse(cleaned);
      if (!Array.isArray(arr)) throw new Error("not array");
    } catch (e) {
      return { ok: false, status: 502, detail: "invalid JSON from model", raw };
    }

    // 规范化
    arr = arr.map((it) => {
      const qt = String(it.question_type || "").toLowerCase() === "short" ? "short" : "mcq";
      const q = String(it.question || "").slice(0, 500);
      const options = Array.isArray(it.options) ? it.options.slice(0,4).map(s=>String(s||"").slice(0,200)) : [];
      let answer_letter = String(it.answer_letter || "").replace(/[^ABCD]/g, "") || "";
      let answer_text = String(it.answer_text || "").slice(0, 300);
      if (qt === "mcq") {
        if (!answer_letter) answer_letter = "A";
        if (!answer_text && options.length) {
          const idx = {A:0,B:1,C:2,D:3}[answer_letter] ?? 0;
          answer_text = options[idx] || "";
        }
      } else {
        // short
        answer_letter = "";
        if (!answer_text) answer_text = "";
      }
      return {
        question_type: qt,
        question: q,
        options,
        answer_letter,
        answer_text,
        answer_explanation: String(it.answer_explanation || "").slice(0, 1200),
      };
    });

    while (arr.length < count) arr.push(arr[arr.length-1] || {
      question_type: "mcq",
      question: "",
      options: ["A) ","B) ","C) ","D) "],
      answer_letter: "A",
      answer_text: "",
      answer_explanation: ""
    });
    return { ok: true, data: arr.slice(0, count) };
  } catch (err) {
    return { ok: false, status: 504, detail: "fetch aborted or network error: " + (err && err.message) };
  } finally {
    clearTimeout(timer);
  }
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    const body = JSON.parse(event.body || "{}");
    const questionType = body.questionType || "grammar"; // grammar | tenses
    const total = Math.min(Math.max(parseInt(body.questionCount || 10, 10), 1), 40);
    const form = body.form || "mixed"; // mcq | short | mixed

    const BASE = process.env.OPENAI_BASE_URL;
    const KEY = process.env.OPENAI_API_KEY;
    const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

    if (!BASE || !KEY) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Server not configured: missing OPENAI_BASE_URL or OPENAI_API_KEY" }),
      };
    }

    const batchSize = 5;
    const batches = Math.ceil(total / batchSize);
    const tasks = Array.from({ length: batches }, (_, i) => {
      const count = i === batches - 1 ? total - i * batchSize : batchSize;
      return { count };
    });

    let results = [];
    const firstPass = await mapLimit(tasks, 2, async (t) =>
      callUpstream({ BASE, KEY, MODEL, questionType, form, count: t.count })
    );

    const failed = [];
    firstPass.forEach((res, idx) => {
      if (res.ok) results = results.concat(res.data);
      else failed.push({ idx, need: tasks[idx].count, res });
    });

    if (failed.length) {
      const retryTasks = failed.map((f) => ({ count: Math.min(3, f.need) }));
      const secondPass = await mapLimit(retryTasks, 1, async (t) =>
        callUpstream({ BASE, KEY, MODEL, questionType, form, count: t.count })
      );
      secondPass.forEach((res) => {
        if (res.ok) results = results.concat(res.data);
      });
    }

    results = results.slice(0, total);
    if (!results.length) {
      return { statusCode: 504, body: JSON.stringify({ error: "Upstream timeout or invalid response." }) };
    }

    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(results) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message || String(err) }) };
  }
};
