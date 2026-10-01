const { env } = require('../config/env');

function normalizeExtraction(value) {
  const phone = String(value?.phone || '').replace(/[^\d+]/g, '').slice(-15) || null;
  const patientName = typeof value?.patient_name === 'string' ? value.patient_name.replace(/\s+/g, ' ').trim() : null;
  const appointmentRequest = typeof value?.appointment_request === 'string' ? value.appointment_request.trim() : null;
  return { patient_name: patientName || null, phone, appointment_request: appointmentRequest || null };
}

function validateExtraction(data) {
  if (!data.patient_name) throw new Error('patient_name is missing');
  if (!data.appointment_request) throw new Error('appointment_request is missing');
  if (data.phone && data.phone.replace(/\D/g, '').length < 10) throw new Error('phone is invalid');
  return data;
}

async function extractPostCallData(transcript) {
  if (!env.groq.apiKey) throw new Error('GROQ_API_KEY is not configured for post-call extraction');
  const response = await fetch(`${env.groq.baseUrl}/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.groq.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: env.groq.model, temperature: 0, max_completion_tokens: 180, response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Extract only appointment entities from the transcript. Understand Bengali, Banglish, Hindi, and English. Do not use keyword-only rules. Return only JSON: {"patient_name":string|null,"phone":string|null,"appointment_request":string|null}. appointment_request preserves the requested date/time in the caller wording.' },
        { role: 'user', content: JSON.stringify({ transcript }) },
      ] }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`post-call LLM failed (${response.status})`);
  const content = (await response.json())?.choices?.[0]?.message?.content || '{}';
  const parsed = JSON.parse(String(content).replace(/^```json\s*/i, '').replace(/```$/i, '').trim());
  return validateExtraction(normalizeExtraction(parsed));
}

module.exports = { extractPostCallData, normalizeExtraction, validateExtraction };
