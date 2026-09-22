const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.GROQ_API_KEY = 'test-groq-key';
process.env.GROQ_MODEL = 'openai/gpt-oss-120b';

const {
  GROQ_SYSTEM_PROMPT,
  generateAppointmentTurn,
  setGroqFetchForTests,
} = require('../src/services/groq');

describe('Groq appointment conversation service', () => {
  after(() => setGroqFetchForTests());

  it('sends the strict Bengali-first prompt and normalizes a JSON turn', async () => {
    let request;
    setGroqFetchForTests(async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    reply: 'ধন্যবাদ। কোন ডাক্তারের কাছে যেতে চান?',
                    responseLanguage: 'bn',
                    patientName: 'রহিম',
                    doctorName: null,
                    preferredDate: null,
                    preferredTime: null,
                    confirmed: false,
                    shouldSave: false,
                  }),
                },
              },
            ],
          };
        },
      };
    });

    const turn = await generateAppointmentTurn({
      userText: 'আমার নাম রহিম',
      appointmentData: {},
      clinicName: 'Test Clinic',
      doctors: ['Dr. Ghosh'],
    });

    assert.equal(request.url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(request.options.headers.Authorization, 'Bearer test-groq-key');
    const payload = JSON.parse(request.options.body);
    assert.equal(payload.model, 'openai/gpt-oss-120b');
    assert.equal(payload.response_format.type, 'json_object');
    assert.match(GROQ_SYSTEM_PROMPT, /Bengali by default/i);
    assert.match(GROQ_SYSTEM_PROMPT, /Never give medical advice/i);
    assert.match(GROQ_SYSTEM_PROMPT, /Never claim an appointment is confirmed/i);
    assert.equal(turn.appointmentData.patientName, 'রহিম');
    assert.equal(turn.responseLanguage, 'bn');
    assert.equal(turn.shouldSave, false);
  });

  it('never allows saving without all fields and explicit confirmation', async () => {
    setGroqFetchForTests(async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  reply: 'ঠিক আছে।',
                  responseLanguage: 'bn',
                  patientName: 'রহিম',
                  doctorName: null,
                  preferredDate: null,
                  preferredTime: null,
                  confirmed: true,
                  shouldSave: true,
                }),
              },
            },
          ],
        };
      },
    }));

    const turn = await generateAppointmentTurn({
      userText: 'হ্যাঁ',
      appointmentData: {},
    });

    assert.equal(turn.confirmed, false);
    assert.equal(turn.shouldSave, false);
  });
});
