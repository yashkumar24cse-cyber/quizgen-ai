const Anthropic = require("@anthropic-ai/sdk");
const crypto    = require("crypto");

// ─── Client ───────────────────────────────────────────────────────────────────

let client = null;
function getClient() {
    if (!process.env.ANTHROPIC_API_KEY) return null;
    if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return client;
}
function isAvailable() { return Boolean(process.env.ANTHROPIC_API_KEY); }

// ─── Configurable limits ──────────────────────────────────────────────────────

function getMaxQuestionCount() {
    return Math.max(1, parseInt(process.env.MAX_QUESTION_COUNT) || 100);
}
const BATCH_THRESHOLD = Math.max(1, parseInt(process.env.BATCH_THRESHOLD) || 20);
const BATCH_SIZE      = Math.max(5, parseInt(process.env.BATCH_SIZE)      || 15);
const BATCH_CONCURRENCY = 3;

// ─── L1 Cache (in-process Map, 1-hour TTL) ───────────────────────────────────

const L1_TTL_MS = 60 * 60 * 1000;
const l1Cache   = new Map();
const CACHE_SCHEMA_VERSION = "v1"; // Increment this whenever QuestionSchema changes

function l1Key(...parts) {
    return crypto.createHash("sha256").update([CACHE_SCHEMA_VERSION, ...parts].join("|")).digest("hex");
}
function l1Get(key) {
    const e = l1Cache.get(key);
    if (!e) return null;
    if (Date.now() > e.expiresAt) { l1Cache.delete(key); return null; }
    return e.data;
}
function l1Set(key, data) {
    l1Cache.set(key, { data, expiresAt: Date.now() + L1_TTL_MS });
    // Evict expired entries when cache grows large
    if (l1Cache.size > 500) {
        const now = Date.now();
        for (const [k, v] of l1Cache) { if (now > v.expiresAt) l1Cache.delete(k); }
    }
}

// ─── L2 Cache (MongoDB QuizCache, 24-hour TTL) ────────────────────────────────
// Lazy-required to avoid circular dep / startup ordering issues.

function getQuizCacheModel() {
    try { return require("./models/QuizCache"); } catch { return null; }
}

async function l2Get(key) {
    if (!global.dbConnected) return null;
    const QuizCache = getQuizCacheModel();
    if (!QuizCache) return null;
    try {
        const entry = await QuizCache.findOneAndUpdate(
            { cacheKey: key },
            { $inc: { hitCount: 1 } },
            { new: false }
        );
        if (!entry) return null;
        console.log(`[aiQuizGenerator] L2 (MongoDB) cache hit — hits so far: ${entry.hitCount + 1}`);
        return entry.questions;
    } catch { return null; }
}

async function l2Set(key, questions, questionType) {
    if (!global.dbConnected) return;
    const QuizCache = getQuizCacheModel();
    if (!QuizCache) return;
    try {
        await QuizCache.updateOne(
            { cacheKey: key },
            { $set: { questions, questionType, createdAt: new Date() }, $setOnInsert: { hitCount: 0 } },
            { upsert: true }
        );
    } catch { /* non-fatal */ }
}

// ─── In-flight request deduplication ─────────────────────────────────────────
// If two identical requests arrive within milliseconds (double-click, retry),
// both get the same Promise — only one API call is made.

const pendingRequests = new Map();  // cacheKey → Promise<questions[]>

// ─── Concurrency semaphore (no external package needed) ───────────────────────

function createSemaphore(max) {
    let running = 0;
    const queue = [];
    return function acquire(fn) {
        return new Promise((resolve, reject) => {
            const run = () => {
                running++;
                Promise.resolve().then(fn).then(
                    val => { running--; queue.length && queue.shift()(); resolve(val); },
                    err => { running--; queue.length && queue.shift()(); reject(err); }
                );
            };
            running < max ? run() : queue.push(run);
        });
    };
}
const batchSemaphore = createSemaphore(BATCH_CONCURRENCY);

// ─── Retry with exponential backoff ──────────────────────────────────────────

