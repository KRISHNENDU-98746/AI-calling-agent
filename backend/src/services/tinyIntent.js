const INTENT_RULES = [
  ['EMERGENCY', ['জরুরি', 'emergency', 'শ্বাস নিতে', 'খুব বেশি ব্যথা']],
  ['CANCEL_APPOINTMENT', ['cancel', 'বাতিল', 'আর আসতে পারব না']],
  ['RESCHEDULE_APPOINTMENT', ['reschedule', 'সময় বদল', 'time change', 'অন্য দিনে']],
  ['HUMAN_TRANSFER', ['মানুষের সঙ্গে', 'staff', 'human', 'agent-এর সাথে', 'কাউকে দিন']],
  ['CLINIC_HOURS', ['কখন খোলে', 'কতক্ষণ খোলা', 'clinic open', 'clinic hours']],
  ['DOCTOR_AVAILABILITY', ['available', 'থাকবেন', 'ডাক্তার দেখাবেন']],
  ['LOCATION', ['কোথায়', 'ঠিকানা', 'address', 'কীভাবে যাব']],
  ['FEES', ['fee', 'fees', 'কত টাকা', 'charge']],
  ['CONFIRM', ['হ্যাঁ', 'ঠিক আছে', 'confirm', 'yes', 'জি']],
  ['DENY', ['না', 'no', 'ভুল হয়েছে']],
  ['NAME', ['আমার নাম', 'নাম', 'my name', 'amar nam']],
  ['PHONE', ['ফোন নম্বর', 'phone number', 'mobile number']],
  ['AGE', ['বয়স', 'age', 'years old']],
  ['DATE', ['আজ', 'কাল', 'পরশু', 'tomorrow', 'monday', 'তারিখ']],
  ['TIME', ['টায়', 'সময়', 'কয়টায়', 'am', 'pm', 'সকাল', 'দুপুর', 'বিকেল']],
  ['BOOK_APPOINTMENT', ['appointment', 'অ্যাপয়েন্টমেন্ট', 'সিরিয়াল', 'booking', 'ডাক্তার দেখাতে']],
  ['SYMPTOM', ['জ্বর', 'কাশি', 'ব্যথা', 'fever', 'cough']],
  ['END_CALL', ['ধন্যবাদ', 'bye', 'goodbye', 'phone রাখছি']],
];

function localPredict(text) {
  const normalized = String(text || '').toLowerCase();
  const match = INTENT_RULES.find(([, phrases]) => phrases.some((phrase) => normalized.includes(phrase)));
  return match
    ? { intent: match[0], confidence: 0.62, source: 'local-fast-fallback' }
    : { intent: 'UNKNOWN', confidence: 0.1, source: 'local-fast-fallback' };
}

async function predictTinyIntent(text) {
  const endpoint = process.env.TINY_INTENT_URL;
  if (!endpoint) return localPredict(text);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(1200),
    });
    if (!response.ok) throw new Error(`tiny intent HTTP ${response.status}`);
    const result = await response.json();
    if (!result?.intent) throw new Error('tiny intent response missing intent');
    return {
      intent: String(result.intent),
      confidence: Number(result.confidence) || 0,
      source: 'colab-model-endpoint',
    };
  } catch (error) {
    console.warn(`[tiny-intent] endpoint unavailable; using fallback: ${error.message}`);
    return localPredict(text);
  }
}

module.exports = { predictTinyIntent, localPredict };
