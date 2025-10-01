// Minimal stub: if you already deployed v10 or v10.1, you can ignore this file.
// This forwards body to your existing logic (replace with your tutor-logic-v10.1 if preferred).
exports.handler = async (event) => {
  return { statusCode: 500, body: JSON.stringify({ error: "Please deploy your existing netlify/functions/tutor.js or use v10.1." }) };
};
