// ─────────────────────────────────────────────────────────────
// PEEKSHIELD Extension — Website Profiles Definition
// ─────────────────────────────────────────────────────────────

const PROFILES = {
  BANKING: {
    id: "BANKING",
    name: "Banking & Financial Services",
    icon: "🏦",
    patterns: [
      /bank/i,
      /chase\.com/i,
      /paypal\.com/i,
      /wellsfargo\.com/i,
      /bankofamerica\.com/i,
      /citi\.com/i,
      /capitalone\.com/i,
      /stripe\.com/i,
      /fidelity\.com/i,
      /coinbase\.com/i,
      /robinhood\.com/i,
      /finance/i,
      /checkout/i,
      /billing/i,
      /payment/i,
      /pay\./i,
    ],
    categories: {
      cards: true,
      bankAccounts: true,
      passwords: true,
      otps: true,
      emails: true,
      phones: true,
      chat: true,
      pii: true,
      messages: true,
    },
    blurIntensity: 16,
  },

  EMAIL_MESSAGING: {
    id: "EMAIL_MESSAGING",
    name: "Email & Direct Messaging",
    icon: "✉️",
    patterns: [
      /mail\.google\.com/i,
      /messages\.google\.com/i, // Google Messages / Web SMS
      /outlook\.(live|office)\.com/i,
      /web\.whatsapp\.com/i,
      /discord\.com/i,
      /slack\.com/i,
      /telegram\.org/i,
      /teams\.microsoft\.com/i,
      /messenger\.com/i,
      /signal\.org/i,
      /sms/i,
      /chat/i,
      /inbox/i,
    ],
    categories: {
      cards: true,
      bankAccounts: true,
      passwords: true,
      otps: true,
      emails: true,
      phones: true,
      chat: true,
      messages: true,
      pii: true,
    },
    blurIntensity: 14,
  },

  SOCIAL_MEDIA: {
    id: "SOCIAL_MEDIA",
    name: "Social Media & Networks",
    icon: "💬",
    patterns: [
      /(twitter|x)\.com/i,
      /facebook\.com/i,
      /instagram\.com/i,
      /linkedin\.com/i,
      /reddit\.com/i,
      /tiktok\.com/i,
    ],
    categories: {
      cards: true,
      bankAccounts: true,
      passwords: true,
      otps: true,
      emails: true,
      phones: true,
      chat: true,
      messages: true,
      pii: true,
    },
    blurIntensity: 12,
  },

  GENERAL: {
    id: "GENERAL",
    name: "General Browsing",
    icon: "🌐",
    patterns: [/.*/],
    categories: {
      cards: true,
      bankAccounts: true,
      passwords: true,
      otps: true,
      emails: true,
      phones: true,
      chat: true,
      messages: true,
      pii: true,
    },
    blurIntensity: 12,
  },
};

function resolveProfileForUrl(url) {
  if (!url || typeof url !== "string") return PROFILES.GENERAL;
  for (const [key, profile] of Object.entries(PROFILES)) {
    if (key === "GENERAL") continue;
    for (const pattern of profile.patterns) {
      if (pattern.test(url)) return profile;
    }
  }
  return PROFILES.GENERAL;
}