const RETRYABLE = new Set([429, 500, 502, 503, 529]);
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function withRetry(fn, maxRetries = 3) {
    let last;
    for (let i = 0; i <= maxRetries; i++) {
        try { return await fn(); }
        catch (err) {
            last = err;
            const retryable = RETRYABLE.has(err.status) ||
                              ["ECONNRESET","ETIMEDOUT","ENOTFOUND"].includes(err.code);
            if (i < maxRetries && retryable) {
                const delay = 500 * Math.pow(2, i) + Math.random() * 200;
                console.warn(`[aiQuizGenerator] attempt ${i+1} failed — retrying in ${Math.round(delay)}ms`);
                await sleep(delay);
            } else break;
        }
    }
    throw last;
}

// ─── Claude call helpers ──────────────────────────────────────────────────────

async function callClaude(system, userContent, maxTokens = 8192) {
    const anthropic = getClient();
    if (!anthropic) throw new Error("ANTHROPIC_API_KEY is not set");
    const response = await withRetry(() =>
        anthropic.messages.create({
            model: "claude-sonnet-4-5",
            max_tokens: maxTokens,
            system,
            messages: [{ role: "user", content: userContent }]
        })
    );
    const textBlock = response.content.find(b => b.type === "text");
    if (!textBlock) throw new Error("No text response from AI");
    return textBlock.text.trim();
}

function parseJsonArray(raw) {
    const cleaned = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/, "");
    const parsed  = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) throw new Error("Expected a JSON array");
    return parsed;
}

// ─── Incremental JSON-object extractor (for SSE streaming) ────────────────────
// Pulls complete { … } objects out of a partial JSON string without needing
// the full response. Returns { objects: Object[], consumed: number }.

function extractJsonObjects(text) {
    const objects = [];
    let i = 0;
    let lastConsumed = 0;

    while (i < text.length) {
        const start = text.indexOf("{", i);
        if (start === -1) break;

        let depth = 0; let inString = false; let escape = false; let j = start;
        while (j < text.length) {
            const ch = text[j];
            if (escape) { escape = false; j++; continue; }
            if (ch === "\\" && inString) { escape = true; j++; continue; }
            if (ch === "\"") { inString = !inString; j++; continue; }
            if (inString) { j++; continue; }
            if (ch === "{") depth++;
            else if (ch === "}") {
                depth--;
                if (depth === 0) {
                    try {
                        const obj = JSON.parse(text.slice(start, j + 1));
                        // Only accept objects that look like quiz questions
                        if (obj && (obj.question || obj.questionPrompt || obj.correctAnswer)) {
                            objects.push(obj);
                            lastConsumed = j + 1;
                        }
                    } catch { /* partial / malformed — skip */ }
                    i = j + 1;
                    break;
                }
            }
            j++;
        }
        if (j >= text.length) break; // incomplete object — wait for more text
        if (i <= start) i = start + 1;
    }
    return { objects, consumed: lastConsumed };
}

// ─── Supported types ──────────────────────────────────────────────────────────

const VALID_QUESTION_TYPES = ["multiple-choice","true-false","short-answer","explain","essay"];
function getSupportedQuestionTypes() { return [...VALID_QUESTION_TYPES]; }

// ─── Utilities ────────────────────────────────────────────────────────────────

function shuffleArray(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}
const VALID_DIFFS = new Set(["easy","medium","hard"]);
function normDifficulty(d) { return VALID_DIFFS.has(d) ? d : "medium"; }

/** Simple fingerprint for deduplication across batches. */
function questionFingerprint(q) {
    return (q.questionPrompt || q.question || "").toLowerCase()
        .replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
}

/** Remove questions whose prompts are near-duplicates across batch results. */
function deduplicateQuestions(questions) {
    const seen = new Set();
    return questions.filter(q => {
        const fp = questionFingerprint(q);
        if (seen.has(fp)) return false;
        seen.add(fp);
        return true;
    });
}

// ─── System prompts ───────────────────────────────────────────────────────────

