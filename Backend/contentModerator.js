/**
 * contentModerator.js
 *
 * Lightweight, zero-dependency content moderation for text submitted to the
 * quiz generator. Checks for:
 *   1. PII patterns  — email, phone, US SSN, credit-card-like numbers
 *   2. Basic profanity — small blocklist of the most common offensive words
 *
 * Returns { ok: true } if the text passes, or
 *         { ok: false, reason: "…" } if it should be rejected with HTTP 400.
 *
 * This is intentionally conservative: false-positives are better than letting
 * sensitive data reach the AI API.
 */

// ─── PII Patterns ─────────────────────────────────────────────────────────────

const PII_PATTERNS = [
    {
        name: "email address",
        re: /\b[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}\b/i
    },
    {
        name: "US phone number",
        re: /\b(\+1[\s.\-]?)?\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}\b/
    },
    {
        name: "US Social Security Number",
        re: /\b\d{3}-\d{2}-\d{4}\b/
    },
    {
        name: "credit card number",
        // 13–19 digit sequences with optional spaces or dashes — crude but catches most formats
        re: /\b(?:\d[\s\-]?){13,19}\b/
    }
];

// ─── Profanity Blocklist ───────────────────────────────────────────────────────

// Keep this list small and limited to the most egregious terms to minimise
// false positives on legitimate educational content.
const PROFANITY_BLOCKLIST = new Set([
    "fuck", "fucking", "fucked", "fucker",
    "shit", "shitting", "shitty",
    "cunt", "cunts",
    "nigger", "niggers",
    "faggot", "faggots",
    "asshole", "assholes",
    "bitch", "bitches",
    "cock", "cocks",
    "dick", "dicks",
    "pussy", "pussies",
    "motherfucker", "motherfuckers",
    "whore", "whores",
    "bastard", "bastards",
    "retard", "retards",
    "piss", "pisses"
]);

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * @param {string} text
 * @returns {{ ok: boolean, reason?: string }}
 */
function moderateText(text) {
    if (!text || typeof text !== "string") return { ok: true };

    // 1. PII check
    for (const { name, re } of PII_PATTERNS) {
        if (re.test(text)) {
            return {
                ok: false,
                reason: `Submission appears to contain a ${name}. Please remove any personal or sensitive information before generating a quiz.`
            };
        }
    }

    // 2. Profanity check (word-boundary aware, case-insensitive)
    const words = text.toLowerCase().match(/\b[a-z]+\b/g) || [];
    for (const word of words) {
        if (PROFANITY_BLOCKLIST.has(word)) {
            return {
                ok: false,
                reason: "Submission contains content that violates our acceptable use policy. Please revise your text."
            };
        }
    }

    return { ok: true };
}

module.exports = { moderateText };
