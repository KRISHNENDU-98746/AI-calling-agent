const { env } = require('../config/env');

const APPOINTMENT_FIELDS = [
  'patientName',
  'doctorName',
  'preferredDate',
  'preferredTime',
];

const GROQ_SYSTEM_PROMPT = `You are a strict clinic appointment-booking voice assistant for one fixed doctor.

Scope:
- Help only with creating an appointment booking request.
- Collect patient name, preferred date, and preferred time. The doctor is already configured; never ask the caller to choose or provide a doctor name.
- Never give medical advice, diagnoses, prescriptions, treatment recommendations, or emergency guidance. If asked, briefly say you can only help with appointment requests and continue with the missing booking detail.
- Never claim an appointment is confirmed. Saving means only that a request was recorded; the clinic must confirm separately.

Language and style:
- Understand Bengali, Banglish, Hindi, and English.
- Reply naturally in Bengali by default, even when the caller uses Banglish, Hindi, or English.
- Use Hindi or English only when the caller explicitly asks for that language.
- Keep replies short and suitable for speech. Ask for one missing field at a time.

Booking rules:
- Do not invent or guess any field. Preserve the caller's date/time wording when it is understandable.
- Use the supplied doctor list as context, but accept a doctor name the caller provides.
- When all four fields are present, repeat every detail and ask for explicit confirmation.
- Set confirmed=true only when all four fields are present and the caller clearly confirms the repeated details in the current turn.
- Set shouldSave=true only when confirmed=true and all four fields are present.
- Before confirmation, shouldSave must be false.

Return only valid JSON matching the requested schema. The reply must contain no markdown.`;

let fetchImplementation = (...args) => globalThis.fetch(...args);

function cleanField(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned || null;
}

function parseModelJson(content) {
  const text = String(content || '').trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object') throw new Error('Groq returned a non-object response');
  return parsed;
}

function normalizeTurn(parsed, existingData) {
  const appointmentData = {};
  for (const field of APPOINTMENT_FIELDS) {
    appointmentData[field] = cleanField(parsed[field]) || existingData?.[field] || null;
  }

  const allFieldsPresent = APPOINTMENT_FIELDS.every((field) => appointmentData[field]);
  const confirmed = Boolean(parsed.confirmed) && allFieldsPresent;

  return {
    reply: cleanField(parsed.reply) || 'দুঃখিত, অনুগ্রহ করে অ্যাপয়েন্টমেন্টের তথ্যটি আবার বলুন।',
    responseLanguage: ['bn', 'hi', 'en'].includes(parsed.responseLanguage)
      ? parsed.responseLanguage
      : 'bn',
    appointmentData,
    confirmed,
    shouldSave: Boolean(parsed.shouldSave) && confirmed,
  };
}

async function generateAppointmentTurn({
  userText,
  history = [],
  appointmentData = {},
  clinicName,
  doctors = [],
}) {
  if (!env.groq.apiKey) throw new Error('GROQ_API_KEY is not configured');

  const response = await fetchImplementation(`${env.groq.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.groq.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: env.groq.model,
      temperature: 0.2,
      max_completion_tokens: 300,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: GROQ_SYSTEM_PROMPT },
        ...history.slice(-12),
        {
          role: 'user',
          content: JSON.stringify({
            clinicName: clinicName || 'Clinic',
            availableDoctors: doctors,
            collectedAppointmentData: appointmentData,
            callerMessage: userText,
            requiredResponseSchema: {
              reply: 'string',
              responseLanguage: 'bn|hi|en',
              patientName: 'string|null',
              doctorName: 'string|null',
              preferredDate: 'string|null',
              preferredTime: 'string|null',
              confirmed: 'boolean',
              shouldSave: 'boolean',
            },
          }),
        },
      ],
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Groq request failed (${response.status}): ${body.slice(0, 200)}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  return normalizeTurn(parseModelJson(content), appointmentData);
}

function setGroqFetchForTests(fetchImplementationForTests) {
  fetchImplementation = fetchImplementationForTests || ((...args) => globalThis.fetch(...args));
}

module.exports = {
  GROQ_SYSTEM_PROMPT,
  generateAppointmentTurn,
  setGroqFetchForTests,
};
