export interface ColloquialStyle {
  id: string;
  name: string;
  region: string;
  description: string;
  exampleInText: string;
}

export interface SampleMedia {
  id: string;
  title: string;
  duration: string;
  originalLanguage: string;
  targetStyle: string;
  thumbnail: string;
  videoUrl: string; // Public video sample URL or video-capable placeholder
  mockSpeech: string; // The speech in original tongue
  mockOutput: {
    detectedLanguage: string;
    targetStyle: string;
    translatedScript: string;
  };
}

export const COLLOQUIAL_STYLES: ColloquialStyle[] = [
  {
    id: "tanglish",
    name: "Tanglish (Tamil + English)",
    region: "Tamil Nadu, Chennai street-style",
    description: "Combines Tamil grammar frameworks with common English business, tech, and slang expressions.",
    exampleInText: "Appadiye intha script-ah transcribe panni, simple and direct-ah output ready pannunga machi."
  },
  {
    id: "hinglish",
    name: "Hinglish (Hindi + English)",
    region: "Delhi / Mumbai high-casual",
    description: "Smooth mixing of casual Hindi conversational phrasing with English corporate and technical jargon.",
    exampleInText: "Bro, upar diye gaye video ka automatic translation karke ekदम mast, super-chill sound-byte bana do."
  },
  {
    id: "benglish",
    name: "Benglish (Bengali + English)",
    region: "Kolkata collegiate talk",
    description: "Blends intellectual Bengali slang with quick, upbeat English conversational vocabulary.",
    exampleInText: "Ei video script-ta transcribe kore ekdom natural flow-te street-style edit kore de, please."
  },
  {
    id: "tenglish",
    name: "Tenglish (Telugu + English)",
    region: "Hyderabad / Andhra street-style",
    description: "Blends casual Telugu conversational grammar with everyday English tech, business, and slang words.",
    exampleInText: "Ee video script ni transcribe chesi, simple ga natural street-style lo output ready cheyyi ra."
  },
  {
    id: "kanglish",
    name: "Kanglish (Kannada + English)",
    region: "Bengaluru urban casual",
    description: "Mixes Kannada conversational phrasing with common English tech, corporate, and slang terms.",
    exampleInText: "Ee video script transcribe maadi, simple mattu natural street-style alli output ready maadi guru."
  },
  {
    id: "manglish",
    name: "Manglish (Malayalam + English)",
    region: "Kochi / Kerala casual talk",
    description: "Combines Malayalam conversational structures with modern English code-switching.",
    exampleInText: "Ee video script transcribe cheythu, simple aayi natural street-style aayi output ready aakku machane."
  },
  {
    id: "gujlish",
    name: "Gujlish (Gujarati + English)",
    region: "Ahmedabad / Surat casual",
    description: "Blends everyday Gujarati speech with common English business and tech vocabulary.",
    exampleInText: "Aa video nu script transcribe kari ne, simple ane natural street-style ma output ready kari de yaar."
  },
  {
    id: "marlish",
    name: "Marlish (Marathi + English)",
    region: "Mumbai / Pune casual",
    description: "Mixes Marathi conversational grammar with high-frequency English words and slang.",
    exampleInText: "He video che script transcribe karun, simple ani natural street-style madhe output ready kar na."
  },
  {
    id: "punglish",
    name: "Punglish (Punjabi + English)",
    region: "Chandigarh / Amritsar high-casual",
    description: "Energetic blend of Punjabi conversational phrasing with English code-switching.",
    exampleInText: "Ae video da script transcribe kar ke, simple te natural street-style vich output ready kar de yaar."
  },
  {
    id: "singlish",
    name: "Singlish (Singaporean English)",
    region: "Singapore streets & kopitiams",
    description: "Famous local blend incorporating Hokkien, Malay, Tamil, and English particles like 'lah', 'leh', 'lor'.",
    exampleInText: "You just transcribe this video script proper can already, don't worry about standard formal English lah."
  },
  {
    id: "spanglish",
    name: "Spanglish (Spanish + English)",
    region: "US Border & metro centers",
    description: "Seamlessly switching back and forth between casual Spanish and high-frequency English nouns and verbs.",
    exampleInText: "Oye, transcribe este video y haz el scripting bien natural, bien cool para las redes sociales."
  },
  {
    id: "taglish",
    name: "Taglish (Tagalog + English)",
    region: "Manila urban millennials",
    description: "Energetic mix of Tagalog conversational structures and modern English code-switching.",
    exampleInText: "Grabe, paki-transcribe naman nung video tapos translate natin into street-style Taglish para mas patok!"
  }
];

