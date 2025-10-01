
// netlify/functions/grade.js
// Lenient grading for primary students: not too strict on word order for transformations.
// Input: { items: [v9 items], answers: ["A", "text", ...] }
// Output: { total, correct, detail:[ {index, is_correct, expected, got, message} ] }

function normalize(s){
  return String(s||'')
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g,' ')
    .replace(/\s+/g,' ')
    .trim();
}
function jaccard(a,b){
  const A = new Set(a.split(' ')), B = new Set(b.split(' '));
  const inter = new Set([...A].filter(x=>B.has(x))).size;
  const uni = new Set([...A, ...B]).size || 1;
  return inter/uni;
}

exports.handler = async (event) => {
  try{
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Use POST' };
    let payload={};
    try{ payload = JSON.parse(event.body||'{}'); }
    catch{ return { statusCode: 400, body: JSON.stringify({ error:'Invalid JSON' }) }; }

    const items = Array.isArray(payload.items)? payload.items: [];
    const answers = Array.isArray(payload.answers)? payload.answers: [];
    const detail = []; let correct = 0;

    for (let i=0;i<items.length;i++){
      const q = items[i] || {};
      const user = answers[i] ?? '';
      let ok=false, msg='', expected='';

      if (q.question_type === 'mcq'){
        const gold = String(q.answer_letter||'').toUpperCase();
        expected = gold;
        ok = gold === String(user||'').toUpperCase();
        msg = ok ? '选择题作答正确' : '选择题作答不正确';
      }else{ // short
        const goldText = String(q.answer_text||'').trim();
        expected = goldText;
        const goldNorms = goldText.split('/').map(x=>normalize(x));
        const userNorm = normalize(user);
        // exact or near-exact
        ok = goldNorms.some(g=> g===userNorm || jaccard(g, userNorm) >= 0.85);
        msg = ok ? '答案可以接受' : '与标准答案差异较大';
      }
      if (ok) correct++;
      detail.push({ index:i+1, is_correct:ok, expected, got:String(user||''), message:msg });
    }

    return { statusCode:200, headers:{'Content-Type':'application/json'}, body: JSON.stringify({ total: items.length, correct, detail }) };
  }catch(err){
    return { statusCode: 500, body: JSON.stringify({ error: err.message || String(err) }) };
  }
};