function buildSystemPrompt(count, questionType, targetLanguage = "English") {
    const diffInstructions = `
Rate each question difficulty:
- "easy"   — answer stated almost verbatim in the source
- "medium" — requires paraphrasing or light inference
- "hard"   — requires synthesising multiple sentences`;

    const langInstruction = `\nCRITICAL: You MUST write all questions, prompts, correct answers, choices/options, explanations, and rubric criteria in the target language "${targetLanguage}". Output MUST be entirely in "${targetLanguage}".`;

    switch (questionType) {
        case "true-false":
            return `You are a quiz question generator. Given source text, produce exactly ${count} true/false questions.
Respond with ONLY a JSON array. Each element:
{
  "question":      "a declarative statement",
  "correctAnswer": "True" or "False",
  "explanation":   "one sentence why",
  "difficulty":    "easy"|"medium"|"hard"
}
${diffInstructions}
${langInstruction}
Rules: verifiable from text; roughly half true half false; no repeated facts.`;

        case "short-answer":
            return `You are a quiz question generator. Given source text, produce exactly ${count} short-answer questions.
Respond with ONLY a JSON array. Each element:
{
  "question":      "string",
  "correctAnswer": "1–5 word ideal answer",
  "explanation":   "one sentence context",
  "difficulty":    "easy"|"medium"|"hard"
}
${diffInstructions}
${langInstruction}`;

        case "essay":
            return `You are a quiz question generator. Given source text, produce exactly ${count} essay / long-form answer questions.
For each question, also generate a customized grading rubric consisting of 2-3 specific evaluation criteria.

Respond with ONLY a JSON array. Each element:
{
  "question":      "string — an essay prompt requiring a paragraph-length explanation",
  "correctAnswer": "string — 1-2 sentence sample ideal response",
  "explanation":   "one sentence context / pedagogical explanation",
  "difficulty":    "easy"|"medium"|"hard",
  "essayRubric": [
    { "criterion": "string (e.g. Accuracy, Clarity, Completeness)", "maxPoints": 5 },
    { "criterion": "string", "maxPoints": 5 }
  ]
}
${diffInstructions}
${langInstruction}`;

        case "multiple-choice":
        default:
            return `You are a quiz question generator. Given source text, produce exactly ${count} multiple-choice questions with MISCONCEPTION-BASED distractors.

Respond with ONLY a JSON array. Each element:
{
  "question":      "string",
  "correctAnswer": "the correct choice",
  "distractors": [
    { "text": "wrong answer", "misconceptionAddressed": "People often… / A common misconception is…" },
    { "text": "wrong answer", "misconceptionAddressed": "string" },
    { "text": "wrong answer", "misconceptionAddressed": "string" }
  ],
  "explanation":   "why the correct answer is right",
  "difficulty":    "easy"|"medium"|"hard"
}
${diffInstructions}
${langInstruction}
Rules: each distractor targets a specific, documented misconception; distractors must be plausible; no repeated facts.`;
    }
}

// ─── Normalise raw AI response into the internal question shape ────────────────

function normalise(q, questionType) {
    const difficulty = normDifficulty(q.difficulty);
    switch (questionType) {
        case "true-false":
            return {
                sentenceOriginal:  q.question,
                questionPrompt:    q.question,
                correctAnswer:     (q.correctAnswer === "True" || q.correctAnswer === true) ? "True" : "False",
                choicesPool:       ["True","False"],
                distractorDetails: [],
                explanation:       q.explanation || "",
                type:              "true-false",
                difficulty
            };
        case "short-answer":
            return {
                sentenceOriginal:  q.question,
                questionPrompt:    q.question,
                correctAnswer:     q.correctAnswer,
                choicesPool:       [],
                distractorDetails: [],
                explanation:       q.explanation || "",
                type:              "short-answer",
                difficulty
            };
        case "essay":
            return {
                sentenceOriginal:  q.question,
                questionPrompt:    q.question,
                correctAnswer:     q.correctAnswer,
                choicesPool:       [],
                distractorDetails: [],
                explanation:       q.explanation || "",
                type:              "essay",
                difficulty,
                essayRubric:       Array.isArray(q.essayRubric) ? q.essayRubric.map(r => ({ criterion: r.criterion || "Accuracy", maxPoints: Number(r.maxPoints) || 5 })) : []
            };
        case "multiple-choice":
        default: {
            const distractorDetails = (q.distractors || []).slice(0,3).map(d =>
                typeof d === "object"
                    ? { text: d.text || "", misconceptionAddressed: d.misconceptionAddressed || "" }
                    : { text: d, misconceptionAddressed: "" }
            );
            const choicesPool = shuffleArray([q.correctAnswer, ...distractorDetails.map(d => d.text)]);
            return {
                sentenceOriginal:  q.question,
                questionPrompt:    q.question,
                correctAnswer:     q.correctAnswer,
                choicesPool,
                distractorDetails,
                explanation:       q.explanation || "",
                type:              "multiple-choice",
                difficulty
            };
        }
    }
}

