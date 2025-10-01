
// netlify/functions/generate.js
// 改进版：批处理(每批5题) + 并发限制 + 自动降级重试，减少 504 概率。

/** 简单并发控制 */
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

async function callUpstream({ BASE, KEY, MODEL, questionType, count }) {
  const url = `${BASE.replace(/\/+$/, "")}/chat/completions`;

  const topicHint =
    questionType === "tenses"
      ? "侧重英语时态（一般现在/过去/进行/将来等），避免超纲。"
      : "侧重小学常见语法（主谓一致、代词、介词、比较级入门、冠词等），避免超纲。";

  const systemPrompt = `你是小学英语出题老师，为六年级学生生成选择题（四选一）。${topicHint}
输出严格 JSON 数组（不要 markdown 代码块）。数组长度为 ${count}。每个元素必须：
{
  "question": "中文引导 + 英文题干（如有填空用 (   )）",
  "options": ["A) ...","B) ...","C) ...","D) ..."],
  "answer_letter": "A|B|C|D",
  "answer_explanation": "参考答案：A\n解析思路：\n分步讲解：1) 先看时间状语；2) 判断时态或语法点；3) 套用规则。\n举例：给出相同规则的英文例句。\n提示：给六年级学生的直观提示。"
}`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: "请生成题目。" },
  ];

  // 使用 AbortController 控制单次上游最长等待 9s（避免函数整体超时）
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
        max_tokens: 1200,
        messages,
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const text = await resp.text();
      return {
        ok: false,
        status: resp.status,
        detail: text.slice(0, 2000),
      };
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
    // 轻度清洗
    arr = arr.map((it) => ({
      question: String(it.question || "").slice(0, 500),
      options: (Array.isArray(it.options) ? it.options : [])
        .slice(0, 4)
        .map((s) => String(s || "").slice(0, 200)),
      answer_letter: String(it.answer_letter || "A").replace(/[^ABCD]/g, "") || "A",
      answer_explanation: String(it.answer_explanation || "").slice(0, 1200),
    }));
    while (arr.length < count) arr.push(arr[arr.length - 1] || {question:"", options:["A) ","B) ","C) ","D) "], answer_letter:"A", answer_explanation:""});
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

    const BASE = process.env.OPENAI_BASE_URL; // e.g. https://api.videocaptioner.cn/v1
    const KEY = process.env.OPENAI_API_KEY;
    const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

    if (!BASE || !KEY) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Server not configured: missing OPENAI_BASE_URL or OPENAI_API_KEY",
        }),
      };
    }

    // 按 5 题一批拆分，默认并发 2，单批 9 秒超时。
    const batchSize = 5;
    const batches = Math.ceil(total / batchSize);
    const tasks = Array.from({ length: batches }, (_, i) => {
      const count = i === batches - 1 ? total - i * batchSize : batchSize;
      return { count };
    });

    let results = [];
    // 并发 2 执行
    const firstPass = await mapLimit(tasks, 2, async (t) =>
      callUpstream({ BASE, KEY, MODEL, questionType, count: t.count })
    );

    // 收集成功，记录失败
    const failed = [];
    firstPass.forEach((res, idx) => {
      if (res.ok) results = results.concat(res.data);
      else failed.push({ idx, need: tasks[idx].count, res });
    });

    // 对失败的批次，降级重试：减少题量（每批 3 题），并发 1
    if (failed.length) {
      const retryTasks = failed.map((f) => ({ count: Math.min(3, f.need) }));
      const secondPass = await mapLimit(retryTasks, 1, async (t) =>
        callUpstream({ BASE, KEY, MODEL, questionType, count: t.count })
      );
      secondPass.forEach((res) => {
        if (res.ok) results = results.concat(res.data);
      });
    }

    // 截断到目标总量
    results = results.slice(0, total);

    if (!results.length) {
      return {
        statusCode: 504,
        body: JSON.stringify({
          error: "Upstream timeout or invalid response. 请尝试降低题量到 10，并重试。",
        }),
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(results),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message || String(err) }),
    };
  }
};
