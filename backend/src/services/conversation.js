const { env } = require('../config/env');

const EMPTY_APPOINTMENT = {
  patientName: null,
  doctorName: null,
  preferredDate: null,
  preferredTime: null,
  phoneNumber: null,
};

const STEPS = {
  ASK_NAME: 'ASK_NAME',
  ASK_DOCTOR: 'ASK_DOCTOR',
  ASK_DATE: 'ASK_DATE',
  ASK_TIME: 'ASK_TIME',
  CONFIRM: 'CONFIRM',
  COMPLETE: 'COMPLETE',
};

const LANG = {
  EN: 'en-IN',
  HI: 'hi-IN',
  BN: 'bn-IN',
};

const YES_PATTERN =
  /\b(yes|yeah|yep|yup|ok|okay|sure|correct|confirm|confirmed|right|haan|ha|ji)\b|हाँ|हां|जी हाँ|जी हां|ठीक है|सही|হ্যাঁ|হাঁ|হ্যা|ঠিক আছে|সঠিক|ঠিক/i;

const NO_PATTERN =
  /\b(no|nope|nah|wrong|incorrect|cancel|change|not)\b|नहीं|नही|गलत|না|ভুল|ঠিক নয়|ঠিক না/i;

function normalizeLanguage(detectedLanguage) {
  if (!detectedLanguage) return LANG.EN;
  const value = String(detectedLanguage).toLowerCase();
  if (value.startsWith('bn') || value.includes('bengali') || value.includes('bangla')) {
    return LANG.BN;
  }
  if (value.startsWith('hi') || value.includes('hindi')) {
    return LANG.HI;
  }
  if (value === 'mixed') return LANG.EN;
  return LANG.EN;
}