// ─── Single-batch AI call ─────────────────────────────────────────────────────

async function generateBatch(trimmedText, batchCount, questionType, targetLanguage = "English") {
    const system = buildSystemPrompt(batchCount, questionType, targetLanguage);
    const raw    = await callClaude(system, `Source text:\n\n${trimmedText}`);
    return parseJsonArray(raw).map(q => normalise(q, questionType));
}

// ─── Batch generation with concurrency limit ──────────────────────────────────

async function generateInBatches(trimmedText, totalCount, questionType, targetLanguage = "English") {
    // Split totalCount into BATCH_SIZE chunks
    const batches = [];
    for (let remaining = totalCount; remaining > 0; remaining -= BATCH_SIZE) {
        batches.push(Math.min(BATCH_SIZE, remaining));
    }
    console.log(`[aiQuizGenerator] batching: ${batches.length} batches of ~${BATCH_SIZE} (concurrency=${BATCH_CONCURRENCY})`);

    // Run with semaphore-controlled concurrency
    const results = await Promise.all(
        batches.map(size => batchSemaphore(() => generateBatch(trimmedText, size, questionType, targetLanguage)))
    );

    return deduplicateQuestions(results.flat());
}

// ═══════════════════════════════════════════════════════════════════════════════
//  1. checkCache — check both L1 and L2 caches, returning cached array with _fromCache=true
// ═══════════════════════════════════════════════════════════════════════════════

