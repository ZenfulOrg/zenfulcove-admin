// Screens marketing contacts for likely bots / junk before they're added to
// the Email Offers list. Bots were filling out the website newsletter form
// with random keystrokes ("LSguTNyhLZTYpovKcaaN"), so form-only contacts get
// the heuristic checks. Trusted sources (paying guests, check-in form, popup —
// which required a phone + opt-in) only get the hard checks.

const EMAIL_RE = /^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;

export const RELAY_DOMAINS = [
  "guest.airbnb.com",
  "airbnb.com",
  "guest.booking.com",
  "booking.com",
  "messages.homeaway.com",
  "homeaway.com",
  "vrbo.com",
  "expediapartnercentral.com",
  "glampinghub.com",
  "hipcamp.com",
];

const DISPOSABLE_DOMAINS = [
  "mailinator.com",
  "guerrillamail.com",
  "guerrillamail.net",
  "sharklasers.com",
  "10minutemail.com",
  "tempmail.com",
  "temp-mail.org",
  "tempmailo.com",
  "yopmail.com",
  "trashmail.com",
  "getnada.com",
  "dispostable.com",
  "maildrop.cc",
  "throwawaymail.com",
  "fakeinbox.com",
  "mohmal.com",
  "emailnator.com",
  "mailnesia.com",
  "spam4.me",
  "grr.la",
];

const PLACEHOLDER_LOCALS = ["test", "testing", "asdf", "qwerty", "noreply", "no-reply", "example", "fake", "none", "na"];

function domainMatches(domain, list) {
  return list.some((entry) => domain === entry || domain.endsWith(`.${entry}`));
}

function lowerToUpperSwitches(word) {
  let switches = 0;
  for (let i = 1; i < word.length; i++) {
    if (/[a-z]/.test(word[i - 1]) && /[A-Z]/.test(word[i])) switches++;
  }
  return switches;
}

// Same rule as zenfulcove-site/lib/antispam.ts: random mixed case or a long,
// nearly vowel-free token.
export function looksLikeGibberish(value) {
  const words = String(value || "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 2) return false;
  return words.some((word) => {
    const letters = word.replace(/[^a-zA-Z]/g, "");
    if (letters.length < 8) return false;
    if (lowerToUpperSwitches(letters) >= 3) return true;
    const vowels = (letters.match(/[aeiouyAEIOUY]/g) || []).length;
    return vowels / letters.length < 0.15;
  });
}

/**
 * Returns why an email should NOT be marketed to, or "" if it looks fine.
 * `trusted` skips the heuristic (bot-pattern) checks.
 */
export function contactRejectReason({ email, firstName = "", lastName = "" }, { trusted = false } = {}) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(normalized)) return "invalid email";
  const [local, domain] = normalized.split("@");
  if (domainMatches(domain, RELAY_DOMAINS)) return "OTA relay address";
  if (domainMatches(domain, DISPOSABLE_DOMAINS)) return "disposable email";
  if (PLACEHOLDER_LOCALS.includes(local) || domain === "example.com" || domain === "test.com") {
    return "placeholder email";
  }
  if (trusted) return "";

  const name = `${firstName} ${lastName}`.trim();
  if (looksLikeGibberish(firstName) || looksLikeGibberish(lastName)) return "gibberish name";
  if (/https?:|www\.|\.com\b|\.ru\b/i.test(name)) return "link in name";
  if (/[Ѐ-ӿ]/.test(name)) return "Cyrillic name (spam pattern)";
  if (/(gmail|googlemail)\.com$/.test(domain) && (local.match(/\./g) || []).length >= 3) {
    return "dotted Gmail (bot pattern)";
  }
  const localLetters = local.replace(/[^a-z]/g, "");
  if (localLetters.length >= 12) {
    const vowels = (localLetters.match(/[aeiouy]/g) || []).length;
    if (vowels / localLetters.length < 0.18) return "random email address";
  }
  return "";
}
