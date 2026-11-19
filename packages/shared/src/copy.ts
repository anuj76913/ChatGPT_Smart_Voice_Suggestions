import { PRESET_BY_INTENT, type VoiceIntent } from './intents';

/**
 * S11 Copy catalog (FR-2, FR-11; design-spec §8). English (v1), Hindi (Phase 5), and the top 3 regional languages
 * (Phase 10): Bengali, Marathi, Telugu.
 *
 * Every non-English language is a DRAFT (COPY_STATUS) until a native speaker reviews it (and Legal where wording is
 * sensitive). A language only appears on cards when it is in config `copy.languages` AND the classifier has been
 * evaluated on it (config `classifier.languages`, gate: `npm run ops:language -- check <lang>`).
 */
export type CopyLanguage = 'en' | 'hi' | 'bn' | 'mr' | 'te';
export const COPY_LANGUAGES: CopyLanguage[] = ['en', 'hi', 'bn', 'mr', 'te'];

/** Review state per language. Change to 'reviewed' only with the reviewer's name in the PR (FR-11). */
export const COPY_STATUS: Record<CopyLanguage, 'reviewed' | 'draft'> = { en: 'reviewed', hi: 'draft', bn: 'draft', mr: 'draft', te: 'draft' };

export interface SuggestionCopy {
  title: string;
  why_line: string;
  cta: string;
  headphone_hint: string;
  opt_out_label: string;
  dismiss_label: string;
}

const COMMON: Record<CopyLanguage, Omit<SuggestionCopy, 'title'>> = {
  en: {
    why_line: 'Speak your answers out loud and get instant feedback on your confidence and accuracy.',
    cta: 'Try Voice Practice',
    headphone_hint: 'Tip: use headphones in a shared space.',
    opt_out_label: "Don't suggest voice",
    dismiss_label: 'Dismiss suggestion',
  },
  hi: {
    why_line: 'अपने जवाब बोलकर दें और अपने आत्मविश्वास और सटीकता पर तुरंत फ़ीडबैक पाएँ।',
    cta: 'वॉइस प्रैक्टिस आज़माएँ',
    headphone_hint: 'सुझाव: साझा जगह में हेडफ़ोन लगाएँ।',
    opt_out_label: 'वॉइस का सुझाव न दें',
    dismiss_label: 'सुझाव हटाएँ',
  },
  bn: {
    why_line: 'উত্তরগুলো জোরে বলে অনুশীলন করুন, আর আত্মবিশ্বাস ও নির্ভুলতা নিয়ে সঙ্গে সঙ্গে মতামত পান।',
    cta: 'ভয়েস প্র্যাকটিস করে দেখুন',
    headphone_hint: 'পরামর্শ: ভিড়ের জায়গায় হেডফোন ব্যবহার করুন।',
    opt_out_label: 'ভয়েসের পরামর্শ দেখাবেন না',
    dismiss_label: 'পরামর্শটি সরান',
  },
  mr: {
    why_line: 'तुमची उत्तरे मोठ्याने बोला आणि तुमच्या आत्मविश्वासावर व अचूकतेवर लगेच अभिप्राय मिळवा.',
    cta: 'व्हॉइस सराव करून पाहा',
    headphone_hint: 'टीप: सार्वजनिक ठिकाणी हेडफोन वापरा.',
    opt_out_label: 'व्हॉइसची सूचना दाखवू नका',
    dismiss_label: 'सूचना काढा',
  },
  te: {
    why_line: 'మీ సమాధానాలను గట్టిగా చెప్పి, మీ ఆత్మవిశ్వాసం మరియు ఖచ్చితత్వంపై వెంటనే ఫీడ్‌బ్యాక్ పొందండి.',
    cta: 'వాయిస్ ప్రాక్టీస్ ప్రయత్నించండి',
    headphone_hint: 'సూచన: జనం ఉన్న చోట హెడ్‌ఫోన్స్ వాడండి.',
    opt_out_label: 'వాయిస్ సూచనలు చూపించవద్దు',
    dismiss_label: 'సూచనను తీసివేయండి',
  },
};

const TITLES: Record<CopyLanguage, Record<VoiceIntent, string>> = {
  en: {
    mock_interview: 'Practice your interview with voice',
    spoken_english: 'Practice speaking English',
    viva_revision: 'Practice your viva aloud',
    pronunciation: 'Practice your pronunciation',
  },
  hi: {
    mock_interview: 'आवाज़ से इंटरव्यू की प्रैक्टिस करें',
    spoken_english: 'अंग्रेज़ी बोलने की प्रैक्टिस करें',
    viva_revision: 'वाइवा की प्रैक्टिस बोलकर करें',
    pronunciation: 'उच्चारण की प्रैक्टिस करें',
  },
  bn: {
    mock_interview: 'ভয়েসে ইন্টারভিউয়ের প্র্যাকটিস করুন',
    spoken_english: 'ইংরেজি বলার প্র্যাকটিস করুন',
    viva_revision: 'জোরে বলে ভাইভার প্র্যাকটিস করুন',
    pronunciation: 'উচ্চারণের প্র্যাকটিস করুন',
  },
  mr: {
    mock_interview: 'आवाजात मुलाखतीचा सराव करा',
    spoken_english: 'इंग्रजी बोलण्याचा सराव करा',
    viva_revision: 'मोठ्याने बोलून व्हायवाचा सराव करा',
    pronunciation: 'उच्चारांचा सराव करा',
  },
  te: {
    mock_interview: 'వాయిస్‌తో ఇంటర్వ్యూ ప్రాక్టీస్ చేయండి',
    spoken_english: 'ఇంగ్లీష్ మాట్లాడటం ప్రాక్టీస్ చేయండి',
    viva_revision: 'గట్టిగా చెబుతూ వైవా ప్రాక్టీస్ చేయండి',
    pronunciation: 'ఉచ్చారణ ప్రాక్టీస్ చేయండి',
  },
};

/** A language tag → the copy language to use (Hinglish readers use Latin script, so English). */
export const copyLanguageFor = (language: string | null | undefined): CopyLanguage =>
  (COPY_LANGUAGES as string[]).includes(language ?? '') ? (language as CopyLanguage) : 'en';

/** Falls back to English when a language has no copy yet (edge-case UI-12). */
export function suggestionCopy(intent: VoiceIntent, language: string = 'en'): SuggestionCopy {
  const lang = copyLanguageFor(language);
  return { title: TITLES[lang][intent] ?? 'Practice with Voice', ...COMMON[lang] };
}

/** The card payload sent in the `suggestion` stream event and with stored messages (architecture §9.1). */
export interface SuggestionCardPayload {
  suggestion_id: string;
  intent: VoiceIntent;
  preset_id: string;
  preset_label: string;
  /** Language of the copy, for the `lang` attribute (screen readers pronounce it correctly). */
  language: CopyLanguage;
  copy: SuggestionCopy;
}

export function suggestionCard(suggestionId: string, intent: VoiceIntent, language: string = 'en'): SuggestionCardPayload {
  const lang = copyLanguageFor(language);
  return {
    suggestion_id: suggestionId,
    intent,
    preset_id: PRESET_BY_INTENT[intent].presetId,
    preset_label: PRESET_BY_INTENT[intent].label,
    language: lang,
    copy: suggestionCopy(intent, lang),
  };
}