// NOTE: gender labels below match the ACTUAL Gemini prebuilt voice output.
// Gemini's Zephyr and Kore render as female voices; Puck, Charon, Fenrir and
// Orus render as male voices. Previously Zephyr was mislabeled "Male", which is
// why picking a "male" voice produced a female voiceover.
export const PREBUILT_VOICES = [
  // ── Male voices ──
  { id: "Puck", name: "Puck (Upbeat Male)", description: "High-spirited, casual, and fast-paced male narrator. Great for energetic reels." },
  { id: "Charon", name: "Charon (Deep Male)", description: "Calm, informative male voice with clear enunciation for script reading." },
  { id: "Fenrir", name: "Fenrir (Rich Deep Male)", description: "Reassuring, deep, and corporate-street sophisticated male voice." },
  { id: "Orus", name: "Orus (Firm Male)", description: "Steady, confident, and professional male tone." },
  // ── Female voices ──
  { id: "Kore", name: "Kore (Bright Female)", description: "Energetic, clear, and modern female voice. Great for social media reels." },
  { id: "Zephyr", name: "Zephyr (Friendly Female)", description: "Warm, smooth, and bright female voice." },
  { id: "Leda", name: "Leda (Youthful Female)", description: "Young, lively, and expressive female voice." }
];

export const SAMPLE_VIDEOS: SampleMedia[] = [
  {
    id: "sample-tech-vlog",
    title: "1. Chennai Tech Meetup Reel",
    duration: "0:24",
    originalLanguage: "Tamil",
    targetStyle: "Tanglish (Tamil + English)",
    thumbnail: "https://images.unsplash.com/photo-1540575467063-178a50c2df87?w=500&auto=format&fit=crop&q=60",
    videoUrl: "https://assets.mixkit.co/videos/preview/mixkit-man-holding-his-smartphone-with-a-blue-screen-40149-large.mp4",
    mockSpeech: "வணக்கம் நண்பர்களே, இன்றைக்கு நாங்க பார்த்துக்கிட்டு இருக்கிற இந்த மொபைல் போன் ரொம்ப அற்புதமான டிசைன். இதோட கேமரா குவாலிட்டி பத்தி நாம இன்னைக்கு டீடைல்டா ரிவ்யூ பண்ண போறோம். கடைசி வரைக்கும் வீடியோவை பாருங்க.",
    mockOutput: {
      detectedLanguage: "Tamil",
      targetStyle: "Tanglish (Tamil + English)",
      translatedScript: "Vanakkam guys! Inniku naama paaka pora intha mobile super powerful and design vera level. Ithoda camera capabilities pathi full detailed review intha reel-la discuss panna porom. So end varaikkum video-va skip pannama paarunga!"
    }
  },
  {
    id: "sample-mumbai-streetfood",
    title: "2. Mumbai Food Stall Review",
    duration: "0:18",
    originalLanguage: "Hindi",
    targetStyle: "Hinglish (Hindi + English)",
    thumbnail: "https://images.unsplash.com/photo-1601050690597-df056fb4ce78?w=500&auto=format&fit=crop&q=60",
    videoUrl: "https://assets.mixkit.co/videos/preview/mixkit-serving-food-to-a-customer-in-a-food-truck-42408-large.mp4",
    mockSpeech: "हे दोस्तों! आज हम मुंबई के सबसे मशहूर सैंडविच स्टाल पर आए हैं। यहाँ का चीज़ ग्रिल्ड सैंडविच इतना बढ़िया है कि सब लोग दीवाने हैं। इसकी रेसिपी बिल्कुल सीक्रेट है।",
    mockOutput: {
      detectedLanguage: "Hindi",
      targetStyle: "Hinglish (Hindi + English)",
      translatedScript: "Hey guys! Aaj hum Mumbai ke sabse popular sandwich stall pe aaye hain. Yahan ka cheese grilled sandwich literally itna amazing hai ki everyone is crazy about it. Aur iski recipe to pure secret hai boss!"
    }
  },
  {
    id: "sample-singapore-travel",
    title: "3. Marina Bay Vlog Short",
    duration: "0:21",
    originalLanguage: "English (Formal)",
    targetStyle: "Singlish (Singaporean English)",
    thumbnail: "https://images.unsplash.com/photo-1525625293386-3fb0172b35e9?w=500&auto=format&fit=crop&q=60",
    videoUrl: "https://assets.mixkit.co/videos/preview/mixkit-young-man-with-a-laptop-looking-at-something-in-the-city-43283-large.mp4",
    mockSpeech: "Welcome everyone to Marina Bay Sands. Today we are exploring the magnificent skyline and experiencing the brilliant light show. It is truly a beautiful sight.",
    mockOutput: {
      detectedLanguage: "English (Singaporean)",
      targetStyle: "Singlish (Singaporean English)",
      translatedScript: "Welcome everyone to Marina Bay Sands lah. Today we go see the gorgeous skyline and catch the light show, damn power one, cannot miss. Real beautiful sight lor!"
    }
  }
];
