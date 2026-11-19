/**
 * P2.1 rules prefilter (architecture §6.1 option B). Cheap, local, tuned for **recall**:
 * any query that *might* be a request to practise speaking goes on to the Groq classifier, which handles precision.
 * Queries that match nothing (greetings, coding, facts…) never cost a Groq call.
 * Patterns cover English, romanized Hinglish, Hindi, and (Phase 10) Bengali, Marathi and Telugu. Regional patterns are
 * DRAFTS like the regional copy: a native speaker should extend them from real dogfood queries. Bump PREFILTER_VERSION whenever a pattern changes.
 */
export const PREFILTER_VERSION = 'pf-v4'; // v2 (Phase 5): Devanagari Hindi · v3: Bengali, Marathi, Telugu · v4: one-word rule

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  // mock interview
  { name: 'interview', re: /(inter ?view|intrvw|\bmock\b|hr round|placement|personality test|tell me about yourself|why should (we|i|you) hire|\bcampus\b)/ },
  // spoken English / conversation
  {
    name: 'spoken_english',
    re: /(spoken english|speak(ing)? english|english (bol|speak|conversation|fluen|practi|mein confidence)|english m[ae]i?n?\b.*\bbaat|\b(correct|improve|check) (my|meri) english|\b(my|meri) english\b|fluen(cy|t)|small talk|role ?-?play|speaking partner|communication skill|self[- ]?intro|\bintroduction\b|group discussion|\bdebate\b|\bconversation\b)/,
  },
  // viva / oral revision / teach-back
  {
    name: 'viva',
    re: /(\bviva\b|\boral(ly)?\b|examiner|quiz (me|karo)|test (me|karo)|cross question|rapid ?-?fire|(ask|pooch\w*|puch\w*) (me |mujhse )?(some |few )?(questions?|sawal)|(sawal|questions?) (pooch|puch)\w*|stop me where|jahan galat|explain kar(ta|ti|unga|ungi)|i'?ll (explain|teach)|let me explain|samjhata hoon|samjhati hoon)/,
  },
  // pronunciation / accent
  {
    name: 'pronunciation',
    re: /(pronoun|pronunc|\baccent\b|tongue twister|silent letter|word stress|mother[- ]?tongue|how (do i|to|should i) (say|pronounce)|(help me|teach me) say|kaise bol|\bth\b'?|'th'|\bv (and|aur) w\b|\bsay\b.*\bcorrect)/,
  },
  // Devanagari Hindi (no \b: JS word boundaries are ASCII-only). Cards for `hi` still need classifier.languages to include it.
  {
    name: 'devanagari',
    re: /(इंटरव्यू|इन्टरव्यू|साक्षात्कार|मॉक|वाइवा|वायवा|मौखिक|उच्चारण|अंग्रेज़ी बोल|अंग्रेजी बोल|इंग्लिश बोल|प्रैक्टिस|अभ्यास|बोलकर|बोलने की|सवाल पूछ|बातचीत)/,
  },
  // Marathi (Devanagari): interview = मुलाखत, practice = सराव, oral = तोंडी, conversation = संभाषण
  { name: 'marathi', re: /(मुलाखत|सराव|इंग्रजी बोल|उच्चार|तोंडी|व्हायवा|प्रश्न विचार|संभाषण)/ },
  // Bengali script
  { name: 'bengali', re: /(ইন্টারভিউ|সাক্ষাৎকার|মক|ভাইভা|মৌখিক|উচ্চারণ|ইংরেজি বল|ইংলিশ বল|প্র্যাকটিস|অনুশীলন|প্রশ্ন কর|কথোপকথন|কথা বল)/ },
  // Telugu script
  { name: 'telugu', re: /(ఇంటర్వ్యూ|మాక్|వైవా|మౌఖిక|ఉచ్చారణ|ఇంగ్లీష్ మాట్లాడ|ఇంగ్లిష్ మాట్లాడ|ప్రాక్టీస్|అభ్యాస|ప్రశ్నలు అడ|సంభాష|మాట్లాడ)/ },
  // generic "practise aloud" verbs
  {
    name: 'practice',
    re: /(practi[cs]|rehears|out loud|\baloud\b|\bbol(na|ne|ke|kar|u|oon)\b|\bbolke\b|taiyari karwa|karwa (do|dena|o)\b|karwao|\broleplay\b)/,
  },
];

export interface PrefilterResult {
  pass: boolean;
  matched: string[];
}

export function prefilter(text: string): PrefilterResult {
  const t = text.toLowerCase().replace(/[’`]/g, "'");
  // v4 (Phase 10): a single word ("interview", "ইন্টারভিউ") is a topic, never a request to practise now (classifier
  // rule 2, ambiguous set). The model followed that rule in English but not reliably in Bengali / Telugu.
  if (t.trim().split(/\s+/).filter(Boolean).length < 2) return { pass: false, matched: [] };
  const matched = PATTERNS.filter((p) => p.re.test(t)).map((p) => p.name);
  return { pass: matched.length > 0, matched };
}
