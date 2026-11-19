import type { ClassifierLanguage } from '@svs/shared';

/** Common romanized-Hindi function words. Two hits (or one in a very short message) ⇒ Hinglish. */
const HINGLISH_WORDS = new Set([
  'hai', 'hain', 'kya', 'kaise', 'kaisa', 'kyun', 'mein', 'mujhe', 'mujhse', 'mera', 'meri', 'mere', 'humein',
  'karo', 'karwa', 'karwao', 'karna', 'karni', 'karta', 'karti', 'karunga', 'ka', 'ki', 'ke', 'ko', 'aur', 'nahi',
  'nahin', 'bhi', 'poocho', 'pucho', 'batao', 'samjhao', 'sikhao', 'sawal', 'taiyari', 'bolna', 'bolne', 'baat',
  'wala', 'wale', 'hoon', 'hu', 'tum', 'aap', 'apna', 'apne', 'chahiye', 'jab', 'jahan', 'abhi', 'aaj', 'bahut',
  'theek', 'sakte', 'sakta', 'raha', 'rahi', 'liye', 'bana', 'banao', 'likh', 'ye', 'yeh', 'woh', 'kuch', 'kal',
  'pe', 'se', 'de', 'kar', 'karte', 'din', 'ek', 'sunao', 'bhai', 'namaste', 'shukriya', 'dhanyavaad',
]);

const BENGALI = /[ঀ-৿]/g;
const TELUGU = /[ఀ-౿]/g;
const DEVANAGARI = /[ऀ-ॿ]/g;

/** Common words that appear in one of the two Devanagari languages but not (or rarely) in the other. */
const MARATHI_WORDS = new Set([
  'आहे', 'आहेत', 'आहोत', 'आणि', 'मला', 'माझा', 'माझी', 'माझे', 'माझ्या', 'तुम्ही', 'तुमचा', 'तुमची', 'तुमच्या', 'तुला', 'काय', 'कसे', 'कसा', 'कशी',
  'करा', 'नाही', 'होते', 'होता', 'साठी', 'मध्ये', 'पाहिजे', 'सांगा', 'द्या', 'घ्या', 'मुलाखत', 'मुलाखतीचा', 'मुलाखतीची', 'सराव', 'इंग्रजी', 'उद्या',
  'शकता', 'शकतो', 'विचारा', 'बोलायला', 'करायचा', 'करायची', 'कृपया', 'माझं', 'तोंडी', 'कोणती', 'कोणता', 'कोणते',
]);
/** Marathi glues postpositions onto words (…साठी "for", …मध्ये "in", …ण्याचा "of doing"); Hindi writes them apart. */
const MARATHI_SUFFIX = /(साठी|मध्ये|ण्याचा|ण्याची|ण्याचे|ण्यासाठी)$/;
const HINDI_WORDS = new Set([
  'है', 'हैं', 'और', 'मुझे', 'मेरा', 'मेरी', 'मेरे', 'क्या', 'कैसे', 'नहीं', 'के', 'की', 'का', 'में', 'लिए', 'करो', 'कीजिए', 'दीजिए', 'चाहिए',
  'अंग्रेज़ी', 'अंग्रेजी', 'कल', 'आप', 'हूँ', 'हूं', 'था', 'थी', 'से', 'को', 'पर', 'भी', 'लीजिए', 'पूछिए', 'बोलने',
]);

/** Devanagari text: Marathi when its marker words outnumber Hindi ones, else Hindi (the larger language). */
function marathiOrHindi(text: string): 'mr' | 'hi' {
  const words = text.split(/[^ऀ-ॿ]+/).filter(Boolean);
  const mr = words.filter((w) => MARATHI_WORDS.has(w) || (w.length > 4 && MARATHI_SUFFIX.test(w))).length;
  const hi = words.filter((w) => HINDI_WORDS.has(w)).length;
  return mr > hi ? 'mr' : 'hi';
}

/**
 * Server-side language tag (authoritative; the classifier model's own tag is only a hint).
 *   bn = mostly Bengali script · te = mostly Telugu script
 *   mr / hi = mostly Devanagari, split by marker words (Marathi and Hindi share the script) — defaults to hi
 *   hinglish = romanized Hindi words · en = everything else in Latin script
 */
export function detectLanguage(text: string): ClassifierLanguage {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  if (letters === 0) return 'other';
  const share = (re: RegExp) => (text.match(re)?.length ?? 0) / letters;
  if (share(BENGALI) >= 0.3) return 'bn';
  if (share(TELUGU) >= 0.3) return 'te';
  if (share(DEVANAGARI) >= 0.3) return marathiOrHindi(text);
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  const hits = words.filter((w) => HINGLISH_WORDS.has(w)).length;
  if (hits >= 2 || (hits === 1 && words.length <= 4)) return 'hinglish';
  return /[a-z]/i.test(text) ? 'en' : 'other';
}

/** The classifier model's language tag, corrected for languages it doesn't know (bn, mr, te). */
export function refineLanguage(modelTag: ClassifierLanguage, text: string): ClassifierLanguage {
  const detected = detectLanguage(text);
  return detected === 'bn' || detected === 'te' || detected === 'mr' ? detected : modelTag;
}