async function checkCache(text, count, questionType, difficulty = null, targetLanguage = "English") {
    const maxCount    = getMaxQuestionCount();
    const trimmedText = text.slice(0, 20000);
    const fetchCount  = difficulty
        ? Math.min(Math.ceil(count * 2), maxCount)
        : Math.min(count, maxCount);
    const key = l1Key(trimmedText, fetchCount, questionType, difficulty || "any", targetLanguage);

    const l1Hit = l1Get(key);
    if (l1Hit) {
        console.log("[aiQuizGenerator] L1 (memory) cache hit");
        const res = difficulty ? l1Hit.filter(q => q.difficulty === difficulty).slice(0, count) : [...l1Hit];
        res._fromCache = true;
        return res;
    }

    const l2Hit = await l2Get(key);
    if (l2Hit) {
        l1Set(key, l2Hit);  // promote to L1
        const res = difficulty ? l2Hit.filter(q => q.difficulty === difficulty).slice(0, count) : [...l2Hit];
        res._fromCache = true;
        return res;
    }

    return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  2. generateQuizWithAI — main entry point
//     Check cache → in-flight dedup → AI call (single/batch)
// ═══════════════════════════════════════════════════════════════════════════════

async function generateQuizWithAI(text, targetCount, questionType = "multiple-choice", difficulty = null, targetLanguage = "English") {
    if (!VALID_QUESTION_TYPES.includes(questionType)) {
        throw new Error(`Invalid questionType "${questionType}". Must be one of: ${VALID_QUESTION_TYPES.join(", ")}`);
    }

    // Check cache
    const cached = await checkCache(text, targetCount, questionType, difficulty, targetLanguage);
    if (cached) return cached;

    const maxCount    = getMaxQuestionCount();
    const trimmedText = text.slice(0, 20000);
    const fetchCount  = difficulty
        ? Math.min(Math.ceil(targetCount * 2), maxCount)
        : Math.min(targetCount, maxCount);
    const key = l1Key(trimmedText, fetchCount, questionType, difficulty || "any", targetLanguage);

    // ── In-flight dedup: attach to an identical pending request ─────────────
    if (pendingRequests.has(key)) {
        console.log("[aiQuizGenerator] deduped — attaching to in-flight request");
        return pendingRequests.get(key);
    }

    // ── Actual AI call ──────────────────────────────────────────────────────
    const promise = (async () => {
        try {
            let questions = fetchCount > BATCH_THRESHOLD
                ? await generateInBatches(trimmedText, fetchCount, questionType, targetLanguage)
                : await generateBatch(trimmedText, fetchCount, questionType, targetLanguage);

            // Critique Pass
            if (isAvailable()) {
                console.log(`[aiQuizGenerator] Running quality critique pass on ${questions.length} questions...`);
                const reviews = await critiqueQuestions(questions, trimmedText);
                const passedQuestions = questions.filter((_, idx) => {
                    const review = reviews.find(r => r.index === idx);
                    return !review || review.ok !== false;
                });
                
                let discardedCount = questions.length - passedQuestions.length;
                console.log(`[aiQuizGenerator] Critique complete: ${passedQuestions.length} passed, ${discardedCount} discarded.`);

                let attempts = 0;
                questions = passedQuestions;
                while (questions.length < fetchCount && attempts < 2 && discardedCount > 0) {
                    attempts++;
                    console.log(`[aiQuizGenerator] Attempting to generate ${discardedCount} replacements (attempt ${attempts})...`);
                    const replacements = await generateBatch(trimmedText, discardedCount, questionType, targetLanguage);
                    const repReviews = await critiqueQuestions(replacements, trimmedText);
                    const repPassed = replacements.filter((_, idx) => {
                        const review = repReviews.find(r => r.index === idx);
                        return !review || review.ok !== false;
                    });
                    questions = deduplicateQuestions([...questions, ...repPassed]);
                    discardedCount = fetchCount - questions.length;
                }
            }

            // Tag each question with qualityChecked: true
            questions.forEach(q => { q.qualityChecked = true; });

            // Store in both cache layers
            l1Set(key, questions);
            l2Set(key, questions, questionType).catch(() => {}); // fire-and-forget

            return questions;
        } finally {
            pendingRequests.delete(key);
        }
    })();

    pendingRequests.set(key, promise);
    const result = await promise;

    return difficulty
        ? result.filter(q => q.difficulty === difficulty).slice(0, targetCount)
        : result;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  2. streamQuizWithAI — async generator for SSE streaming
//     Uses the Anthropic streaming API; yields normalised questions one-by-one
//     as they appear in the partial JSON, without waiting for the full response.
// ═══════════════════════════════════════════════════════════════════════════════

async function* streamQuizWithAI(text, count, questionType = "multiple-choice", difficulty = null, targetLanguage = "English") {
    const anthropic = getClient();
    if (!anthropic) throw new Error("ANTHROPIC_API_KEY is not set");

    const trimmedText = text.slice(0, 20000);
    const system      = buildSystemPrompt(count, questionType, targetLanguage);
    const emitted     = new Set();
    let   accumulated = "";
    let   processed   = 0;    // bytes of `accumulated` already scanned
    let   yieldedCount = 0;

    const stream = await withRetry(() =>
        anthropic.messages.create({
            model:      "claude-sonnet-4-5",
            max_tokens: 8192,
            stream:     true,
            system,
            messages:   [{ role: "user", content: `Source text:\n\n${trimmedText}` }]
        })
    );

    for await (const event of stream) {
        if (event.type !== "content_block_delta" || event.delta?.type !== "text_delta") continue;
        accumulated += event.delta.text;

        // Only scan new portion for complete objects
        const slice = accumulated.slice(processed);
        const { objects, consumed } = extractJsonObjects(slice);

        for (const obj of objects) {
            if (yieldedCount >= count) break;
            const q  = normalise(obj, questionType);
            const fp = questionFingerprint(q);
            if (emitted.has(fp)) continue;
            if (difficulty && q.difficulty !== difficulty) continue;
            emitted.add(fp);
            yieldedCount++;
            yield q;
        }

        if (consumed > 0) processed += consumed;
        if (yieldedCount >= count) break;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  3. generateTwoTruthsRound
// ═══════════════════════════════════════════════════════════════════════════════

async function generateTwoTruthsRound(text, count) {
    const trimmedText = text.slice(0, 20000);
    const safeCount   = Math.max(1, Math.min(Number(count) || 3, 10));
    const key         = l1Key("two-truths", trimmedText, safeCount);
    const cached      = l1Get(key);
    if (cached) return cached;

    const system = `You are a "Two Truths and a Lie" game master. Given source text, produce exactly ${safeCount} rounds.
Each round has three statements — two factually true (based on the text) and one false (a plausible lie that contradicts the text).

Respond with ONLY a JSON array. Each element:
{
  "statements": ["statement A", "statement B", "statement C"],
  "lieIndex":   0 | 1 | 2,
  "explanation": "one sentence explaining why the lie is false and what the truth actually is"
}

Rules:
- All true statements must be directly supported by the text.
- The lie must be plausible and relate to the same topic as the true statements.
- Vary the position of the lie (lieIndex) across rounds.
- Do not reuse the same fact in multiple rounds.`;

    const raw    = await callClaude(system, `Source text:\n\n${trimmedText}`, 2000);
    const parsed = parseJsonArray(raw);
    const result = parsed.map(item => ({
        statements:  Array.isArray(item.statements) ? item.statements.slice(0, 3) : [],
        lieIndex:    Number.isInteger(item.lieIndex) && item.lieIndex >= 0 && item.lieIndex <= 2
                         ? item.lieIndex : 2,
        explanation: item.explanation || ""
    }));

    l1Set(key, result);
    return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  4. gradeExplanation — Feynman explain-it-back
// ═══════════════════════════════════════════════════════════════════════════════

async function gradeExplanation({ question, correctAnswer, playerExplanation }) {
    if (!isAvailable()) throw new Error("ANTHROPIC_API_KEY is not set");
    if (!playerExplanation?.trim()) return { pass:false, score:"none", feedback:"No explanation was provided." };

    const system = `You are an educational grader using the Feynman technique.
Respond with ONLY a JSON object (no markdown):
{
  "pass":     true | false,
  "score":    "full" | "partial" | "none",
  "feedback": "exactly one encouraging sentence"
}
Rubric: "full"→pass (captures key concept in own words), "partial"→pass (understands but misses a detail), "none"→fail (incorrect or irrelevant).
Be generous with partial credit.`;

    const raw = await callClaude(system,
        `Question: ${question}\nCorrect answer: ${correctAnswer}\nStudent's explanation: ${playerExplanation}`, 512);
    const cleaned = raw.replace(/^```json\s*/i,"").replace(/```\s*$/,"");
    let parsed;
    try { parsed = JSON.parse(cleaned); } catch { throw new Error("Failed to parse grading response"); }
    return {
        pass:     Boolean(parsed.pass),
        score:    ["full","partial","none"].includes(parsed.score) ? parsed.score : "none",
        feedback: parsed.feedback || "No feedback available."
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  5. generateDebriefScript — 100–150 word audio debrief
// ═══════════════════════════════════════════════════════════════════════════════

async function generateDebriefScript({ playerName, score, totalQuestions, wrongAnswers = [] }) {
    if (!isAvailable()) throw new Error("ANTHROPIC_API_KEY is not set");

    const pct    = totalQuestions > 0 ? Math.round((score/totalQuestions)*100) : 0;
    const missed = wrongAnswers.slice(0, 5);
    const wrongSummary = missed.length === 0
        ? "They answered every question correctly."
        : missed.map((w,i) =>
            `${i+1}. Q: "${w.question}" — answered "${w.playerAnswer}", correct: "${w.correctAnswer}". ${w.explanation||""}`
          ).join("\n");

    const system = `You are a friendly, encouraging quiz tutor recording a short personalised audio summary.
Write a natural-sounding spoken script of exactly 100–150 words. Use the player's name. Be warm and specific.
No markdown, bullet points, or headers — this is spoken audio. End with one actionable study tip.`;

    return await callClaude(system,
        `Player: ${playerName}\nScore: ${score}/${totalQuestions} (${pct}%)\nMissed:\n${wrongSummary}`, 300);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  6. critiqueQuestions — Self-critique pass to filter quality
// ═══════════════════════════════════════════════════════════════════════════════

async function critiqueQuestions(questions, sourceText) {
    if (!isAvailable()) return questions.map((_, i) => ({ index: i, ok: true, reason: "" }));
    if (questions.length === 0) return [];

    const system = `You are a strict educational content reviewer. Check each question for quality.
Flag any question that:
1. Is ambiguous or poorly phrased.
2. Has more than one defensible correct answer.
3. Gives away the correct answer in its own wording.
4. Is trivially guessable without reading the source text.

Respond with ONLY a JSON array matching the index order of the questions:
[
  { "index": 0, "ok": true | false, "reason": "why if false" },
  ...
]`;

    const userContent = `Source Text:\n${sourceText.slice(0, 5000)}\n\nQuestions:\n${JSON.stringify(questions.map((q, i) => ({ index: i, question: q.questionPrompt, choices: q.choicesPool, answer: q.correctAnswer })), null, 2)}`;
    try {
        const raw = await callClaude(system, userContent, 1024);
        const parsed = parseJsonArray(raw);
        return parsed;
    } catch (e) {
        console.warn("[critique] Critique pass failed, defaulting all to OK:", e.message);
        return questions.map((_, i) => ({ index: i, ok: true, reason: "" }));
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  7. gradeEssay — Essay rubrics evaluation
// ═══════════════════════════════════════════════════════════════════════════════

async function gradeEssay({ question, correctAnswer, rubric, playerExplanation }) {
    if (!isAvailable()) throw new Error("ANTHROPIC_API_KEY is not set");

    const system = `You are a professional academic grader. Grade the student's essay answer based on the provided grading rubric.
Provide points for each criterion (up to maxPoints) and constructive feedback.

Respond with ONLY a JSON object (no markdown):
{
  "score":    number (total score),
  "maxScore": number (total possible points),
  "breakdown": [
    { "criterion": "Criterion Name", "score": number, "feedback": "string" },
    ...
  ]
}`;

    const userContent = `Question: ${question}
Ideal Answer Model: ${correctAnswer}
Rubric: ${JSON.stringify(rubric)}
Student Answer: ${playerExplanation}`;

    const raw = await callClaude(system, userContent, 1024);
    return JSON.parse(raw.replace(/^```json\s*/i, "").replace(/```\s*$/, ""));
}

// ═══════════════════════════════════════════════════════════════════════════════
//  8. evaluateUserQuestion — Reverse practice mode grading
// ═══════════════════════════════════════════════════════════════════════════════

async function evaluateUserQuestion({ sourceText, userQuestion, userCorrectAnswer }) {
    if (!isAvailable()) throw new Error("ANTHROPIC_API_KEY is not set");

    const system = `You are a pedagogy expert evaluating a question written by a student.
Assess if the question is factual, grammatically correct, non-trivial (requires reading/understanding), and has a clear correct answer.

Respond with ONLY a JSON object (no markdown):
{
  "score":    number (0-100),
  "feedback": "constructive advice explaining strengths and improvement points",
  "ok":       true | false (true if score >= 80)
}`;

    const userContent = `Source Document text:\n${sourceText.slice(0, 5000)}
Student's proposed Question: ${userQuestion}
Student's proposed Answer: ${userCorrectAnswer}`;

    const raw = await callClaude(system, userContent, 512);
    return JSON.parse(raw.replace(/^```json\s*/i, "").replace(/```\s*$/, ""));
}

// ═══════════════════════════════════════════════════════════════════════════════
//  9. generateQuizWithImages — Claude Vision Multimodal Quizzing
// ═══════════════════════════════════════════════════════════════════════════════

async function generateQuizWithImages(text, base64Images, targetCount, questionType = "multiple-choice", targetLanguage = "English") {
    const anthropic = getClient();
    if (!anthropic) throw new Error("ANTHROPIC_API_KEY is not set");

    const count = Math.max(1, Math.min(Number(targetCount) || 5, 20));
    const system = buildSystemPrompt(count, questionType, targetLanguage) + `
Additionally, you are provided with diagrams/images extracted from the document.
IMPORTANT: At least half of the generated questions must reference visual details in the images (e.g. "Based on the diagram...").
Include the visual source key "imageRef": "imageX.png" (e.g. "image0.png") on each question that uses an image.`;

    // Map images to Claude Vision blocks
    const imageBlocks = base64Images.map((img, index) => ({
        type: "image",
        source: {
            type: "base64",
            media_type: "image/png",
            data: img.data
        }
    }));

    const userContent = [
        ...imageBlocks,
        {
            type: "text",
            text: `Image filenames in order: ${base64Images.map(img => img.filename).join(", ")}\n\nSource text:\n\n${text.slice(0, 15000)}`
        }
    ];

    const response = await withRetry(() =>
        anthropic.messages.create({
            model: "claude-sonnet-4-5",
            max_tokens: 4096,
            system,
            messages: [{ role: "user", content: userContent }]
        })
    );

    const textBlock = response.content.find(b => b.type === "text");
    const parsed = parseJsonArray(textBlock.text.trim());
    return parsed.map(q => {
        const normalised = normalise(q, questionType);
        if (q.imageRef) normalised.imageRef = q.imageRef;
        return normalised;
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  10. generateSocraticHint — Socratic retry hint generator
// ═══════════════════════════════════════════════════════════════════════════════

async function generateSocraticHint({ question, correctAnswer, playerAnswer, sourceText }) {
    if (!isAvailable()) throw new Error("ANTHROPIC_API_KEY is not set");

    const system = `You are a Socratic tutor. A student answered a question incorrectly.
Instead of giving them the correct answer, formulate one simple, clear guiding question or prompt that nudges them toward realizing their mistake.
Address the specific misconception shown in their wrong answer. Keep the hint under 30 words.`;

    const userContent = `Source context:\n${sourceText.slice(0, 3000)}
Question: ${question}
Ideal Answer: ${correctAnswer}
Student's Incorrect Answer: ${playerAnswer}`;

    return await callClaude(system, userContent, 200);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  11. verifySourceFacts — SANITY check fact verification pass
// ═══════════════════════════════════════════════════════════════════════════════

async function verifySourceFacts(text) {
    if (!isAvailable()) return [];

    const system = `You are a factual safety reviewer. Find any statements in the text that are clearly wrong, outdated, or logically contradictory.
Ignore minor opinions; flag only clear factual errors or contradictions.

Respond with ONLY a JSON array (no markdown):
[
  { "statement": "the sentence from text", "issue": "Brief type", "explanation": "Why it is incorrect" }
]`;

    const raw = await callClaude(system, `Text to review:\n${text.slice(0, 10000)}`, 1024);
    try {
        return parseJsonArray(raw);
    } catch {
        return [];
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  12. determinePrerequisites — Sequence learning path ordering
// ═══════════════════════════════════════════════════════════════════════════════

async function determinePrerequisites(documents) {
    if (!isAvailable()) return documents.map(d => d.id);

    const system = `You are an instructional designer. Given a list of documents with titles and contents, determine a logical learning sequence (prerequisite order).
Explain which concepts are foundational and must be learned first.

Respond with ONLY a JSON array containing the ordered document IDs (foundational first):
[
  "id_1",
  "id_2",
  ...
]`;

    const docSummaries = documents.map(d => `ID: ${d.id}\nTitle: ${d.filename}\nSummary: ${d.text.slice(0, 1000)}`).join("\n\n");
    const raw = await callClaude(system, `Documents list:\n\n${docSummaries}`, 512);
    try {
        return parseJsonArray(raw);
    } catch {
        return documents.map(d => d.id);
    }
}

// ─── Flashcard Generation ──────────────────────────────────────────────────────

async function generateFlashcardsWithAI(text, count, targetLanguage = "English") {
    if (!isAvailable()) throw new Error("Anthropic API key is not configured.");
    const safeCount = Math.max(1, Math.min(Number(count) || 5, 20));
    const trimmedText = text.slice(0, 20000);

    const system = `You are an educational assistant that generates high-quality study flashcards from a source text.
Produce exactly ${safeCount} flashcards. Each card must have a "front" (a question, concept, or term) and a "back" (the answer, explanation, or definition).
Keep them concise and clear.

Respond with ONLY a JSON array. Each element:
{
  "front": "string",
  "back": "string"
}
CRITICAL: You MUST write both the front and back of the flashcards in the target language: "${targetLanguage}". Output MUST be entirely in "${targetLanguage}".`;

    const raw = await callClaude(system, `Source text:\n\n${trimmedText}`);
    return parseJsonArray(raw);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    generateQuizWithAI,
    checkCache,
    streamQuizWithAI,
    generateTwoTruthsRound,
    gradeExplanation,
    generateDebriefScript,
    critiqueQuestions,
    gradeEssay,
    evaluateUserQuestion,
    generateQuizWithImages,
    generateSocraticHint,
    verifySourceFacts,
    determinePrerequisites,
    generateFlashcardsWithAI,
    isAvailable,
    getSupportedQuestionTypes
};