function cleanUtterance(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripLeadingLabels(text) {
  return cleanUtterance(text)
    .replace(
      /^(my name is|i am|i'm|name is|this is|মোর নাম|আমার নাম|মেरा नाम|मेरा नाम है|नाम है)\s+/i,
      ''
    )
    .replace(/^(doctor|dr\.?|ডাক্তার|डॉक्टर)\s+/i, '')
    .trim();
}

function isAffirmative(text) {
  const value = cleanUtterance(text);
  if (!value) return false;
  if (NO_PATTERN.test(value) && !YES_PATTERN.test(value)) return false;
  return YES_PATTERN.test(value);
}

function isNegative(text) {
  const value = cleanUtterance(text);
  if (!value) return false;
  if (YES_PATTERN.test(value) && !NO_PATTERN.test(value)) return false;
  return NO_PATTERN.test(value);
}

function matchDoctor(rawAnswer, allowedDoctors = []) {
  const answer = stripLeadingLabels(rawAnswer);
  if (!answer) return null;

  if (!allowedDoctors.length) return answer;

  const normalizedAnswer = answer.toLowerCase();
  const exact = allowedDoctors.find((doc) => doc.toLowerCase() === normalizedAnswer);
  if (exact) return exact;

  const partial = allowedDoctors.find((doc) => {
    const name = doc.toLowerCase();
    return normalizedAnswer.includes(name) || name.includes(normalizedAnswer);
  });
  if (partial) return partial;

  // Accept free-form doctor if caller named someone outside the list.
  return answer;
}

function messagesFor(lang) {
  const clinic = env.clinic.name;

  const pack = {
    [LANG.EN]: {
      greeting: (name) =>
        `Hello, welcome to ${name}. I can help you book an appointment request. May I know your name?`,
      askName: 'Sorry, I did not catch your name. Please say your full name.',
      askDoctor: (doctors) =>
        doctors.length
          ? `Thank you. Which doctor would you like to see? Available doctors are: ${doctors.join(', ')}.`
          : 'Thank you. Which doctor would you like to see?',
      askDoctorAgain: 'Please tell me the doctor name clearly.',
      askDate: 'Got it. What preferred date would you like for the appointment?',
      askDateAgain: 'Please say the preferred date again, for example tomorrow or 20 March.',
      askTime: 'Okay. What preferred time would you like?',
      askTimeAgain: 'Please say the preferred time again, for example 10 AM or 4:30 PM.',
      confirm: (data) =>
        `Please confirm this booking request. Patient ${data.patientName}, doctor ${data.doctorName}, date ${data.preferredDate}, time ${data.preferredTime}. Say yes to submit, or no to start again.`,
      confirmAgain: 'Please say yes to submit the booking request, or no to start again.',
      saved:
        'Your appointment booking request has been saved. The clinic will confirm separately. Thank you, goodbye.',
      saveFailed:
        'I collected your details, but could not save the appointment request right now. Please try again later.',
      restart: 'No problem. Let us start again. May I know your name?',
    },
    [LANG.HI]: {
      greeting: (name) =>
        `नमस्ते, ${name} में आपका स्वागत है। मैं अपॉइंटमेंट बुकिंग रिक्वेस्ट में मदद कर सकती हूँ। कृपया अपना नाम बताइए।`,
      askName: 'माफ़ कीजिए, आपका नाम समझ नहीं आया। कृपया अपना पूरा नाम बताइए।',
      askDoctor: (doctors) =>
        doctors.length
          ? `धन्यवाद। आप किस डॉक्टर से मिलना चाहते हैं? उपलब्ध डॉक्टर हैं: ${doctors.join(', ')}।`
          : 'धन्यवाद। आप किस डॉक्टर से मिलना चाहते हैं?',
      askDoctorAgain: 'कृपया डॉक्टर का नाम साफ़ बताइए।',
      askDate: 'ठीक है। अपॉइंटमेंट के लिए पसंदीदा तारीख क्या है?',
      askDateAgain: 'कृपया तारीख फिर से बताइए, जैसे कल या 20 मार्च।',
      askTime: 'अच्छा। पसंदीदा समय क्या है?',
      askTimeAgain: 'कृपया समय फिर से बताइए, जैसे सुबह 10 बजे या शाम 4:30।',
      confirm: (data) =>
        `कृपया कन्फर्म कीजिए। मरीज़ ${data.patientName}, डॉक्टर ${data.doctorName}, तारीख ${data.preferredDate}, समय ${data.preferredTime}। हाँ कहें तो रिक्वेस्ट सेव होगी, नहीं कहें तो दोबारा शुरू करेंगे।`,
      confirmAgain: 'कृपया हाँ कहें रिक्वेस्ट सेव करने के लिए, या नहीं कहें दोबारा शुरू करने के लिए।',
      saved:
        'आपकी अपॉइंटमेंट बुकिंग रिक्वेस्ट सेव हो गई है। क्लिनिक अलग से कन्फर्म करेगा। धन्यवाद, नमस्ते।',
      saveFailed:
        'मैंने आपकी जानकारी ले ली है, लेकिन अभी रिक्वेस्ट सेव नहीं हो सकी। कृपया बाद में फिर कोशिश कीजिए।',
      restart: 'कोई बात नहीं। चलिए फिर से शुरू करते हैं। कृपया अपना नाम बताइए।',
    },
    [LANG.BN]: {
      greeting: (name) =>
        `নমস্কার, ${name}-এ আপনাকে স্বাগতম। আমি অ্যাপয়েন্টমেন্ট বুকিং রিকোয়েস্টে সাহায্য করতে পারি। আপনার নাম বলবেন কি?`,
      askName: 'দুঃখিত, আপনার নাম বুঝতে পারিনি। অনুগ্রহ করে আপনার পুরো নাম বলুন।',
      askDoctor: (doctors) =>
        doctors.length
          ? `ধন্যবাদ। আপনি কোন ডাক্তারের সাথে দেখা করতে চান? উপলব্ধ ডাক্তার: ${doctors.join(', ')}।`
          : 'ধন্যবাদ। আপনি কোন ডাক্তারের সাথে দেখা করতে চান?',
      askDoctorAgain: 'অনুগ্রহ করে ডাক্তারের নাম স্পষ্ট করে বলুন।',
      askDate: 'ঠিক আছে। অ্যাপয়েন্টমেন্টের জন্য পছন্দের তারিখ কী?',
      askDateAgain: 'অনুগ্রহ করে তারিখ আবার বলুন, যেমন কালকে বা ২০ মার্চ।',
      askTime: 'ভালো। পছন্দের সময় কী?',
      askTimeAgain: 'অনুগ্রহ করে সময় আবার বলুন, যেমন সকাল ১০টা বা বিকেল ৪:৩০।',
      confirm: (data) =>
        `অনুগ্রহ করে নিশ্চিত করুন। রোগী ${data.patientName}, ডাক্তার ${data.doctorName}, তারিখ ${data.preferredDate}, সময় ${data.preferredTime}। হ্যাঁ বললে রিকোয়েস্ট সেভ হবে, না বললে আবার শুরু করব।`,
      confirmAgain: 'অনুগ্রহ করে হ্যাঁ বলুন রিকোয়েস্ট সেভ করতে, অথবা না বলুন আবার শুরু করতে।',
      saved:
        'আপনার অ্যাপয়েন্টমেন্ট বুকিং রিকোয়েস্ট সেভ হয়েছে। ক্লিনিক আলাদাভাবে নিশ্চিত করবে। ধন্যবাদ, নমস্কার।',
      saveFailed:
        'আমি আপনার তথ্য নিয়েছি, কিন্তু এখন রিকোয়েস্ট সেভ করা যায়নি। অনুগ্রহ করে পরে আবার চেষ্টা করুন।',
      restart: 'কোনো সমস্যা নেই। চলুন আবার শুরু করি। আপনার নাম বলবেন কি?',
    },
  };

  return pack[lang] || pack[LANG.EN];
}

function getGreetingMessage(clinicName = env.clinic.name, language = LANG.EN) {
  const lang = normalizeLanguage(language);
  return messagesFor(lang).greeting(clinicName);
}

function getSaveFailedMessage(language = LANG.EN) {
  return messagesFor(normalizeLanguage(language)).saveFailed;
}

/**
 * Rule-based turn processor for appointment booking.
 * Collects: name → doctor → date → time → confirm, then marks ready to save.
 */
function processConversationTurn({
  userText,
  detectedLanguage = null,
  step = STEPS.ASK_NAME,
  appointmentData = EMPTY_APPOINTMENT,
  clinicName = env.clinic.name,
  doctors = env.clinic.doctors,
  callerPhone = null,
} = {}) {
  const lang = normalizeLanguage(detectedLanguage);
  const copy = messagesFor(lang);
  const nextData = {
    ...EMPTY_APPOINTMENT,
    ...appointmentData,
  };

  if (!nextData.phoneNumber && callerPhone) {
    nextData.phoneNumber = callerPhone;
  }

  const utterance = cleanUtterance(userText);

  if (!utterance) {
    const retryByStep = {
      [STEPS.ASK_NAME]: copy.askName,
      [STEPS.ASK_DOCTOR]: copy.askDoctorAgain,
      [STEPS.ASK_DATE]: copy.askDateAgain,
      [STEPS.ASK_TIME]: copy.askTimeAgain,
      [STEPS.CONFIRM]: copy.confirmAgain,
      [STEPS.COMPLETE]: copy.saved,
    };
    return {
      response: retryByStep[step] || copy.askName,
      appointmentData: nextData,
      step,
      appointmentReady: false,
      detectedLanguage: lang,
    };
  }

  switch (step) {
    case STEPS.ASK_NAME: {
      const name = stripLeadingLabels(utterance);
      if (!name || name.length < 2) {
        return {
          response: copy.askName,
          appointmentData: nextData,
          step: STEPS.ASK_NAME,
          appointmentReady: false,
          detectedLanguage: lang,
        };
      }
      nextData.patientName = name;
      return {
        response: copy.askDoctor(doctors),
        appointmentData: nextData,
        step: STEPS.ASK_DOCTOR,
        appointmentReady: false,
        detectedLanguage: lang,
      };
    }

    case STEPS.ASK_DOCTOR: {
      const doctorName = matchDoctor(utterance, doctors);
      if (!doctorName || doctorName.length < 2) {
        return {
          response: copy.askDoctorAgain,
          appointmentData: nextData,
          step: STEPS.ASK_DOCTOR,
          appointmentReady: false,
          detectedLanguage: lang,
        };
      }
      nextData.doctorName = doctorName;
      return {
        response: copy.askDate,
        appointmentData: nextData,
        step: STEPS.ASK_DATE,
        appointmentReady: false,
        detectedLanguage: lang,
      };
    }

    case STEPS.ASK_DATE: {
      const preferredDate = cleanUtterance(utterance);
      if (!preferredDate || preferredDate.length < 2) {
        return {
          response: copy.askDateAgain,
          appointmentData: nextData,
          step: STEPS.ASK_DATE,
          appointmentReady: false,
          detectedLanguage: lang,
        };
      }
      nextData.preferredDate = preferredDate;
      return {
        response: copy.askTime,
        appointmentData: nextData,
        step: STEPS.ASK_TIME,
        appointmentReady: false,
        detectedLanguage: lang,
      };
    }

    case STEPS.ASK_TIME: {
      const preferredTime = cleanUtterance(utterance);
      if (!preferredTime || preferredTime.length < 1) {
        return {
          response: copy.askTimeAgain,
          appointmentData: nextData,
          step: STEPS.ASK_TIME,
          appointmentReady: false,
          detectedLanguage: lang,
        };
      }
      nextData.preferredTime = preferredTime;
      return {
        response: copy.confirm(nextData),
        appointmentData: nextData,
        step: STEPS.CONFIRM,
        appointmentReady: false,
        detectedLanguage: lang,
      };
    }

    case STEPS.CONFIRM: {
      if (isAffirmative(utterance)) {
        return {
          response: copy.saved,
          appointmentData: nextData,
          step: STEPS.COMPLETE,
          appointmentReady: true,
          detectedLanguage: lang,
        };
      }

      if (isNegative(utterance)) {
        return {
          response: copy.restart,
          appointmentData: { ...EMPTY_APPOINTMENT, phoneNumber: nextData.phoneNumber },
          step: STEPS.ASK_NAME,
          appointmentReady: false,
          detectedLanguage: lang,
        };
      }

      return {
        response: copy.confirmAgain,
        appointmentData: nextData,
        step: STEPS.CONFIRM,
        appointmentReady: false,
        detectedLanguage: lang,
      };
    }

    case STEPS.COMPLETE:
      return {
        response: copy.saved,
        appointmentData: nextData,
        step: STEPS.COMPLETE,
        appointmentReady: false,
        detectedLanguage: lang,
      };

    default:
      return {
        response: copy.greeting(clinicName),
        appointmentData: nextData,
        step: STEPS.ASK_NAME,
        appointmentReady: false,
        detectedLanguage: lang,
      };
  }
}

module.exports = {
  EMPTY_APPOINTMENT,
  STEPS,
  processConversationTurn,
  getGreetingMessage,
  getSaveFailedMessage,
  normalizeLanguage,
};
