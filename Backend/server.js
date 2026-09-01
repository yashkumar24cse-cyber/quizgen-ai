require("dotenv").config();

const Result          = require("./models/Result");
const Quiz            = require("./models/Quiz");
const Analytics       = require("./models/Analytics");
const UserPerformance = require("./models/UserPerformance");
const SourceDocument  = require("./models/SourceDocument");
const LearningPath    = require("./models/LearningPath");
const Note            = require("./models/Note");
const Flashcard       = require("./models/Flashcard");
const StudyPlan       = require("./models/StudyPlan");
const StudyGroup      = require("./models/StudyGroup");
const { v4: uuidv4 }  = require("uuid");
const mongoose        = require("mongoose");
const connectDB       = require("./database");
const generateQuiz    = require("./quizGenerator");
const {
    generateQuizWithAI,
    checkCache,
    streamQuizWithAI,
    generateTwoTruthsRound,
    gradeExplanation,
    generateDebriefScript,
    gradeEssay,
    evaluateUserQuestion,
    generateQuizWithImages,
    generateSocraticHint,
    verifySourceFacts,
    determinePrerequisites,
    generateFlashcardsWithAI,
    isAvailable: aiAvailable,
    getSupportedQuestionTypes
} = require("./aiQuizGenerator");
const { moderateText } = require("./contentModerator");
const express     = require("express");
const cors        = require("cors");
const multer      = require("multer");
const mammoth     = require("mammoth");
const JSZip       = require("jszip");
const https       = require("https");
const zlib        = require("zlib");
const compression = require("compression");

const app = express();
connectDB();

// ─── CORS ─────────────────────────────────────────────────────────────────────

const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",").map(o => o.trim())
    : null;

app.use(cors(allowedOrigins
    ? { origin: (origin, cb) => (!origin || allowedOrigins.includes(origin)) ? cb(null,true) : cb(new Error("Not allowed by CORS")) }
    : {}
));

// ─── Gzip compression (using compression package + custom size logger) ───────
// Measures uncompressed vs compressed sizes for /generate-quiz and /quiz-history

app.use((req, res, next) => {
    if (!["/generate-quiz", "/quiz-history"].some(p => req.path.startsWith(p))) {
        return next();
    }
    res._compressedSize = 0;
    const rawWrite = res.write;
    const rawEnd   = res.end;

    res.write = function(chunk, encoding, callback) {
        if (chunk) res._compressedSize += chunk.length;
        return rawWrite.call(res, chunk, encoding, callback);
    };

    res.end = function(chunk, encoding, callback) {
        if (chunk) res._compressedSize += chunk.length;
        const result = rawEnd.call(res, chunk, encoding, callback);

        const uncomp = res._uncompressedSize || 0;
        const comp   = res._compressedSize || 0;
        const saved  = uncomp > 0 ? Math.round((1 - comp / uncomp) * 100) : 0;
        console.log(`[gzip] ${req.method} ${req.path}: ${(uncomp / 1024).toFixed(1)}KB → ${(comp / 1024).toFixed(1)}KB (-${saved}%)`);
        return result;
    };
    next();
});

app.use(compression());

app.use((req, res, next) => {
    if (!["/generate-quiz", "/quiz-history"].some(p => req.path.startsWith(p))) {
        return next();
    }
    res._uncompressedSize = 0;
    const compWrite = res.write;
    const compEnd   = res.end;

    res.write = function(chunk, encoding, callback) {
        if (chunk) res._uncompressedSize += chunk.length;
        return compWrite.call(res, chunk, encoding, callback);
    };

    res.end = function(chunk, encoding, callback) {
        if (chunk) res._uncompressedSize += chunk.length;
        return compEnd.call(res, chunk, encoding, callback);
    };
    next();
});

app.use(express.json({ limit: "1mb" }));

// ─── In-memory fallbacks ──────────────────────────────────────────────────────

const memoryQuizzes         = [];
const memoryResults         = [];
const memoryAnalytics       = [];
const memoryUserPerformance = [];
const memoryNotes           = [];
const memoryFlashcards      = [];
const memoryStudyPlans      = [];
const memoryStudyGroups     = [];

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_UPLOAD_BYTES    = 5 * 1024 * 1024;
const MAX_QUIZ_TEXT_CHARS = 50000;
const MAX_QUESTION_COUNT  = Math.max(1, parseInt(process.env.MAX_QUESTION_COUNT) || 100);
const BG_JOB_THRESHOLD    = Math.max(1, parseInt(process.env.BG_JOB_THRESHOLD)   || 30);

// ─── Leaderboard in-memory cache ─────────────────────────────────────────────

const LEADERBOARD_TTL_MS = Math.max(1000, parseInt(process.env.LEADERBOARD_CACHE_TTL_MS) || 30000);
const leaderboardCache   = new Map();  // quizCode → { data, expiresAt }

function lbCacheGet(code) {
    const e = leaderboardCache.get(code);
    if (!e || Date.now() > e.expiresAt) { leaderboardCache.delete(code); return null; }
    console.log(`[leaderboard cache] hit for ${code}`);
    return e.data;
}
function lbCacheSet(code, data) {
    leaderboardCache.set(code, { data, expiresAt: Date.now() + LEADERBOARD_TTL_MS });
}
function lbCacheInvalidate(code) {
    leaderboardCache.delete(code);
    leaderboardCache.delete("GLOBAL");
}

// ─── Background job queue ─────────────────────────────────────────────────────

const JOB_TTL_MS = 10 * 60 * 1000; // 10 minutes
const jobMap     = new Map();  // jobId → { status, questions?, error?, createdAt }

setInterval(() => {
    const now = Date.now();
    for (const [id, job] of jobMap) { if (now - job.createdAt > JOB_TTL_MS) jobMap.delete(id); }
}, 60_000).unref();

function createJob() {
    const id = uuidv4();
    jobMap.set(id, { status: "pending", createdAt: Date.now() });
    return id;
}
function finishJob(id, questions) { if (jobMap.has(id)) jobMap.get(id).status = "done", jobMap.get(id).questions = questions; }
function failJob(id, error)       { if (jobMap.has(id)) jobMap.get(id).status = "error", jobMap.get(id).error = error.message; }

// ─── Rate limiter ─────────────────────────────────────────────────────────────

function createRateLimiter({ windowMs, max, message }) {
    const store = new Map();
    setInterval(() => {
        const now = Date.now();
        for (const [ip, rec] of store) { if (now >= rec.resetAt) store.delete(ip); }
    }, windowMs).unref();

    return (req, res, next) => {
        const ip  = req.ip || (req.connection && req.connection.remoteAddress) || "unknown";
        const now = Date.now();
        let rec   = store.get(ip);
        if (!rec || now >= rec.resetAt) {
            rec = { count: 1, resetAt: now + windowMs };
            store.set(ip, rec);
        } else {
            if (rec.count >= max) {
                const retryAfter = Math.ceil((rec.resetAt - now) / 1000);
                res.setHeader("Retry-After", retryAfter);
                return res.status(429).json({ error: message || "Too many requests", retryAfter });
            }
            rec.count++;
        }

        res.on("finish", () => {
            if (res.statusCode >= 400) {
                const current = store.get(ip);
                if (current && current.count > 0) {
                    current.count--;
                }
            }
        });

        next();
    };
}

const uploadLimit   = createRateLimiter({ windowMs: Number(process.env.RATE_UPLOAD_WINDOW_MS)   || 900000,  max: Number(process.env.RATE_UPLOAD_MAX)   || 20, message: "Too many upload requests."   });
const generateLimit = createRateLimiter({ windowMs: Number(process.env.RATE_GENERATE_WINDOW_MS) || 900000,  max: Number(process.env.RATE_GENERATE_MAX) || 20, message: "Too many generate requests." });
const createLimit   = createRateLimiter({ windowMs: Number(process.env.RATE_CREATE_WINDOW_MS)   || 3600000, max: Number(process.env.RATE_CREATE_MAX)   || 30, message: "Too many create requests."   });

// ─── Multer ───────────────────────────────────────────────────────────────────

const uploadMiddleware = multer({
    storage: multer.memoryStorage(),
    limits:  { fileSize: MAX_UPLOAD_BYTES }
}).fields([
    { name: "document",  maxCount: 1 },
    { name: "documents", maxCount: 5 }
]);

// ─── Text extractors ──────────────────────────────────────────────────────────

function extractPdfText(buffer) {
    const str = buffer.toString("latin1");
    const blocks = [];
    const btEtRe = /BT([\s\S]*?)ET/g;
    let m;
    while ((m = btEtRe.exec(str)) !== null) {
        const block = m[1];
        for (const tj of (block.match(/\(([^)\\]*(?:\\.[^)\\]*)*)\)\s*Tj/g) || [])) {
            const text = tj.match(/\(([^)\\]*(?:\\.[^)\\]*)*)\)/)?.[1] || "";
            if (text.trim()) blocks.push(text);
        }
        for (const tjj of (block.match(/\[([^\]]*)\]\s*TJ/g) || [])) {
            const texts = [...tjj.matchAll(/\(([^)\\]*(?:\\.[^)\\]*)*)\)/g)].map(x => x[1]);
            if (texts.join("").trim()) blocks.push(texts.join(""));
        }
    }
    return blocks.join(" ").replace(/\s+/g, " ").trim();
}

async function extractPptxText(buffer) {
    const zip   = await JSZip.loadAsync(buffer);
    const files = Object.keys(zip.files)
        .filter(n => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
        .sort((a,b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
    const parts = [];
    for (const f of files) {
        const xml  = await zip.files[f].async("string");
        const text = (xml.match(/<a:t[^>]*>([^<]*)<\/a:t>/g) || [])
            .map(t => t.replace(/<[^>]+>/g,"").trim()).filter(Boolean).join(" ");
        if (text) parts.push(text);
    }
    return parts.join("\n\n");
}

async function extractText(file) {
    const name = (file.originalname || "").toLowerCase();
    if (name.endsWith(".txt"))  return { text: file.buffer.toString("utf8") };
    if (name.endsWith(".docx")) { const {value} = await mammoth.extractRawText({ buffer: file.buffer }); return { text: value }; }
    if (name.endsWith(".pdf"))  { const text = extractPdfText(file.buffer); return text ? { text } : { text:"", error:"Could not extract text from this PDF." }; }
    if (name.endsWith(".pptx") || name.endsWith(".ppt")) return { text: await extractPptxText(file.buffer) };
    return { text:"", error:"Unsupported file type. Allowed: .txt, .docx, .pdf, .pptx" };
}

// ─── Confidence scoring ───────────────────────────────────────────────────────

const POINTS   = { correct:{ high:3, medium:2, low:1 }, wrong:{ high:-2, medium:-1, low:0 } };
const CONF_PROB = { low:0.33, medium:0.60, high:0.90 };

function computeConfidenceScores(answers) {
    if (!answers || answers.length === 0) return { confidenceScore:null, calibrationScore:null };
    let totalPoints = 0; let brierSum = 0;
    for (const a of answers) {
        const conf   = ["low","medium","high"].includes(a.confidence) ? a.confidence : "medium";
        const correct = Boolean(a.correct);
        totalPoints  += correct ? POINTS.correct[conf] : POINTS.wrong[conf];
        brierSum     += Math.pow(CONF_PROB[conf] - (correct ? 1 : 0), 2);
    }
    return {
        confidenceScore:  Math.max(0, totalPoints),
        calibrationScore: Math.round(Math.max(0, (1 - brierSum / answers.length) * 100))
    };
}

// ─── Analytics / UserPerformance (fire-and-forget) ────────────────────────────

function logEvent(event, extra = {}) {
    if (!global.dbConnected) {
        memoryAnalytics.push({ event, ...extra, createdAt: new Date() });
        if (memoryAnalytics.length > 1000) memoryAnalytics.shift();
        return;
    }
    Analytics.create({ event, ...extra }).catch(e => console.warn("[analytics]", e.message));
}

function logUserPerformance(records) {
    if (!records || records.length === 0) return;
    if (!global.dbConnected) {
        for (const r of records) memoryUserPerformance.push({ ...r, createdAt: new Date() });
        if (memoryUserPerformance.length > 1000) {
            memoryUserPerformance.splice(0, memoryUserPerformance.length - 1000);
        }
        return;
    }
    UserPerformance.insertMany(records).catch(e => console.warn("[userPerf]", e.message));
}

// ─── Admin auth ───────────────────────────────────────────────────────────────

function adminAuth(req, res, next) {
    const key = process.env.ADMIN_API_KEY;
    if (!key) return res.status(503).json({ error:"Admin endpoint not configured (set ADMIN_API_KEY)." });
    const clientKey = req.headers["x-admin-key"] || req.query.key;
    if (clientKey !== key) return res.status(401).json({ error:"Unauthorized — invalid admin key." });
    next();
}

// ─── ElevenLabs TTS (built-in https) ─────────────────────────────────────────

function callElevenLabsTTS(script, voiceId, apiKey) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({ text: script, model_id:"eleven_monolingual_v1", voice_settings:{ stability:0.5, similarity_boost:0.75 } });
        const opts = { hostname:"api.elevenlabs.io", port:443, path:`/v1/text-to-speech/${voiceId}`, method:"POST",
            headers:{ "Accept":"audio/mpeg","Content-Type":"application/json","xi-api-key":apiKey,"Content-Length":Buffer.byteLength(payload) } };
        const req = https.request(opts, res => {
            if (res.statusCode !== 200) { let b=""; res.on("data",d=>b+=d); res.on("end",()=>reject(new Error(`ElevenLabs ${res.statusCode}: ${b.slice(0,200)}`))); return; }
            const chunks = []; res.on("data",c=>chunks.push(c)); res.on("end",()=>resolve(Buffer.concat(chunks)));
        });
        req.on("error", reject); req.write(payload); req.end();
    });
}

// ─── Export HTML builder ──────────────────────────────────────────────────────

function buildExportHtml(quiz, includeKey) {
    const esc = s => String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const letters = ["A","B","C","D"];
    const questions = quiz.questions.map((q,i) => {
        const choices = (q.choicesPool||[]).map((c,ci) =>
            `<li><span class="letter">${letters[ci]||ci+1}.</span> ${esc(c)}</li>`).join("");
        return `<div class="question"><p class="qnum">Q${i+1}. <span class="qtext">${esc(q.questionPrompt)}</span>
            <span class="badge">${esc(q.type||"mc")} · ${esc(q.difficulty||"medium")}</span></p>
            ${q.type==="short-answer"||q.type==="explain" ? `<div class="answer-line"></div>` : `<ul class="choices">${choices}</ul>`}
        </div>`;
    }).join("\n");
    const answerKey = includeKey ? `<div class="page-break"></div><h2>Answer Key — ${esc(quiz.quizCode)}</h2>
        <table><thead><tr><th>#</th><th>Answer</th><th>Explanation</th><th>Difficulty</th></tr></thead>
        <tbody>${quiz.questions.map((q,i) => `<tr><td>${i+1}</td><td>${esc(q.correctAnswer)}</td><td>${esc(q.explanation)}</td><td>${esc(q.difficulty||"medium")}</td></tr>`).join("")}</tbody></table>` : "";
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><title>Quiz ${esc(quiz.quizCode)}</title>
<style>body{font-family:Georgia,serif;max-width:800px;margin:40px auto;color:#222}h1{border-bottom:2px solid #333;padding-bottom:8px}
.question{margin:1.5rem 0}.qnum{font-weight:bold;margin-bottom:.4rem}.qtext{font-weight:normal}
.badge{font-size:0.75rem;color:#666;margin-left:8px;font-family:monospace}ul.choices{list-style:none;padding-left:1rem}ul.choices li{margin:.25rem 0}
.letter{font-weight:bold;display:inline-block;width:1.5rem}.answer-line{border-bottom:1px solid #999;margin:1rem 0;height:1.8rem}
table{width:100%;border-collapse:collapse;margin-top:1rem}th,td{border:1px solid #ccc;padding:6px 12px;text-align:left}th{background:#f0f0f0}
.page-break{page-break-before:always}@media print{.page-break{break-before:page}}</style></head><body>
<h1>Quiz: ${esc(quiz.quizCode)}</h1><p>${quiz.questions.length} questions</p>${questions}${answerKey}</body></html>`;
}

// ═════════════════════════════════════════════════════════════════════════════
//  ROUTES
// ═════════════════════════════════════════════════════════════════════════════

app.get("/", (_req, res) => res.json({ status:"QuizGen Backend Running", version:"4.0.0",
    maxQuestionCount: MAX_QUESTION_COUNT, bgJobThreshold: BG_JOB_THRESHOLD }));

// ─── POST /upload ─────────────────────────────────────────────────────────────

// ─── Source Document Storage and helpers ──────────────────────────────────────
const memorySourceDocuments = [];

async function extractImagesFromDocx(buffer) {
    const images = [];
    try {
        const zip = await JSZip.loadAsync(buffer);
        const files = Object.keys(zip.files);
        for (const file of files) {
            if (file.startsWith("word/media/")) {
                const filename = file.replace("word/media/", "");
                const data = await zip.files[file].async("base64");
                images.push({ filename, data });
            }
        }
    } catch (e) {
        console.warn("[upload] Image extraction failed:", e.message);
    }
    return images;
}

async function getDocument(id) {
    if (global.dbConnected) {
        return await SourceDocument.findOne({ documentId: id });
    }
    return memorySourceDocuments.find(d => d.documentId === id);
}

// ─── POST /upload ─────────────────────────────────────────────────────────────
// Supports ?verify=true for sanity fact verification checks
// Extracts diagrams from word (.docx) files using JSZip in-memory

app.post("/upload", uploadLimit, uploadMiddleware, async (req, res) => {
    try {
        const allFiles = [...(req.files?.document||[]), ...(req.files?.documents||[])];
        if (allFiles.length === 0) return res.status(400).json({ error:"No file uploaded." });

        const verify = req.query.verify === "true";
        const results = [];

        for (const file of allFiles) {
            const { text, error } = await extractText(file);
            if (error) return res.status(400).json({ error });
            const mod = moderateText(text);
            if (!mod.ok) return res.status(400).json({ error: mod.reason });

            let images = [];
            if (file.originalname.toLowerCase().endsWith(".docx")) {
                images = await extractImagesFromDocx(file.buffer);
            }

            let flaggedContent = [];
            if (verify && aiAvailable()) {
                flaggedContent = await verifySourceFacts(text);
            }

            const docId = `doc_${uuidv4().substring(0,8).toUpperCase()}`;
            const playerName = req.query.player || "Guest";
            const ext = file.originalname.split(".").pop().toLowerCase();
            const docData = {
                documentId: docId,
                filename: file.originalname,
                text,
                images,
                flaggedContent,
                playerName,
                title: file.originalname,
                sourceType: ext,
                tags: [],
                createdAt: new Date()
            };

            if (global.dbConnected) {
                const doc = new SourceDocument(docData);
                await doc.save();
            } else {
                memorySourceDocuments.push(docData);
            }

            results.push({
                documentId: docId,
                filename: file.originalname,
                text: text.slice(0, 1000), // return text snippet
                imagesCount: images.length,
                flaggedContent
            });
        }

        if (results.length === 1) return res.json({ message: "Document uploaded successfully", ...results[0] });
        res.json({ message: "Documents uploaded successfully", documents: results });
    } catch (err) {
        if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error:`File too large. Max ${MAX_UPLOAD_BYTES/(1024*1024)}MB.` });
        res.status(500).json({ error:err.message });
    }
});

// ─── GET /upload/:id/flagged-content ──────────────────────────────────────────

app.get("/upload/:id/flagged-content", async (req, res) => {
    try {
        const doc = await getDocument(req.params.id);
        if (!doc) return res.status(404).json({ error: "Document not found." });
        res.json({
            documentId: doc.documentId,
            filename: doc.filename,
            flaggedContent: doc.flaggedContent || []
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Client in-flight deduplication map ──────────────────────────────────────
const pendingGenerations = new Map();  // ip:textHash -> Promise<questions[]>
const crypto = require("crypto");

// ─── POST /generate-quiz ──────────────────────────────────────────────────────
// Three response modes:
//   1. SSE streaming  — Accept: text/event-stream + useAI + AI key available
//   2. Background job — count > BG_JOB_THRESHOLD → returns { jobId } immediately
//   3. Synchronous    — standard JSON (existing behaviour)

app.post("/generate-quiz", generateLimit, async (req, res) => {
    try {
        let { text, count, useAI, questionType="multiple-choice", difficulty, documentId, language, noteId } = req.body;
        if (useAI === undefined) useAI = true;

        let docImages = [];
        let docExclusions = [];

        // ── Retrieve note if noteId provided ──────────────────────────────────
        if (noteId) {
            let noteContent = "";
            if (!global.dbConnected) {
                const note = memoryNotes.find(n => n.noteId === noteId);
                if (note) noteContent = note.content;
            } else {
                const note = await Note.findOne({ noteId });
                if (note) noteContent = note.content;
            }
            if (!noteContent) return res.status(404).json({ error: "Note not found or empty." });
            text = noteContent;
        }

        // ── Retrieve document if documentId provided ──────────────────────────
        if (documentId) {
            const doc = await getDocument(documentId);
            if (!doc) return res.status(404).json({ error: "Document not found." });
            text = doc.text;
            docImages = doc.images || [];
            docExclusions = doc.flaggedContent || [];
        }

        if (!text || typeof text !== "string") return res.status(400).json({ error:"No document text received." });
        
        // Append factual sanity-check warnings if present
        if (docExclusions.length > 0) {
            text += "\n\nEXCLUSIONS: Do NOT create quiz questions based on the following factually incorrect statements:\n" +
                docExclusions.map(e => `- "${e.statement}" (${e.issue})`).join("\n");
        }

        if (text.length > MAX_QUIZ_TEXT_CHARS)  return res.status(400).json({ error:`Text too long. Max ${MAX_QUIZ_TEXT_CHARS} chars.` });

        const validTypes = getSupportedQuestionTypes();
        if (!validTypes.includes(questionType)) return res.status(400).json({ error:`Invalid questionType. Must be: ${validTypes.join(", ")}` });
        if (difficulty && !["easy","medium","hard"].includes(difficulty)) return res.status(400).json({ error:"Invalid difficulty." });

        const targetLanguage = typeof language === "string" && language.trim() ? language.trim() : "English";

        const mod = moderateText(text);
        if (!mod.ok) return res.status(400).json({ error: mod.reason });

        const requestedCount = Math.floor(Number(count)) || 5;
        if (requestedCount > MAX_QUESTION_COUNT) {
            return res.status(400).json({
                error:      `Requested ${requestedCount} questions exceeds the maximum allowed (${MAX_QUESTION_COUNT}).`,
                maxAllowed: MAX_QUESTION_COUNT
            });
        }
        const safeCount = Math.max(1, requestedCount);

        // ── Cache check (skip for Vision multimodals) ──────────────────────────
        if (useAI && aiAvailable() && docImages.length === 0) {
            const cachedQuestions = await checkCache(text, safeCount, questionType, difficulty||null, targetLanguage);
            if (cachedQuestions) {
                return res.json({ questions: cachedQuestions, source: "cache", questionType, language: targetLanguage });
            }
        }

        // ── Mode 1: SSE streaming (skip for Vision multimodals) ─────────────────
        const wantsSSE = req.headers.accept?.includes("text/event-stream");
        if (wantsSSE && useAI && aiAvailable() && docImages.length === 0) {
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
            res.setHeader("X-Accel-Buffering", "no");
            res.flushHeaders();

            try {
                for await (const question of streamQuizWithAI(text, safeCount, questionType, difficulty||null, targetLanguage)) {
                    res.write(`data: ${JSON.stringify({ question })}\n\n`);
                }
            } catch (streamErr) {
                res.write(`data: ${JSON.stringify({ error:streamErr.message })}\n\n`);
            }
            res.write("data: [DONE]\n\n");
            return res.end();
        }

        // ── Mode 2: Background job for large counts ───────────────────────────
        if (useAI && aiAvailable() && safeCount > BG_JOB_THRESHOLD) {
            const jobId = createJob();
            (async () => {
                try {
                    const questions = docImages.length > 0
                        ? await generateQuizWithImages(text, docImages, safeCount, questionType, targetLanguage)
                        : await generateQuizWithAI(text, safeCount, questionType, difficulty||null, targetLanguage);
                    finishJob(jobId, questions);
                } catch (err) {
                    failJob(jobId, err);
                }
            })();
            return res.status(202).json({ jobId, status:"pending", message:`Generating ${safeCount} questions in the background. Poll GET /generate-quiz/status/${jobId}` });
        }

        // ── Mode 3: Synchronous ───────────────────────────────────────────────
        if (useAI && aiAvailable()) {
            const ip = req.ip || (req.connection && req.connection.remoteAddress) || "unknown";
            const textHash = crypto.createHash("sha256").update(text).digest("hex");
            const dedupKey = `${ip}:${textHash}:${targetLanguage}`; // dedup key includes targetLanguage to avoid collision

            let questionsPromise;
            if (pendingGenerations.has(dedupKey)) {
                console.log(`[dedup] In-flight duplicate detected for client ${ip}. Reusing promise.`);
                questionsPromise = pendingGenerations.get(dedupKey);
            } else {
                questionsPromise = docImages.length > 0
                    ? generateQuizWithImages(text, docImages, safeCount, questionType, targetLanguage)
                    : generateQuizWithAI(text, safeCount, questionType, difficulty||null, targetLanguage);
                pendingGenerations.set(dedupKey, questionsPromise);
            }

            try {
                const questions = await questionsPromise;
                const fromCache = questions._fromCache;
                return res.json({ questions, source: fromCache ? "cache" : "ai", questionType, language: targetLanguage });
            } catch (aiErr) {
                console.error("AI fallback:", aiErr.message);
                const questions = generateQuiz(text, safeCount);
                return res.json({ questions, source:"local-fallback", aiError:aiErr.message, questionType:"multiple-choice", language: targetLanguage });
            } finally {
                pendingGenerations.delete(dedupKey);
            }
        }

        let questions = generateQuiz(text, safeCount);
        if (difficulty) questions = questions.filter(q => q.difficulty === difficulty);
        res.json({ questions, source:"local", questionType:"multiple-choice" });

    } catch (err) { res.status(500).json({ error:err.message }); }
});

// ─── GET /generate-quiz/status/:jobId ────────────────────────────────────────

app.get("/generate-quiz/status/:jobId", (req, res) => {
    const job = jobMap.get(req.params.jobId);
    if (!job) return res.status(404).json({ error:"Job not found or expired." });
    if (job.status === "pending") return res.json({ status:"pending" });
    if (job.status === "error")   return res.status(500).json({ status:"error", error:job.error });
    res.json({ status:"done", questions:job.questions, count:job.questions.length });
});

// ─── POST /generate-lie-round ─────────────────────────────────────────────────

app.post("/generate-lie-round", generateLimit, async (req, res) => {
    try {
        if (!aiAvailable()) return res.status(503).json({ error:"AI not configured (set ANTHROPIC_API_KEY)." });
        const { text, count=3 } = req.body;
        if (!text || typeof text !== "string") return res.status(400).json({ error:"text is required." });
        const mod = moderateText(text);
        if (!mod.ok) return res.status(400).json({ error:mod.reason });
        const rounds = await generateTwoTruthsRound(text, count);
        res.json({ rounds, count:rounds.length });
    } catch (err) { res.status(500).json({ error:err.message }); }
});

// ─── POST /grade-explanation ──────────────────────────────────────────────────

app.post("/grade-explanation", generateLimit, async (req, res) => {
    try {
        if (!aiAvailable()) return res.status(503).json({ error:"AI not configured (set ANTHROPIC_API_KEY)." });
        const { question, correctAnswer, playerExplanation } = req.body;
        if (!question || !correctAnswer || !playerExplanation) {
            return res.status(400).json({ error:"question, correctAnswer, and playerExplanation are required." });
        }
        res.json(await gradeExplanation({ question, correctAnswer, playerExplanation }));
    } catch (err) { res.status(500).json({ error:err.message }); }
});

// ─── POST /create-quiz ────────────────────────────────────────────────────────

app.post("/create-quiz", createLimit, async (req, res) => {
    try {
        const { questions, sources=[], language="English", summaryOverview="", summaryPoints=[], summaryDefinitions=[] } = req.body;
        if (!Array.isArray(questions) || questions.length === 0) return res.status(400).json({ error:"questions must be a non-empty array." });

        // Basic structural validation of questions
        for (const q of questions) {
            if (!q || typeof q !== "object" || !q.questionPrompt || !q.correctAnswer) {
                return res.status(400).json({ error: "Invalid question structure. Each question must contain questionPrompt and correctAnswer." });
            }
        }

        const code = uuidv4().substring(0,6).toUpperCase();
        if (!global.dbConnected) {
            memoryQuizzes.push({ quizCode:code, questions, sources, language, summaryOverview, summaryPoints, summaryDefinitions, createdAt:new Date() });
            if (memoryQuizzes.length > 200) memoryQuizzes.shift();
            logEvent("quiz_created", { quizCode:code, questionCount:questions.length });
            return res.json({ quizCode:code });
        }
        const quiz = new Quiz({ quizCode:code, questions, sources, language, summaryOverview, summaryPoints, summaryDefinitions });
        await quiz.save();
        logEvent("quiz_created", { quizCode:code, questionCount:questions.length });
        res.json({ quizCode:code });
    } catch (err) { res.status(500).json({ error:err.message }); }
});

// ─── GET /quiz/:code ──────────────────────────────────────────────────────────

app.get("/quiz/:code", async (req, res) => {
    try {
        const code = req.params.code.toUpperCase();
        if (!global.dbConnected) {
            const quiz = memoryQuizzes.find(q => q.quizCode === code);
            return quiz ? res.json(quiz) : res.status(404).json({ error:"Quiz not found." });
        }
        const quiz = await Quiz.findOne({ quizCode:code });
        quiz ? res.json(quiz) : res.status(404).json({ error:"Quiz not found." });
    } catch (err) { res.status(500).json({ error:err.message }); }
});

// ─── GET /quiz/:code/question/:index ─────────────────────────────────────────

app.get("/quiz/:code/question/:index", async (req, res) => {
    try {
        const code  = req.params.code.toUpperCase();
        const index = parseInt(req.params.index, 10);
        if (isNaN(index) || index < 0) return res.status(400).json({ error:"Invalid question index." });
        const quiz = global.dbConnected
            ? await Quiz.findOne({ quizCode:code })
            : memoryQuizzes.find(q => q.quizCode === code);
        if (!quiz) return res.status(404).json({ error:"Quiz not found." });
        const question = quiz.questions[index];
        if (!question) return res.status(404).json({ error:`Question ${index} not found.` });
        res.json({ index, quizCode:code, question });
    } catch (err) { res.status(500).json({ error:err.message }); }
});

// ─── DELETE /quiz/:code ───────────────────────────────────────────────────────

app.delete("/quiz/:code", async (req, res) => {
    try {
        const code = req.params.code.toUpperCase();
        if (!global.dbConnected) {
            const idx = memoryQuizzes.findIndex(q => q.quizCode === code);
            if (idx !== -1) memoryQuizzes.splice(idx, 1);
            for (let i = memoryResults.length-1; i >= 0; i--) { if (memoryResults[i].quizCode === code) memoryResults.splice(i,1); }
        } else {
            await Quiz.deleteOne({ quizCode:code });
            await Result.deleteMany({ quizCode:code });
        }
        lbCacheInvalidate(code);
        res.json({ message:"Quiz deleted." });
    } catch (err) { res.status(500).json({ error:err.message }); }
});

// ─── POST /save-result ────────────────────────────────────────────────────────

app.post("/save-result", async (req, res) => {
    try {
        const { quizCode, playerName, score, totalQuestions, answers=[], email="" } = req.body;
        if (!quizCode || !playerName || typeof score !== "number" || typeof totalQuestions !== "number") {
            return res.status(400).json({ error:"quizCode, playerName, score, and totalQuestions are required." });
        }
        if (!Array.isArray(answers)) {
            return res.status(400).json({ error:"answers must be an array." });
        }
        if (score < 0 || totalQuestions < 0 || !Number.isInteger(score) || !Number.isInteger(totalQuestions)) {
            return res.status(400).json({ error:"score and totalQuestions must be non-negative integers." });
        }

        const { confidenceScore, calibrationScore } = computeConfidenceScores(answers);

        if (!global.dbConnected) {
            memoryResults.push({ quizCode, playerName, score, totalQuestions, answers, confidenceScore, calibrationScore, email, spacedRepetitionSent: { "1d": false, "3d": false, "7d": false }, createdAt:new Date() });
            if (memoryResults.length > 500) memoryResults.shift();
        } else {
            const result = new Result({ quizCode, playerName, score, totalQuestions, answers, confidenceScore, calibrationScore, email });
            await result.save();
        }

        logEvent("result_saved", { quizCode, score, totalQuestions });
        logUserPerformance(answers.map((a,i) => ({
            playerName, quizCode,
            questionIndex:  a.questionIndex ?? i,
            questionPrompt: a.questionPrompt || "",
            correctAnswer:  a.correctAnswer  || "",
            playerAnswer:   a.playerAnswer   || "",
            correct:        Boolean(a.correct),
            confidence:     a.confidence || "medium",
            difficulty:     a.difficulty || "medium",
            hintsUsed:      Number(a.hintsUsed) || 0
        })));

        // Invalidate cached leaderboard for this quiz (score has changed)
        lbCacheInvalidate(quizCode);

        res.json({ message:"Result saved.", confidenceScore, calibrationScore });
    } catch (err) { res.status(500).json({ error:err.message }); }
});

// ─── GET /leaderboard/:code ───────────────────────────────────────────────────

app.get("/leaderboard/:code", async (req, res) => {
    try {
        const code = req.params.code;

        // Try the cache first
        const cached = lbCacheGet(code);
        if (cached) return res.json(cached);

        let data;
        if (code === "GLOBAL") {
            data = global.dbConnected
                ? await Result.find().sort({ score:-1 }).limit(100)
                : [...memoryResults].sort((a,b) => b.score-a.score).slice(0,100);
        } else {
            data = global.dbConnected
                ? await Result.find({ quizCode:code }).sort({ score:-1 })
                : memoryResults.filter(r => r.quizCode===code).sort((a,b) => b.score-a.score);
        }

        lbCacheSet(code, data);
        res.json(data);
    } catch (err) { res.status(500).json({ error:err.message }); }
});

// ─── GET /quiz-history ────────────────────────────────────────────────────────

app.get("/quiz-history", async (req, res) => {
    try {
        const lang = req.query.lang;
        if (!global.dbConnected) {
            let list = [...memoryQuizzes];
            if (lang) {
                list = list.filter(q => q.language && q.language.toLowerCase() === lang.toLowerCase());
            }
            return res.json(list.sort((a,b) => b.createdAt-a.createdAt));
        }
        const filter = lang ? { language: { $regex: new RegExp(`^${lang}$`, "i") } } : {};
        res.json(await Quiz.find(filter).sort({ createdAt:-1 }));
    } catch (err) { res.status(500).json({ error:err.message }); }
});

// ─── GET /user/:name/weak-spots ───────────────────────────────────────────────

app.get("/user/:name/weak-spots", async (req, res) => {
    try {
        if (!aiAvailable()) return res.status(503).json({ error:"AI not configured (set ANTHROPIC_API_KEY)." });
        const playerName = decodeURIComponent(req.params.name);
        let records = global.dbConnected
            ? await UserPerformance.find({ playerName }).sort({ createdAt:-1 }).limit(500)
            : memoryUserPerformance.filter(r => r.playerName === playerName);

        if (records.length === 0) return res.json({ playerName, totalAttempts:0, weakSpots:[], message:"No performance history found." });

        const wrongOnes = records.filter(r => !r.correct);
        const summary   = wrongOnes.slice(0,40).map((r,i) =>
            `${i+1}. Q: "${r.questionPrompt}" | Correct: "${r.correctAnswer}" | Player: "${r.playerAnswer}" | ${r.difficulty}`
        ).join("\n");

        const Anthropic = require("@anthropic-ai/sdk");
        const anthClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const response = await anthClient.messages.create({
            model:"claude-sonnet-4-5", max_tokens:1024,
            system:`You are an educational coach analyzing quiz performance to identify knowledge gaps.
Given wrong answers, identify 3–5 specific recurring knowledge gaps.
Respond with ONLY a JSON array: [{ "topic": "short name", "description": "one sentence gap", "questionCount": N }]
Group related mistakes. Be specific, not generic.`,
            messages:[{ role:"user", content:`Player: ${playerName}\nWrong answers (${wrongOnes.length} total):\n${summary}` }]
        });
        const textBlock = response.content.find(b => b.type === "text");
        let weakSpots = [];
        try { weakSpots = JSON.parse(textBlock.text.trim().replace(/^```json\s*/i,"").replace(/```\s*$/,"")); } catch {}
        res.json({ playerName, totalAttempts:records.length, totalWrong:wrongOnes.length, weakSpots });
    } catch (err) { res.status(500).json({ error:err.message }); }
});

// ─── GDPR Compliance Endpoints ────────────────────────────────────────────────

app.get("/user/:name/data-export", async (req, res) => {
    try {
        const playerName = decodeURIComponent(req.params.name);
        
        let results = [];
        let performance = [];

        if (!global.dbConnected) {
            results = memoryResults.filter(r => r.playerName.toLowerCase() === playerName.toLowerCase());
            performance = memoryUserPerformance.filter(p => p.playerName.toLowerCase() === playerName.toLowerCase());
        } else {
            results = await Result.find({ playerName: { $regex: new RegExp(`^${playerName}$`, "i") } });
            performance = await UserPerformance.find({ playerName: { $regex: new RegExp(`^${playerName}$`, "i") } });
        }

        res.setHeader("Content-Type", "application/json");
        res.setHeader("Content-Disposition", `attachment; filename="data-export-${encodeURIComponent(playerName)}.json"`);
        res.json({
            exportDate: new Date(),
            playerName,
            results,
            performanceHistory: performance
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete("/user/:name/data", async (req, res) => {
    try {
        const playerName = decodeURIComponent(req.params.name);

        if (!global.dbConnected) {
            const resultsToDel = memoryResults.filter(r => r.playerName.toLowerCase() === playerName.toLowerCase());
            resultsToDel.forEach(item => {
                const idx = memoryResults.indexOf(item);
                if (idx !== -1) memoryResults.splice(idx, 1);
            });
            
            const perfToDel = memoryUserPerformance.filter(p => p.playerName.toLowerCase() === playerName.toLowerCase());
            perfToDel.forEach(item => {
                const idx = memoryUserPerformance.indexOf(item);
                if (idx !== -1) memoryUserPerformance.splice(idx, 1);
            });
            
            res.json({
                message: "User data deleted successfully from memory.",
                resultsDeleted: resultsToDel.length,
                performanceRecordsDeleted: perfToDel.length
            });
        } else {
            const resultsDel = await Result.deleteMany({ playerName: { $regex: new RegExp(`^${playerName}$`, "i") } });
            const perfDel = await UserPerformance.deleteMany({ playerName: { $regex: new RegExp(`^${playerName}$`, "i") } });
            
            res.json({
                message: "User data deleted successfully from database.",
                resultsDeleted: resultsDel.deletedCount,
                performanceRecordsDeleted: perfDel.deletedCount
            });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Notes API ─────────────────────────────────────────────────────────────────

app.post("/notes", async (req, res) => {
    try {
        const { noteId, title, content, playerName } = req.body;
        if (!title || !playerName) {
            return res.status(400).json({ error: "title and playerName are required." });
        }

        const id = noteId || uuidv4();
        const noteData = {
            noteId: id,
            title,
            content: content || "",
            playerName,
            updatedAt: new Date()
        };

        if (!global.dbConnected) {
            const index = memoryNotes.findIndex(n => n.noteId === id);
            if (index !== -1) {
                memoryNotes[index] = { ...memoryNotes[index], ...noteData };
            } else {
                memoryNotes.push({ ...noteData, createdAt: new Date() });
            }
            res.json({ message: "Note saved in memory.", noteId: id });
        } else {
            await Note.findOneAndUpdate(
                { noteId: id },
                { $set: noteData, $setOnInsert: { createdAt: new Date() } },
                { upsert: true, new: true }
            );
            res.json({ message: "Note saved to database.", noteId: id });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/notes", async (req, res) => {
    try {
        const { player } = req.query;
        if (!player) return res.status(400).json({ error: "player name query parameter is required." });

        if (!global.dbConnected) {
            const notes = memoryNotes.filter(n => n.playerName.toLowerCase() === player.toLowerCase());
            return res.json(notes);
        }

        const notes = await Note.find({ playerName: { $regex: new RegExp(`^${player}$`, "i") } }).sort({ updatedAt: -1 });
        res.json(notes);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete("/notes/:id", async (req, res) => {
    try {
        const id = req.params.id;

        if (!global.dbConnected) {
            const idx = memoryNotes.findIndex(n => n.noteId === id);
            if (idx !== -1) {
                memoryNotes.splice(idx, 1);
                return res.json({ message: "Note deleted from memory." });
            }
            return res.status(404).json({ error: "Note not found." });
        }

        const result = await Note.deleteOne({ noteId: id });
        if (result.deletedCount === 0) return res.status(404).json({ error: "Note not found." });
        res.json({ message: "Note deleted." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Summarizer API ────────────────────────────────────────────────────────────

async function summarizeTextWithAI(text, language = "English") {
    if (!aiAvailable()) {
        return {
            summaryOverview: `This is a fallback summary overview for the uploaded content. Language is set to ${language}.`,
            summaryPoints: [
                "Key concept 1: Initial core overview of the provided text.",
                "Key concept 2: Primary facts and details extracted from the reading.",
                "Key concept 3: Additional structural context regarding the topics discussed."
            ],
            summaryDefinitions: [
                { term: "Core Concept", definition: "A foundational idea discussed in the document." },
                { term: "Terminology", definition: "Specialized terms used in this study reading." }
            ]
        };
    }

    try {
        const system = `You are a study assistant. Analyze the provided study text and generate a structured educational summary.
Write the response in the target language: "${language}".

You MUST respond with ONLY a JSON object containing:
{
  "summaryOverview": "A single-paragraph high-level overview of the main topic.",
  "summaryPoints": [
     "A list of key bullet points summarizing major facts or takeaways."
  ],
  "summaryDefinitions": [
     { "term": "Definition Name", "definition": "A clear, concise definition of a key term." }
  ]
}`;

        const Anthropic = require("@anthropic-ai/sdk");
        const anthClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const response = await anthClient.messages.create({
            model: "claude-sonnet-4-5",
            max_tokens: 1024,
            system,
            messages: [{ role: "user", content: `Text to summarize:\n\n${text.slice(0, 30000)}` }]
        });

        const textBlock = response.content.find(b => b.type === "text");
        const parsed = JSON.parse(textBlock.text.trim().replace(/^```json\s*/i, "").replace(/```\s*$/, ""));
        return {
            summaryOverview: parsed.summaryOverview || "",
            summaryPoints: parsed.summaryPoints || [],
            summaryDefinitions: parsed.summaryDefinitions || []
        };
    } catch (e) {
        console.warn("Claude summarization failed, falling back:", e.message);
        return {
            summaryOverview: `Summary fallback due to error: ${e.message}`,
            summaryPoints: ["Could not extract detailed bullet points."],
            summaryDefinitions: []
        };
    }
}

app.post("/summarize", async (req, res) => {
    try {
        let { text, documentId, noteId, language = "English" } = req.body;

        // Retrieve note if noteId provided
        if (noteId) {
            let noteContent = "";
            if (!global.dbConnected) {
                const note = memoryNotes.find(n => n.noteId === noteId);
                if (note) noteContent = note.content;
            } else {
                const note = await Note.findOne({ noteId });
                if (note) noteContent = note.content;
            }
            if (noteContent) text = noteContent;
        }

        // Retrieve document if documentId provided
        if (documentId) {
            const doc = await getDocument(documentId);
            if (doc) text = doc.text;
        }

        if (!text) return res.status(400).json({ error: "Source text, noteId, or documentId is required." });

        const summary = await summarizeTextWithAI(text, language);
        res.json(summary);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Reference Library API ─────────────────────────────────────────────────────

app.get("/library", async (req, res) => {
    try {
        const { player } = req.query;
        if (!player) return res.status(400).json({ error: "player query parameter is required." });

        let docs = [];
        if (!global.dbConnected) {
            docs = memorySourceDocuments.filter(d => (d.playerName || "Guest").toLowerCase() === player.toLowerCase());
        } else {
            docs = await SourceDocument.find({ playerName: { $regex: new RegExp(`^${player}$`, "i") } }).sort({ createdAt: -1 });
        }

        const metaDocs = docs.map(d => ({
            documentId: d.documentId,
            filename: d.filename,
            title: d.title || d.filename,
            sourceType: d.sourceType || "txt",
            tags: d.tags || [],
            imagesCount: d.images ? d.images.length : 0,
            flaggedCount: d.flaggedContent ? d.flaggedContent.length : 0,
            textLength: d.text ? d.text.length : 0,
            createdAt: d.createdAt
        }));

        res.json(metaDocs);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put("/library/:id/tags", async (req, res) => {
    try {
        const id = req.params.id;
        const { tags } = req.body;
        if (!Array.isArray(tags)) return res.status(400).json({ error: "tags must be an array of strings." });

        if (!global.dbConnected) {
            const doc = memorySourceDocuments.find(d => d.documentId === id);
            if (!doc) return res.status(404).json({ error: "Document not found." });
            doc.tags = tags;
            return res.json({ message: "Tags updated successfully.", tags });
        }

        const result = await SourceDocument.updateOne({ documentId: id }, { $set: { tags } });
        if (result.matchedCount === 0) return res.status(404).json({ error: "Document not found." });
        res.json({ message: "Tags updated successfully.", tags });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete("/library/:id", async (req, res) => {
    try {
        const id = req.params.id;

        if (!global.dbConnected) {
            const idx = memorySourceDocuments.findIndex(d => d.documentId === id);
            if (idx === -1) return res.status(404).json({ error: "Document not found." });
            memorySourceDocuments.splice(idx, 1);
            return res.json({ message: "Document deleted from library." });
        }

        const result = await SourceDocument.deleteOne({ documentId: id });
        if (result.deletedCount === 0) return res.status(404).json({ error: "Document not found." });
        res.json({ message: "Document deleted from library." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Flashcards API ────────────────────────────────────────────────────────────

app.post("/generate-flashcards", async (req, res) => {
    try {
        let { text, count = 5, quizCode, playerName, language = "English", documentId, noteId } = req.body;
        if (!playerName) return res.status(400).json({ error: "playerName is required." });

        // Retrieve note if noteId provided
        if (noteId) {
            let noteContent = "";
            if (!global.dbConnected) {
                const note = memoryNotes.find(n => n.noteId === noteId);
                if (note) noteContent = note.content;
            } else {
                const note = await Note.findOne({ noteId });
                if (note) noteContent = note.content;
            }
            if (noteContent) text = noteContent;
        }

        // Retrieve document if documentId provided
        if (documentId) {
            const doc = await getDocument(documentId);
            if (doc) text = doc.text;
        }

        if (!text) return res.status(400).json({ error: "Source text, noteId, or documentId is required." });

        if (!aiAvailable()) {
            const mockCards = [
                { front: `Front Card 1 about: ${text.slice(0, 30)}...`, back: "This is a fallback response description." },
                { front: `Front Card 2 about: ${text.slice(0, 30)}...`, back: "This is another description." }
            ];
            const result = [];
            for (const c of mockCards.slice(0, count)) {
                const card = {
                    cardId: uuidv4(),
                    quizCode: quizCode || "",
                    playerName,
                    front: c.front,
                    back: c.back,
                    interval: 0,
                    easeFactor: 2.5,
                    repetitions: 0,
                    nextReviewDate: new Date()
                };
                if (!global.dbConnected) {
                    memoryFlashcards.push(card);
                } else {
                    await Flashcard.create(card);
                }
                result.push(card);
            }
            return res.json({ message: "Flashcards generated (offline fallback).", flashcards: result });
        }

        const cards = await generateFlashcardsWithAI(text, count, language);
        const result = [];
        for (const c of cards) {
            const card = {
                cardId: uuidv4(),
                quizCode: quizCode || "",
                playerName,
                front: c.front,
                back: c.back,
                interval: 0,
                easeFactor: 2.5,
                repetitions: 0,
                nextReviewDate: new Date()
            };
            if (!global.dbConnected) {
                memoryFlashcards.push(card);
            } else {
                await Flashcard.create(card);
            }
            result.push(card);
        }
        res.json({ message: "Flashcards generated successfully.", flashcards: result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/flashcards", async (req, res) => {
    try {
        const { player } = req.query;
        if (!player) return res.status(400).json({ error: "player query parameter is required." });

        let allCards = [];
        if (!global.dbConnected) {
            allCards = memoryFlashcards.filter(c => c.playerName.toLowerCase() === player.toLowerCase());
        } else {
            allCards = await Flashcard.find({ playerName: { $regex: new RegExp(`^${player}$`, "i") } });
        }

        const now = new Date();
        const dueCards = allCards.filter(c => new Date(c.nextReviewDate) <= now);

        res.json({
            totalCards: allCards.length,
            dueCardsCount: dueCards.length,
            dueCards
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/flashcards/:id/review", async (req, res) => {
    try {
        const id = req.params.id;
        const { quality } = req.body; // 0-5 rating
        if (quality === undefined || quality < 0 || quality > 5) {
            return res.status(400).json({ error: "Quality score must be between 0 and 5." });
        }

        let card = null;
        if (!global.dbConnected) {
            card = memoryFlashcards.find(c => c.cardId === id);
        } else {
            card = await Flashcard.findOne({ cardId: id });
        }

        if (!card) return res.status(404).json({ error: "Flashcard not found." });

        const q = Number(quality);
        let { interval, easeFactor, repetitions } = card;

        if (q >= 3) {
            if (repetitions === 0) {
                interval = 1;
            } else if (repetitions === 1) {
                interval = 6;
            } else {
                interval = Math.round(interval * easeFactor);
            }
            repetitions++;
        } else {
            repetitions = 0;
            interval = 1;
        }

        easeFactor = easeFactor + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
        if (easeFactor < 1.3) easeFactor = 1.3;

        const nextReview = new Date(Date.now() + interval * 24 * 60 * 60 * 1000);

        if (!global.dbConnected) {
            card.interval = interval;
            card.easeFactor = easeFactor;
            card.repetitions = repetitions;
            card.nextReviewDate = nextReview;
        } else {
            await Flashcard.updateOne(
                { cardId: id },
                { $set: { interval, easeFactor, repetitions, nextReviewDate: nextReview } }
            );
        }

        res.json({
            message: "Review updated successfully.",
            nextInterval: interval,
            easeFactor: Number(easeFactor.toFixed(2)),
            repetitions,
            nextReviewDate: nextReview
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Study Planner API ─────────────────────────────────────────────────────────

app.post("/study-plans", async (req, res) => {
    try {
        const { playerName, examName, examDate, documentIds } = req.body;
        if (!playerName || !examName || !examDate || !Array.isArray(documentIds)) {
            return res.status(400).json({ error: "playerName, examName, examDate, and documentIds array are required." });
        }

        const targetDate = new Date(examDate);
        const today = new Date();
        today.setHours(0,0,0,0);
        
        const daysRemaining = Math.ceil((targetDate - today) / (1000 * 60 * 60 * 24));
        if (daysRemaining <= 0) {
            return res.status(400).json({ error: "Exam date must be in the future." });
        }

        const schedule = [];
        const intervals = [1, 3, 7, 14, 30];

        for (const docId of documentIds) {
            let currentOffset = 0;
            for (let step = 0; step < intervals.length; step++) {
                currentOffset += intervals[step];
                if (currentOffset >= daysRemaining) break;

                const schedDate = new Date(today);
                schedDate.setDate(today.getDate() + currentOffset);
                schedule.push({
                    date: schedDate,
                    documentId: docId,
                    completed: false
                });
            }

            if (daysRemaining > 1) {
                const finalDate = new Date(targetDate);
                finalDate.setDate(targetDate.getDate() - 1);
                if (!schedule.some(s => s.documentId === docId && s.date.toDateString() === finalDate.toDateString())) {
                    schedule.push({
                        date: finalDate,
                        documentId: docId,
                        completed: false
                    });
                }
            }
        }

        schedule.sort((a, b) => a.date - b.date);

        const planId = `plan_${uuidv4().substring(0,8).toUpperCase()}`;
        const planData = {
            planId,
            playerName,
            examName,
            examDate: targetDate,
            documentIds,
            schedule
        };

        if (!global.dbConnected) {
            memoryStudyPlans.push(planData);
        } else {
            await StudyPlan.create(planData);
        }

        res.json({ message: "Study plan created successfully.", planId, scheduleCount: schedule.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/study-plans", async (req, res) => {
    try {
        const { player } = req.query;
        if (!player) return res.status(400).json({ error: "player query parameter is required." });

        let plans = [];
        if (!global.dbConnected) {
            plans = memoryStudyPlans.filter(p => p.playerName.toLowerCase() === player.toLowerCase());
        } else {
            plans = await StudyPlan.find({ playerName: { $regex: new RegExp(`^${player}$`, "i") } });
        }

        const hydratedPlans = [];
        for (const plan of plans) {
            const list = [];
            for (const item of plan.schedule) {
                let docTitle = "Unknown Source";
                if (!global.dbConnected) {
                    const doc = memorySourceDocuments.find(d => d.documentId === item.documentId);
                    if (doc) docTitle = doc.title || doc.filename;
                } else {
                    const doc = await SourceDocument.findOne({ documentId: item.documentId });
                    if (doc) docTitle = doc.title || doc.filename;
                }
                list.push({
                    date: item.date,
                    documentId: item.documentId,
                    docTitle,
                    completed: item.completed
                });
            }
            hydratedPlans.push({
                planId: plan.planId,
                examName: plan.examName,
                examDate: plan.examDate,
                documentIds: plan.documentIds,
                schedule: list
            });
        }

        res.json(hydratedPlans);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/study-plans/:planId/complete-day", async (req, res) => {
    try {
        const { planId } = req.params;
        const { documentId, date } = req.body;
        if (!documentId || !date) return res.status(400).json({ error: "documentId and date are required in request body." });

        const matchDate = new Date(date).toDateString();

        if (!global.dbConnected) {
            const plan = memoryStudyPlans.find(p => p.planId === planId);
            if (!plan) return res.status(404).json({ error: "Study plan not found." });

            const schedItem = plan.schedule.find(s => s.documentId === documentId && new Date(s.date).toDateString() === matchDate);
            if (!schedItem) return res.status(404).json({ error: "Schedule item not found." });

            schedItem.completed = true;
            return res.json({ message: "Task marked as completed." });
        }

        const plan = await StudyPlan.findOne({ planId });
        if (!plan) return res.status(404).json({ error: "Study plan not found." });

        let updated = false;
        for (const item of plan.schedule) {
            if (item.documentId === documentId && new Date(item.date).toDateString() === matchDate) {
                item.completed = true;
                updated = true;
                break;
            }
        }

        if (!updated) return res.status(404).json({ error: "Schedule item not found." });

        await StudyPlan.updateOne({ planId }, { $set: { schedule: plan.schedule } });
        res.json({ message: "Task marked as completed." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Collaborative Study Groups API ───────────────────────────────────────────

app.post("/groups", async (req, res) => {
    try {
        const { name, ownerName } = req.body;
        if (!name || !ownerName) return res.status(400).json({ error: "Group name and ownerName are required." });

        const joinCode = uuidv4().substring(0, 6).toUpperCase();
        const groupId = `group_${uuidv4().substring(0, 8).toUpperCase()}`;

        const groupData = {
            groupId,
            name,
            joinCode,
            ownerName,
            members: [ownerName],
            sharedQuizzes: [],
            activityFeed: [{
                message: `${ownerName} created the study group "${name}".`,
                createdAt: new Date()
            }]
        };

        if (!global.dbConnected) {
            memoryStudyGroups.push(groupData);
        } else {
            await StudyGroup.create(groupData);
        }

        res.json({ message: "Study group created successfully.", groupId, joinCode });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/groups/join", async (req, res) => {
    try {
        const { playerName, joinCode } = req.body;
        if (!playerName || !joinCode) return res.status(400).json({ error: "playerName and joinCode are required." });

        const code = joinCode.toUpperCase().trim();

        if (!global.dbConnected) {
            const group = memoryStudyGroups.find(g => g.joinCode === code);
            if (!group) return res.status(404).json({ error: "Invalid join code." });

            if (group.members.includes(playerName)) {
                return res.json({ message: "You are already a member of this group.", groupId: group.groupId });
            }

            group.members.push(playerName);
            group.activityFeed.push({
                message: `${playerName} joined the group.`,
                createdAt: new Date()
            });

            return res.json({ message: "Joined group successfully.", groupId: group.groupId, name: group.name });
        }

        const group = await StudyGroup.findOne({ joinCode: code });
        if (!group) return res.status(404).json({ error: "Invalid join code." });

        if (group.members.includes(playerName)) {
            return res.json({ message: "You are already a member of this group.", groupId: group.groupId });
        }

        group.members.push(playerName);
        group.activityFeed.push({
            message: `${playerName} joined the group.`,
            createdAt: new Date()
        });

        await StudyGroup.updateOne(
            { joinCode: code },
            { $set: { members: group.members, activityFeed: group.activityFeed } }
        );

        res.json({ message: "Joined group successfully.", groupId: group.groupId, name: group.name });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/groups", async (req, res) => {
    try {
        const { player } = req.query;
        if (!player) return res.status(400).json({ error: "player query parameter is required." });

        let groups = [];
        if (!global.dbConnected) {
            groups = memoryStudyGroups.filter(g => g.members.includes(player));
        } else {
            groups = await StudyGroup.find({ members: player });
        }

        res.json(groups);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/groups/:groupId/share-quiz", async (req, res) => {
    try {
        const { groupId } = req.params;
        const { quizCode, playerName } = req.body;
        if (!quizCode || !playerName) return res.status(400).json({ error: "quizCode and playerName are required." });

        if (!global.dbConnected) {
            const group = memoryStudyGroups.find(g => g.groupId === groupId);
            if (!group) return res.status(404).json({ error: "Group not found." });

            if (!group.sharedQuizzes.includes(quizCode)) {
                group.sharedQuizzes.push(quizCode);
                group.activityFeed.push({
                    message: `${playerName} shared quiz #${quizCode} with the group.`,
                    createdAt: new Date()
                });
            }
            return res.json({ message: "Quiz shared in group successfully." });
        }

        const group = await StudyGroup.findOne({ groupId });
        if (!group) return res.status(404).json({ error: "Group not found." });

        if (!group.sharedQuizzes.includes(quizCode)) {
            group.sharedQuizzes.push(quizCode);
            group.activityFeed.push({
                message: `${playerName} shared quiz #${quizCode} with the group.`,
                createdAt: new Date()
            });

            await StudyGroup.updateOne(
                { groupId },
                { $set: { sharedQuizzes: group.sharedQuizzes, activityFeed: group.activityFeed } }
            );
        }

        res.json({ message: "Quiz shared in group successfully." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/groups/:groupId/leaderboard", async (req, res) => {
    try {
        const { groupId } = req.params;

        let group = null;
        if (!global.dbConnected) {
            group = memoryStudyGroups.find(g => g.groupId === groupId);
        } else {
            group = await StudyGroup.findOne({ groupId });
        }

        if (!group) return res.status(404).json({ error: "Group not found." });

        const membersList = group.members;
        let results = [];
        if (!global.dbConnected) {
            results = memoryResults.filter(r => membersList.includes(r.playerName));
        } else {
            results = await Result.find({ playerName: { $in: membersList } });
        }

        const leaderboard = [];
        for (const member of membersList) {
            const memberResults = results.filter(r => r.playerName === member);
            const attempts = memberResults.length;
            const avgScore = attempts ? memberResults.reduce((s, r) => s + (r.score / (r.totalQuestions || 1)), 0) / attempts : 0;
            leaderboard.push({
                playerName: member,
                attempts,
                averageScorePct: Math.round(avgScore * 100)
            });
        }

        leaderboard.sort((a, b) => b.averageScorePct - a.averageScorePct);

        res.json(leaderboard);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Progress & Analytics API ──────────────────────────────────────────────────

app.get("/user/:name/progress", async (req, res) => {
    try {
        const playerName = decodeURIComponent(req.params.name);

        let results = [];
        if (!global.dbConnected) {
            results = memoryResults.filter(r => r.playerName.toLowerCase() === playerName.toLowerCase());
        } else {
            results = await Result.find({ playerName: { $regex: new RegExp(`^${playerName}$`, "i") } }).sort({ createdAt: 1 });
        }

        const totalAttempts = results.length;
        const avgScore = totalAttempts ? results.reduce((s, r) => s + (r.score / (r.totalQuestions || 1)), 0) / totalAttempts : 0;
        const totalMinutes = Math.round(totalAttempts * 1.5); // estimate 1.5 mins per attempt

        const scoreTrend = results.slice(-10).map(r => ({
            date: r.createdAt,
            quizCode: r.quizCode,
            scorePct: Math.round((r.score / (r.totalQuestions || 1)) * 100)
        }));

        res.json({
            playerName,
            totalQuizzesPlayed: totalAttempts,
            averageScorePct: Math.round(avgScore * 100),
            totalStudyTimeMinutes: totalMinutes,
            scoreTrend
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/user/:name/progress/export", async (req, res) => {
    try {
        const playerName = decodeURIComponent(req.params.name);

        let results = [];
        if (!global.dbConnected) {
            results = memoryResults.filter(r => r.playerName.toLowerCase() === playerName.toLowerCase());
        } else {
            results = await Result.find({ playerName: { $regex: new RegExp(`^${playerName}$`, "i") } }).sort({ createdAt: -1 });
        }

        const totalAttempts = results.length;
        const avgScore = totalAttempts ? results.reduce((s, r) => s + (r.score / (r.totalQuestions || 1)), 0) / totalAttempts : 0;
        const avgScorePct = Math.round(avgScore * 100);

        const rows = results.map(r => `
            <tr>
                <td style="border:1px solid #ccc;padding:8px;font-family:monospace;">#${r.quizCode}</td>
                <td style="border:1px solid #ccc;padding:8px;">${r.score}/${r.totalQuestions}</td>
                <td style="border:1px solid #ccc;padding:8px;">${Math.round((r.score / (r.totalQuestions || 1)) * 100)}%</td>
                <td style="border:1px solid #ccc;padding:8px;font-family:monospace;">${r.calibrationScore !== null ? r.calibrationScore + '%' : 'N/A'}</td>
                <td style="border:1px solid #ccc;padding:8px;">${new Date(r.createdAt).toLocaleDateString()}</td>
            </tr>
        `).join("");

        const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="utf-8"/>
            <title>Study Progress Transcript: ${playerName}</title>
            <style>
                body { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; max-width:800px; margin:40px auto; color:#333; line-height:1.5; }
                h1 { border-bottom: 2px solid #6366f1; padding-bottom: 8px; color: #4f46e5; }
                .stats-box { background:#f3f4f6; border-radius:12px; padding:20px; margin-bottom:30px; display:grid; grid-template-columns: repeat(3, 1fr); gap:20px; }
                .stat-card { text-align:center; }
                .stat-val { font-size:24px; font-weight:bold; color:#4f46e5; }
                table { width:100%; border-collapse:collapse; margin-top:20px; }
                th { background:#f3f4f6; text-align:left; border:1px solid #ccc; padding:8px; }
            </style>
        </head>
        <body>
            <h1>QuizGen Academic Progress Transcript</h1>
            <p><strong>Student Name:</strong> ${playerName}</p>
            <p><strong>Date Generated:</strong> ${new Date().toLocaleDateString()}</p>
            
            <div class="stats-box">
                <div class="stat-card">
                    <p style="margin:0;font-size:12px;color:#666;">Total Quizzes Played</p>
                    <div class="stat-val">${totalAttempts}</div>
                </div>
                <div class="stat-card">
                    <p style="margin:0;font-size:12px;color:#666;">Average Score Percentage</p>
                    <div class="stat-val">${avgScorePct}%</div>
                </div>
                <div class="stat-card">
                    <p style="margin:0;font-size:12px;color:#666;">Estimated Study Time</p>
                    <div class="stat-val">${Math.round(totalAttempts * 1.5)} Mins</div>
                </div>
            </div>

            <h2>Quiz Performance History Log</h2>
            <table>
                <thead>
                    <tr>
                        <th>Quiz Code</th>
                        <th>Raw Score</th>
                        <th>Score Pct</th>
                        <th>Calibration Score</th>
                        <th>Date Played</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows.length > 0 ? rows : '<tr><td colspan="5" style="text-align:center;padding:20px;color:#999;">No attempts recorded yet.</td></tr>'}
                </tbody>
            </table>
        </body>
        </html>
        `;

        res.setHeader("Content-Type", "text/html");
        res.setHeader("Content-Disposition", `attachment; filename="progress-report-${encodeURIComponent(playerName)}.html"`);
        res.send(html);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/explain-concept", async (req, res) => {
    try {
        const { questionPrompt, correctAnswer } = req.body;
        if (!questionPrompt || !correctAnswer) {
            return res.status(400).json({ error: "questionPrompt and correctAnswer are required." });
        }

        if (!aiAvailable()) {
            return res.json({
                explanation: `Offline explanation fallback:\n\nThe question was: "${questionPrompt}"\n\nThe correct answer is "${correctAnswer}". Under standard concepts, this is the correct choice because it aligns with the core definitions. Connect online for detailed Socratic explanation.`
            });
        }

        const system = `You are a friendly Socratic teacher. Given a quiz question and the correct answer, explain the underlying concept in plain, simple language.
Keep the explanation extremely concise and clear (maximum 3–4 sentences). Focus on *why* the answer is correct. Do not use complex jargon.`;

        const Anthropic = require("@anthropic-ai/sdk");
        const anthClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const response = await anthClient.messages.create({
            model: "claude-sonnet-4-5",
            max_tokens: 512,
            system,
            messages: [{ role: "user", content: `Question: ${questionPrompt}\nCorrect Answer: ${correctAnswer}` }]
        });

        const textBlock = response.content.find(b => b.type === "text");
        res.json({ explanation: textBlock.text.trim() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /admin/recalibrate ──────────────────────────────────────────────────

app.post("/admin/recalibrate", adminAuth, async (req, res) => {
    try {
        const MIN_ATTEMPTS = parseInt(req.query.minAttempts) || 20;
        let quizzesUpdated=0, questionsCalibrated=0;
        const quizzes = global.dbConnected ? await Quiz.find() : memoryQuizzes;
        for (const quiz of quizzes) {
            let dirty = false;
            for (let qi = 0; qi < quiz.questions.length; qi++) {
                const records = global.dbConnected
                    ? await UserPerformance.find({ quizCode:quiz.quizCode, questionIndex:qi })
                    : memoryUserPerformance.filter(r => r.quizCode===quiz.quizCode && r.questionIndex===qi);
                if (records.length < MIN_ATTEMPTS) continue;
                quiz.questions[qi].observedPassRate = Math.round(records.filter(r=>r.correct).length/records.length*100)/100;
                quiz.questions[qi].observedAttempts = records.length;
                questionsCalibrated++; dirty=true;
            }
            if (dirty && global.dbConnected) await Quiz.updateOne({ quizCode:quiz.quizCode }, { $set:{ questions:quiz.questions } });
            if (dirty) quizzesUpdated++;
        }
        res.json({ quizzesUpdated, questionsCalibrated, minAttempts:MIN_ATTEMPTS });
    } catch (err) { res.status(500).json({ error:err.message }); }
});

// ─── GET /admin/stats ─────────────────────────────────────────────────────────

app.get("/admin/stats", adminAuth, async (req, res) => {
    try {
        const days  = Math.min(parseInt(req.query.days)||7, 30);
        const since = new Date(Date.now() - days*24*60*60*1000);
        if (!global.dbConnected) {
            const relevant = memoryAnalytics.filter(e => new Date(e.createdAt) >= since);
            const created  = relevant.filter(e => e.event==="quiz_created");
            const results  = relevant.filter(e => e.event==="result_saved");
            const avgScore = results.length ? results.reduce((s,r)=>s+(r.score/(r.totalQuestions||1)),0)/results.length : null;
            const codeCounts = {}; for (const r of results) codeCounts[r.quizCode]=(codeCounts[r.quizCode]||0)+1;
            return res.json({ period:`${days} days`, quizzesCreated:created.length, questionsGenerated:created.reduce((s,e)=>s+(e.questionCount||0),0), resultsRecorded:results.length, avgScorePct:avgScore!==null?Math.round(avgScore*100):null, topQuizCodes:Object.entries(codeCounts).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([code,plays])=>({code,plays})) });
        }
        const [created, results] = await Promise.all([
            Analytics.find({event:"quiz_created",createdAt:{$gte:since}}),
            Analytics.find({event:"result_saved", createdAt:{$gte:since}})
        ]);
        const avgScore = results.length ? results.reduce((s,r)=>s+(r.score/(r.totalQuestions||1)),0)/results.length : null;
        const codeCounts = {}; for (const r of results) codeCounts[r.quizCode]=(codeCounts[r.quizCode]||0)+1;
        res.json({ period:`${days} days`, quizzesCreated:created.length, questionsGenerated:created.reduce((s,e)=>s+(e.questionCount||0),0), resultsRecorded:results.length, avgScorePct:avgScore!==null?Math.round(avgScore*100):null, topQuizCodes:Object.entries(codeCounts).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([code,plays])=>({code,plays})) });
    } catch (err) { res.status(500).json({ error:err.message }); }
});

// ─── GET /quiz/:code/debrief ──────────────────────────────────────────────────

app.get("/quiz/:code/debrief", async (req, res) => {
    try {
        if (!aiAvailable()) return res.status(503).json({ error:"AI not configured (set ANTHROPIC_API_KEY)." });
        const code = req.params.code.toUpperCase();
        const playerName = req.query.player;
        if (!playerName) return res.status(400).json({ error:"player query param required." });

        const result = global.dbConnected
            ? await Result.findOne({ quizCode:code, playerName }).sort({ createdAt:-1 })
            : [...memoryResults].reverse().find(r => r.quizCode===code && r.playerName===playerName);
        if (!result) return res.status(404).json({ error:"No result found for this player." });

        const quiz = global.dbConnected
            ? await Quiz.findOne({ quizCode:code })
            : memoryQuizzes.find(q => q.quizCode===code);

        const wrongAnswers = (result.answers||[]).filter(a => !a.correct).map(a => {
            const q = quiz?.questions?.[a.questionIndex];
            return { question:q?.questionPrompt||a.questionPrompt||`Q${a.questionIndex+1}`, correctAnswer:q?.correctAnswer||a.correctAnswer||"", playerAnswer:a.playerAnswer||"", explanation:q?.explanation||"" };
        });

        const script = await generateDebriefScript({ playerName, score:result.score, totalQuestions:result.totalQuestions, wrongAnswers });
        const elKey  = process.env.ELEVENLABS_API_KEY;
        const elVoiceId = process.env.ELEVENLABS_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";

        if (elKey) {
            try {
                const audio = await callElevenLabsTTS(script, elVoiceId, elKey);
                res.setHeader("Content-Type","audio/mpeg");
                res.setHeader("Content-Disposition",`inline; filename="debrief-${code}.mp3"`);
                return res.send(audio);
            } catch (ttsErr) { return res.json({ script, audio:null, ttsError:ttsErr.message }); }
        }
        res.json({ script, audio:null, instructions:"Set ELEVENLABS_API_KEY to receive an audio file." });
    } catch (err) { res.status(500).json({ error:err.message }); }
});

// ─── GET /quiz/:code/export ───────────────────────────────────────────────────

app.get("/quiz/:code/export", async (req, res) => {
    try {
        const code       = req.params.code.toUpperCase();
        const includeKey = req.query.key === "true";
        const quiz = global.dbConnected
            ? await Quiz.findOne({ quizCode:code })
            : memoryQuizzes.find(q => q.quizCode===code);
        if (!quiz) return res.status(404).json({ error:"Quiz not found." });
        const html = buildExportHtml(quiz, includeKey);
        res.setHeader("Content-Type","text/html; charset=utf-8");
        res.setHeader("Content-Disposition",`attachment; filename="quiz-${code}${includeKey?"-with-key":""}.html"`);
        res.send(html);
    } catch (err) { res.status(500).json({ error:err.message }); }
});

// ─── POST /send-to-classroom ──────────────────────────────────────────────────

function createClassroomAssignment(classroomId, quizCode, accessToken) {
    return new Promise((resolve, reject) => {
        // Fallback for development/testing: mock success if accessToken is "mock" or missing
        if (accessToken === "mock" || !accessToken) {
            return resolve({
                alternateLink: `https://classroom.google.com/c/mock-classroom/a/mock-assignment-${quizCode}/details`
            });
        }
        
        const payload = JSON.stringify({
            title: `QuizGen Assessment: #${quizCode}`,
            description: "Please complete this interactive quiz assessment on QuizGen.",
            materials: [
                {
                    link: {
                        url: `http://localhost:8080/index.html?quiz=${quizCode}`,
                        title: `Play Quiz: ${quizCode}`
                    }
                }
            ],
            workType: "ASSIGNMENT",
            state: "PUBLISHED"
        });

        const opts = {
            hostname: "classroom.googleapis.com",
            port: 443,
            path: `/v1/courses/${classroomId}/courseWork`,
            method: "POST",
            headers: {
                "Authorization": `Bearer ${accessToken}`,
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload)
            }
        };

        const req = https.request(opts, res => {
            let data = "";
            res.on("data", chunk => data += chunk);
            res.on("end", () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(JSON.parse(data));
                    } catch {
                        resolve({ alternateLink: `https://classroom.google.com/c/${classroomId}` });
                    }
                } else {
                    reject(new Error(`Classroom API error (${res.statusCode}): ${data}`));
                }
            });
        });

        req.on("error", reject);
        req.write(payload);
        req.end();
    });
}

app.post("/send-to-classroom", async (req, res) => {
    try {
        const { quizCode, classroomId, accessToken } = req.body;
        if (!quizCode || !classroomId) {
            return res.status(400).json({ error: "quizCode and classroomId are required." });
        }

        const quiz = global.dbConnected
            ? await Quiz.findOne({ quizCode: quizCode.toUpperCase() })
            : memoryQuizzes.find(q => q.quizCode === quizCode.toUpperCase());
        if (!quiz) return res.status(404).json({ error: "Quiz not found." });

        const assignment = await createClassroomAssignment(classroomId, quiz.quizCode, accessToken);
        res.json({
            message: "Assignment exported successfully to Google Classroom.",
            alternateLink: assignment.alternateLink
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/quiz/:code/spaced-repetition-opt-in", async (req, res) => {
    try {
        const code = req.params.code.toUpperCase();
        const { email, playerName } = req.body;
        if (!email || !playerName) {
            return res.status(400).json({ error: "email and playerName are required." });
        }

        if (!global.dbConnected) {
            const results = memoryResults.filter(r => r.quizCode === code && r.playerName.toLowerCase() === playerName.toLowerCase());
            results.forEach(r => { r.email = email; });
        } else {
            await Result.updateMany(
                { quizCode: code, playerName: { $regex: new RegExp(`^${playerName}$`, "i") } },
                { $set: { email } }
            );
        }

        res.json({ message: "Opted in successfully!" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /quiz/:code/question/:index/hint ────────────────────────────────────

app.post("/quiz/:code/question/:index/hint", async (req, res) => {
    try {
        if (!aiAvailable()) return res.status(503).json({ error: "AI not configured." });
        const code = req.params.code.toUpperCase();
        const index = parseInt(req.params.index, 10);
        const { playerAnswer } = req.body;
        if (!playerAnswer) return res.status(400).json({ error: "playerAnswer is required." });

        const quiz = global.dbConnected
            ? await Quiz.findOne({ quizCode: code })
            : memoryQuizzes.find(q => q.quizCode === code);
        if (!quiz) return res.status(404).json({ error: "Quiz not found." });

        const q = quiz.questions[index];
        if (!q) return res.status(404).json({ error: "Question not found." });

        const hint = await generateSocraticHint({
            question: q.questionPrompt,
            correctAnswer: q.correctAnswer,
            playerAnswer,
            sourceText: q.explanation || q.sentenceOriginal
        });
        res.json({ hint });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /learning-path ──────────────────────────────────────────────────────

const memoryLearningPaths = [];

app.post("/learning-path", async (req, res) => {
    try {
        const { documentIds, name } = req.body;
        if (!Array.isArray(documentIds) || documentIds.length === 0 || !name) {
            return res.status(400).json({ error: "documentIds (non-empty array) and name are required." });
        }

        const docs = [];
        for (const id of documentIds) {
            const doc = await getDocument(id);
            if (doc) docs.push(doc);
        }
        if (docs.length === 0) return res.status(404).json({ error: "No matching documents found." });

        let orderedIds = docs.map(d => d.documentId);
        if (aiAvailable() && docs.length > 1) {
            orderedIds = await determinePrerequisites(docs.map(d => ({
                id: d.documentId,
                filename: d.filename,
                text: d.text
            })));
        }

        const pathQuizzes = [];
        for (let i = 0; i < orderedIds.length; i++) {
            const docId = orderedIds[i];
            const doc = docs.find(d => d.documentId === docId);
            if (!doc) continue;

            let questions;
            if (aiAvailable()) {
                questions = doc.images?.length > 0
                    ? await generateQuizWithImages(doc.text, doc.images, 5)
                    : await generateQuizWithAI(doc.text, 5);
            } else {
                questions = generateQuiz(doc.text, 5);
            }

            const quizCode = uuidv4().substring(0, 6).toUpperCase();
            const quizData = {
                quizCode,
                questions,
                sources: [doc.filename],
                createdAt: new Date()
            };

            if (global.dbConnected) {
                const quiz = new Quiz(quizData);
                await quiz.save();
            } else {
                memoryQuizzes.push(quizData);
            }

            pathQuizzes.push({ quizCode, order: i + 1 });
        }

        const pathCode = `PATH_${uuidv4().substring(0, 6).toUpperCase()}`;
        const pathData = {
            pathCode,
            name,
            quizzes: pathQuizzes,
            unlockThreshold: 80,
            createdAt: new Date()
        };

        if (global.dbConnected) {
            const path = new LearningPath(pathData);
            await path.save();
        } else {
            memoryLearningPaths.push(pathData);
        }

        res.json({ message: "Learning path created successfully", pathCode, name, quizzes: pathQuizzes });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /learning-path/:code/status ──────────────────────────────────────────

app.get("/learning-path/:code/status", async (req, res) => {
    try {
        const code = req.params.code.toUpperCase();
        const playerName = req.query.player;
        if (!playerName) return res.status(400).json({ error: "player query param required." });

        const path = global.dbConnected
            ? await LearningPath.findOne({ pathCode: code })
            : memoryLearningPaths.find(p => p.pathCode === code);
        if (!path) return res.status(404).json({ error: "Learning path not found." });

        const statusList = [];
        let nextUnlocked = true;
        const sortedQuizzes = [...path.quizzes].sort((a, b) => a.order - b.order);
        const quizCodes = sortedQuizzes.map(q => q.quizCode);

        // N+1 Query Optimization: Fetch all results in one go
        const allResults = global.dbConnected
            ? await Result.find({ quizCode: { $in: quizCodes }, playerName })
            : memoryResults.filter(r => quizCodes.includes(r.quizCode) && r.playerName === playerName);

        for (const q of sortedQuizzes) {
            const results = allResults.filter(r => r.quizCode === q.quizCode);

            const unlocked = nextUnlocked;
            let passed = false;
            let bestScorePct = 0;

            if (results.length > 0) {
                const bestScore = Math.max(...results.map(r => r.score / (r.totalQuestions || 1)));
                bestScorePct = Math.round(bestScore * 100);
                passed = bestScorePct >= path.unlockThreshold;
            }

            statusList.push({
                quizCode: q.quizCode,
                order: q.order,
                unlocked,
                passed,
                bestScorePct
            });

            nextUnlocked = unlocked && passed;
        }

        res.json({ pathCode: path.pathCode, name: path.name, unlockThreshold: path.unlockThreshold, quizzes: statusList });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /grade-essay ────────────────────────────────────────────────────────

app.post("/grade-essay", generateLimit, async (req, res) => {
    try {
        if (!aiAvailable()) return res.status(503).json({ error: "AI not configured." });
        const { quizCode, questionIndex, playerExplanation } = req.body;
        if (!quizCode || questionIndex === undefined || !playerExplanation) {
            return res.status(400).json({ error: "quizCode, questionIndex, and playerExplanation are required." });
        }

        const code = quizCode.toUpperCase();
        const index = parseInt(questionIndex, 10);

        const quiz = global.dbConnected
            ? await Quiz.findOne({ quizCode: code })
            : memoryQuizzes.find(q => q.quizCode === code);
        if (!quiz) return res.status(404).json({ error: "Quiz not found." });

        const q = quiz.questions[index];
        if (!q) return res.status(404).json({ error: "Question not found." });
        if (q.type !== "essay") return res.status(400).json({ error: "Question is not an essay type." });

        const grade = await gradeEssay({
            question: q.questionPrompt,
            correctAnswer: q.correctAnswer,
            rubric: q.essayRubric || [],
            playerExplanation
        });

        res.json(grade);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /practice/write-question ────────────────────────────────────────────

app.post("/practice/write-question", generateLimit, async (req, res) => {
    try {
        if (!aiAvailable()) return res.status(503).json({ error: "AI not configured." });
        let { sourceText, userQuestion, userCorrectAnswer, quizCode, addToQuiz } = req.body;

        if (quizCode) {
            const code = quizCode.toUpperCase();
            const quiz = global.dbConnected
                ? await Quiz.findOne({ quizCode: code })
                : memoryQuizzes.find(q => q.quizCode === code);
            if (quiz && quiz.questions.length > 0) {
                sourceText = quiz.questions[0].sentenceOriginal || "";
            }
        }

        if (!sourceText || !userQuestion || !userCorrectAnswer) {
            return res.status(400).json({ error: "sourceText (or valid quizCode), userQuestion, and userCorrectAnswer are required." });
        }

        const evalResult = await evaluateUserQuestion({ sourceText, userQuestion, userCorrectAnswer });

        let added = false;
        if (addToQuiz && evalResult.ok && quizCode) {
            const code = quizCode.toUpperCase();
            const newQuestion = {
                sentenceOriginal: sourceText.slice(0, 150),
                questionPrompt: userQuestion,
                correctAnswer: userCorrectAnswer,
                choicesPool: [],
                type: "short-answer",
                difficulty: "medium",
                qualityChecked: true
            };

            if (global.dbConnected) {
                await Quiz.updateOne(
                    { quizCode: code },
                    { $push: { questions: newQuestion } }
                );
            } else {
                const quiz = memoryQuizzes.find(q => q.quizCode === code);
                if (quiz) quiz.questions.push(newQuestion);
            }
            added = true;
        }

        res.json({ ...evalResult, addedToQuiz: added });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /quiz/:code/next-question (Solo CAT Session) ─────────────────────────

const catSessions = new Map(); // player:quizCode -> session

// Periodically clean up abandoned/inactive CAT sessions to prevent memory leaks
setInterval(() => {
    const now = Date.now();
    for (const [key, session] of catSessions) {
        if (now - session.lastAccessedAt > 30 * 60 * 1000) { // 30 minutes inactivity
            catSessions.delete(key);
        }
    }
}, 60_000).unref();

app.get("/quiz/:code/next-question", async (req, res) => {
    try {
        const code = req.params.code.toUpperCase();
        const player = req.query.player;
        const prevCorrect = req.query.previousCorrect; // "true" or "false"

        if (!player) return res.status(400).json({ error: "player query param required." });

        const quiz = global.dbConnected
            ? await Quiz.findOne({ quizCode: code })
            : memoryQuizzes.find(q => q.quizCode === code);
        if (!quiz) return res.status(404).json({ error: "Quiz not found." });

        const sessionKey = `${player}:${code}`;
        let session = catSessions.get(sessionKey);

        if (!session) {
            session = {
                answeredIndices: new Set(),
                currentDifficulty: "medium",
                score: 0,
                totalAsked: 0,
                lastAccessedAt: Date.now()
            };
            catSessions.set(sessionKey, session);
        } else {
            session.lastAccessedAt = Date.now();
            if (prevCorrect !== undefined) {
                const wasCorrect = prevCorrect === "true";
                session.totalAsked++;
                if (wasCorrect) {
                    session.score++;
                    if (session.currentDifficulty === "easy") session.currentDifficulty = "medium";
                    else if (session.currentDifficulty === "medium") session.currentDifficulty = "hard";
                } else {
                    if (session.currentDifficulty === "hard") session.currentDifficulty = "medium";
                    else if (session.currentDifficulty === "medium") session.currentDifficulty = "easy";
                }
            }
        }

        // Find the next unasked question of currentDifficulty
        let nextIdx = -1;
        let questionsOfDifficulty = quiz.questions.map((q, i) => ({ q, i }))
            .filter(item => item.q.difficulty === session.currentDifficulty && !session.answeredIndices.has(item.i));

        if (questionsOfDifficulty.length > 0) {
            nextIdx = questionsOfDifficulty[0].i;
        } else {
            const unasked = quiz.questions.map((q, i) => ({ q, i }))
                .filter(item => !session.answeredIndices.has(item.i));
            if (unasked.length > 0) {
                unasked.sort((a, b) => {
                    const diffs = { easy: 1, medium: 2, hard: 3 };
                    const currentVal = diffs[session.currentDifficulty];
                    return Math.abs(diffs[a.q.difficulty] - currentVal) - Math.abs(diffs[b.q.difficulty] - currentVal);
                });
                nextIdx = unasked[0].i;
                session.currentDifficulty = unasked[0].q.difficulty;
            }
        }

        if (nextIdx === -1) {
            catSessions.delete(sessionKey);
            return res.json({
                sessionFinished: true,
                score: session.score,
                totalQuestions: session.totalAsked
            });
        }

        session.answeredIndices.add(nextIdx);
        const question = quiz.questions[nextIdx];

        res.json({
            sessionFinished: false,
            questionIndex: nextIdx,
            questionPrompt: question.questionPrompt,
            choicesPool: question.choicesPool || [],
            type: question.type,
            difficulty: question.difficulty,
            imageRef: question.imageRef || ""
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ─── Spaced-Repetition Study Reminders ────────────────────────────────────────

function sendResendEmail(to, subject, htmlContent) {
    return new Promise((resolve, reject) => {
        const apiKey = process.env.RESEND_API_KEY;
        if (!apiKey) {
            console.log(`[Spaced-Repetition Mock Email] To: ${to} | Subject: ${subject}`);
            console.log(`[Body]:\n${htmlContent.replace(/<[^>]*>/g, '')}\n`);
            return resolve(true);
        }

        const payload = JSON.stringify({
            from: "QuizGen <onboarding@resend.dev>",
            to: [to],
            subject: subject,
            html: htmlContent
        });

        const opts = {
            hostname: "api.resend.com",
            port: 443,
            path: "/emails",
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload)
            }
        };

        const req = https.request(opts, res => {
            let data = "";
            res.on("data", chunk => data += chunk);
            res.on("end", () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(true);
                } else {
                    reject(new Error(`Resend email failure (${res.statusCode}): ${data}`));
                }
            });
        });

        req.on("error", reject);
        req.write(payload);
        req.end();
    });
}

async function checkSpacedRepetitionReminders() {
    console.log("[Spaced Repetition] Checking for study reminders...");
    const now = new Date();
    
    // Intervals: 1 day, 3 days, 7 days
    const intervals = [
        { key: "1d", ms: 24 * 60 * 60 * 1000, label: "1 day" },
        { key: "3d", ms: 3 * 24 * 60 * 60 * 1000, label: "3 days" },
        { key: "7d", ms: 7 * 24 * 60 * 60 * 1000, label: "7 days" }
    ];

    if (!global.dbConnected) {
        // memoryResults fallback
        for (const res of memoryResults) {
            if (!res.email) continue;
            if (!res.spacedRepetitionSent) {
                res.spacedRepetitionSent = { "1d": false, "3d": false, "7d": false };
            }
            const ageMs = now - new Date(res.createdAt);
            for (const interval of intervals) {
                if (ageMs >= interval.ms && !res.spacedRepetitionSent[interval.key]) {
                    res.spacedRepetitionSent[interval.key] = true;
                    const subject = `Spaced Repetition Study Reminder: Quiz #${res.quizCode}`;
                    const body = `<h3>Hi ${res.playerName},</h3>
                    <p>It's been <strong>${interval.label}</strong> since you played Quiz <strong>#${res.quizCode}</strong>.</p>
                    <p>To reinforce what you learned and optimize long-term retention, retake the quiz now!</p>
                    <p><a href="http://localhost:8080/index.html?quiz=${res.quizCode}">Click here to play the quiz again.</a></p>
                    <p>Happy studying!<br>QuizGen Team</p>`;
                    
                    sendResendEmail(res.email, subject, body).catch(e => console.error("Email send error:", e.message));
                }
            }
        }
        return;
    }

    try {
        const results = await Result.find({ email: { $ne: "" } });
        for (const res of results) {
            const ageMs = now - res.createdAt;
            let dirty = false;
            
            const sentState = res.spacedRepetitionSent || new Map();
            
            for (const interval of intervals) {
                const alreadySent = sentState.get ? sentState.get(interval.key) : sentState[interval.key];
                if (ageMs >= interval.ms && !alreadySent) {
                    if (res.spacedRepetitionSent && res.spacedRepetitionSent.set) {
                        res.spacedRepetitionSent.set(interval.key, true);
                    } else {
                        res.spacedRepetitionSent = res.spacedRepetitionSent || {};
                        res.spacedRepetitionSent[interval.key] = true;
                    }
                    dirty = true;
                    
                    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:8080";
                    const subject = `Spaced Repetition Study Reminder: Quiz #${res.quizCode}`;
                    const body = `<h3>Hi ${res.playerName},</h3>
                    <p>It's been <strong>${interval.label}</strong> since you played Quiz <strong>#${res.quizCode}</strong>.</p>
                    <p>To reinforce what you learned and optimize long-term retention, retake the quiz now!</p>
                    <p><a href="${frontendUrl}/index.html?quiz=${res.quizCode}">Click here to play the quiz again.</a></p>
                    <p>Happy studying!<br>QuizGen Team</p>`;
                    
                    sendResendEmail(res.email, subject, body).catch(e => console.error("Email send error:", e.message));
                }
            }
            if (dirty) {
                await Result.updateOne(
                    { _id: res._id },
                    { $set: { spacedRepetitionSent: res.spacedRepetitionSent } }
                );
            }
        }
    } catch (err) {
        console.error("[Spaced Repetition] Error running check:", err.message);
    }
}

// Check every 30 minutes
setInterval(checkSpacedRepetitionReminders, 30 * 60 * 1000);
// Trigger check shortly after startup
setTimeout(checkSpacedRepetitionReminders, 10000);

// Auto-delete anonymous/guest logs older than 30 days (GDPR data minimization compliance)
async function cleanAnonymousLogs() {
    console.log("[GDPR Cleaner] Running anonymous data minimization cleaner...");
    const thresholdDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const anonNames = ["guest", "anonymous"];

    if (!global.dbConnected) {
        const toDelete = memoryResults.filter(r => 
            anonNames.includes(r.playerName.toLowerCase()) && new Date(r.createdAt) < thresholdDate
        );
        toDelete.forEach(item => {
            const idx = memoryResults.indexOf(item);
            if (idx !== -1) memoryResults.splice(idx, 1);
        });

        const toDeletePerf = memoryUserPerformance.filter(p => 
            anonNames.includes(p.playerName.toLowerCase()) && new Date(p.createdAt) < thresholdDate
        );
        toDeletePerf.forEach(item => {
            const idx = memoryUserPerformance.indexOf(item);
            if (idx !== -1) memoryUserPerformance.splice(idx, 1);
        });
        return;
    }

    try {
        const resultsDel = await Result.deleteMany({
            playerName: { $in: ["Guest", "Anonymous"] },
            createdAt: { $lt: thresholdDate }
        });
        const perfDel = await UserPerformance.deleteMany({
            playerName: { $in: ["Guest", "Anonymous"] },
            createdAt: { $lt: thresholdDate }
        });
        console.log(`[GDPR Cleaner] Removed ${resultsDel.deletedCount} old anonymous results and ${perfDel.deletedCount} performance logs.`);
    } catch (err) {
        console.error("[GDPR Cleaner] Error running anonymous logs clean up:", err.message);
    }
}

// Run cleaner every 24 hours
setInterval(cleanAnonymousLogs, 24 * 60 * 60 * 1000);
// Trigger 30 seconds after startup
setTimeout(cleanAnonymousLogs, 30000);

// ─── GET /admin/dashboard ──────────────────────────────────────────────────────

app.get("/admin/dashboard", adminAuth, async (req, res) => {
    try {
        const adminKey = req.query.key || "";
        const days = 7;
        const since = new Date(Date.now() - days*24*60*60*1000);
        let createdCount = 0;
        let resultsCount = 0;
        let avgScorePct = null;
        let quizzes = [];

        if (!global.dbConnected) {
            quizzes = [...memoryQuizzes];
            const relevant = memoryAnalytics.filter(e => new Date(e.createdAt) >= since);
            createdCount = relevant.filter(e => e.event==="quiz_created").length;
            const results = relevant.filter(e => e.event==="result_saved");
            resultsCount = results.length;
            const avgScore = results.length ? results.reduce((s,r)=>s+(r.score/(r.totalQuestions||1)),0)/results.length : null;
            avgScorePct = avgScore!==null?Math.round(avgScore*100):null;
        } else {
            quizzes = await Quiz.find().sort({ createdAt: -1 });
            const created = await Analytics.find({event:"quiz_created",createdAt:{$gte:since}});
            const results = await Analytics.find({event:"result_saved", createdAt:{$gte:since}});
            createdCount = created.length;
            resultsCount = results.length;
            const avgScore = results.length ? results.reduce((s,r)=>s+(r.score/(r.totalQuestions||1)),0)/results.length : null;
            avgScorePct = avgScore!==null?Math.round(avgScore*100):null;
        }

        const quizRows = quizzes.map((q, idx) => `
            <tr class="border-b border-gray-100 hover:bg-gray-50/50 transition-colors">
                <td class="px-6 py-4 font-mono font-bold text-indigo-600 text-sm">#${q.quizCode}</td>
                <td class="px-6 py-4 text-sm text-gray-800">${q.questions.length} Questions</td>
                <td class="px-6 py-4 text-sm text-gray-600"><span class="px-2 py-1 bg-indigo-50 text-indigo-700 text-xs font-semibold rounded-full">${q.language || "English"}</span></td>
                <td class="px-6 py-4 text-sm text-gray-500">${new Date(q.createdAt).toLocaleDateString()}</td>
                <td class="px-6 py-4 text-right">
                    <button onclick="deleteQuiz('${q.quizCode}')" class="px-3 py-1 bg-rose-50 text-rose-600 hover:bg-rose-100 font-bold rounded-lg text-xs transition-all duration-200">Delete</button>
                </td>
            </tr>
        `).join("");

        const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>QuizGen AI Admin Dashboard</title>
            <script src="https://cdn.tailwindcss.com"></script>
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
            <style>
                body { font-family: 'Inter', sans-serif; background-color: #f8fafc; }
            </style>
        </head>
        <body class="text-slate-800">
            <div class="min-h-screen flex flex-col">
                <!-- Top Nav -->
                <header class="bg-white border-b border-slate-200 py-4 px-8 flex justify-between items-center shadow-sm">
                    <div class="flex items-center gap-3">
                        <span class="text-2xl">🧠</span>
                        <h1 class="text-xl font-bold bg-gradient-to-r from-indigo-600 to-violet-600 bg-clip-text text-transparent">QuizGen AI Admin Panel</h1>
                    </div>
                    <div class="flex items-center gap-4">
                        <button onclick="recalibrate()" class="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-xl text-sm transition-all duration-200 shadow-sm active:scale-95">Recalibrate Difficulty</button>
                        <span class="px-3 py-1 bg-emerald-50 text-emerald-700 text-xs font-semibold rounded-full">Secure Auth Active</span>
                    </div>
                </header>

                <main class="flex-grow p-8 max-w-7xl mx-auto w-full">
                    <!-- Stats Grid -->
                    <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                        <div class="bg-white border border-slate-200 p-6 rounded-2xl shadow-sm">
                            <p class="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Quizzes Generated (7d)</p>
                            <p class="text-3xl font-bold text-slate-800">${createdCount}</p>
                        </div>
                        <div class="bg-white border border-slate-200 p-6 rounded-2xl shadow-sm">
                            <p class="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Results Recorded (7d)</p>
                            <p class="text-3xl font-bold text-slate-800">${resultsCount}</p>
                        </div>
                        <div class="bg-white border border-slate-200 p-6 rounded-2xl shadow-sm">
                            <p class="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Average Score Pct (7d)</p>
                            <p class="text-3xl font-bold text-slate-800">${avgScorePct !== null ? avgScorePct + '%' : 'N/A'}</p>
                        </div>
                    </div>

                    <!-- Library Table Section -->
                    <div class="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
                        <div class="px-6 py-4 border-b border-slate-200 bg-slate-50/50">
                            <h3 class="font-bold text-slate-800">Quiz Library Overview (${quizzes.length} Quizzes)</h3>
                        </div>
                        <div class="overflow-x-auto">
                            <table class="w-full text-left border-collapse">
                                <thead>
                                    <tr class="bg-slate-50 border-b border-slate-200 text-slate-400 uppercase font-bold text-xs">
                                        <th class="px-6 py-3">Code</th>
                                        <th class="px-6 py-3">Questions</th>
                                        <th class="px-6 py-3">Language</th>
                                        <th class="px-6 py-3">Created</th>
                                        <th class="px-6 py-3 text-right">Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${quizRows.length > 0 ? quizRows : '<tr><td colspan="5" class="text-center py-8 text-slate-400 text-sm">No quizzes found in library</td></tr>'}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </main>

                <footer class="py-6 text-center text-xs text-slate-400 border-t border-slate-200 bg-white">
                    QuizGen AI Administration Panel &bull; GDPR Compliant Minimization Enabled
                </footer>
            </div>

            <!-- Client Script -->
            <script>
                const ADMIN_KEY = "${adminKey}";

                async function deleteQuiz(code) {
                    if (!confirm("Are you sure you want to permanently delete quiz #" + code + "?")) return;
                    
                    try {
                        const response = await fetch("/quiz/" + code, {
                            method: "DELETE",
                            headers: {
                                "X-Admin-Key": ADMIN_KEY
                            }
                        });
                        if (response.ok) {
                            alert("Quiz #" + code + " deleted successfully.");
                            window.location.reload();
                        } else {
                            const err = await response.json();
                            alert("Deletion failed: " + (err.error || "Unknown error"));
                        }
                    } catch (e) {
                        alert("Network error occurred.");
                    }
                }

                async function recalibrate() {
                    const minAttempts = prompt("Enter minimum playing attempts to trigger recalibration:", "20");
                    if (minAttempts === null) return;
                    
                    try {
                        const response = await fetch("/admin/recalibrate?minAttempts=" + minAttempts, {
                            method: "POST",
                            headers: {
                                "X-Admin-Key": ADMIN_KEY
                            }
                        });
                        if (response.ok) {
                            const data = await response.json();
                            alert("Recalibration complete! Updated " + data.quizzesUpdated + " quizzes and calibrated " + data.questionsCalibrated + " questions.");
                            window.location.reload();
                        } else {
                            const err = await response.json();
                            alert("Recalibration failed: " + (err.error || "Unknown error"));
                        }
                    } catch (e) {
                        alert("Network error occurred.");
                    }
                }
            </script>
        </body>
        </html>
        `;
        res.send(html);
    } catch (err) {
        res.status(500).send("<h1>Admin Dashboard Error</h1><p>" + err.message + "</p>");
    }
});

// ─── Starter Templates Library ─────────────────────────────────────────────────

const starterPacks = [
    {
        quizCode: "JSBASE",
        language: "English",
        createdAt: new Date(),
        sources: ["JavaScript Core Language Specifications"],
        questions: [
            {
                questionPrompt: "What is the output of typeof null in JavaScript?",
                correctAnswer: "object",
                choicesPool: ["object", "null", "undefined", "number"],
                difficulty: "easy",
                type: "multiple-choice",
                explanation: "Historically, typeof null returns 'object', which is a well-known JavaScript bug.",
                distractorDetails: [
                    { text: "null", misconceptionAddressed: "People think it should return null because of the name." },
                    { text: "undefined", misconceptionAddressed: "People mix up null and undefined." },
                    { text: "number", misconceptionAddressed: "Sometimes null is coerced to 0, leading to number confusion." }
                ]
            },
            {
                questionPrompt: "Which keyword is used to declare block-scoped variables in modern JavaScript?",
                correctAnswer: "let",
                choicesPool: ["let", "var", "const", "define"],
                difficulty: "easy",
                type: "multiple-choice",
                explanation: "Both let and const declare block-scoped variables, but let is specifically used for reassignable variables.",
                distractorDetails: [
                    { text: "var", misconceptionAddressed: "var declares function-scoped variables, not block-scoped ones." },
                    { text: "const", misconceptionAddressed: "const is for block-scoped variables but they cannot be reassigned." },
                    { text: "define", misconceptionAddressed: "define is used in old AMD systems, not standard JS syntax." }
                ]
            },
            {
                questionPrompt: "What is a closure in JavaScript?",
                correctAnswer: "A function that retains access to its lexical scope even when executed outside that scope",
                choicesPool: [
                    "A function that retains access to its lexical scope even when executed outside that scope",
                    "A way to close the browser window programmatically",
                    "A variable declaration that prevents further changes",
                    "An internal browser mechanism to garbage collect unused variables"
                ],
                difficulty: "medium",
                type: "multiple-choice",
                explanation: "A closure is created when an inner function refers to variables of its outer function.",
                distractorDetails: [
                    { text: "A way to close the browser window programmatically", misconceptionAddressed: "Confusing programmatic window closing with closures." },
                    { text: "A variable declaration that prevents further changes", misconceptionAddressed: "Confusing closures with Object.freeze or const." },
                    { text: "An internal browser mechanism to garbage collect unused variables", misconceptionAddressed: "Confusing closures with garbage collection." }
                ]
            }
        ]
    },
    {
        quizCode: "GEOG01",
        language: "English",
        createdAt: new Date(),
        sources: ["World Geography Atlas"],
        questions: [
            {
                questionPrompt: "Which is the largest ocean on Earth?",
                correctAnswer: "Pacific Ocean",
                choicesPool: ["Pacific Ocean", "Atlantic Ocean", "Indian Ocean", "Arctic Ocean"],
                difficulty: "easy",
                type: "multiple-choice",
                explanation: "The Pacific Ocean is the largest and deepest ocean basin on Earth, covering over 30% of the planet's surface.",
                distractorDetails: [
                    { text: "Atlantic Ocean", misconceptionAddressed: "Often considered the most traveled, but not the largest." },
                    { text: "Indian Ocean", misconceptionAddressed: "Third largest, but located close to populous nations." },
                    { text: "Arctic Ocean", misconceptionAddressed: "The smallest of the major ocean groups." }
                ]
            },
            {
                questionPrompt: "What is the capital city of Australia?",
                correctAnswer: "Canberra",
                choicesPool: ["Canberra", "Sydney", "Melbourne", "Brisbane"],
                difficulty: "medium",
                type: "multiple-choice",
                explanation: "Canberra was selected as the capital in 1908 as a compromise between rival cities Sydney and Melbourne.",
                distractorDetails: [
                    { text: "Sydney", misconceptionAddressed: "Most famous and populous city, commonly mixed up as the capital." },
                    { text: "Melbourne", misconceptionAddressed: "Second largest city, also a former capital candidate." },
                    { text: "Brisbane", misconceptionAddressed: "Popular city, but never candidates for federal capital." }
                ]
            }
        ]
    },
    {
        quizCode: "SCI001",
        language: "English",
        createdAt: new Date(),
        sources: ["General Science Reference Handbook"],
        questions: [
            {
                questionPrompt: "What is the chemical symbol for Gold?",
                correctAnswer: "Au",
                choicesPool: ["Au", "Ag", "Gd", "Fe"],
                difficulty: "easy",
                type: "multiple-choice",
                explanation: "The symbol Au comes from the Latin word for gold, 'aurum', which means 'shining dawn'.",
                distractorDetails: [
                    { text: "Ag", misconceptionAddressed: "Ag is for Silver (Argentum)." },
                    { text: "Gd", misconceptionAddressed: "Gd is for Gadolinium, which starts with G." },
                    { text: "Fe", misconceptionAddressed: "Fe is for Iron (Ferrum)." }
                ]
            },
            {
                questionPrompt: "Which organelle is known as the powerhouse of the cell?",
                correctAnswer: "Mitochondria",
                choicesPool: ["Mitochondria", "Nucleus", "Ribosome", "Chloroplast"],
                difficulty: "easy",
                type: "multiple-choice",
                explanation: "Mitochondria are responsible for generating adenosine triphosphate (ATP), the primary energy source for cellular functions.",
                distractorDetails: [
                    { text: "Nucleus", misconceptionAddressed: "Contains genetic material; controls the cell but does not make energy." },
                    { text: "Ribosome", misconceptionAddressed: "Responsible for protein synthesis." },
                    { text: "Chloroplast", misconceptionAddressed: "Performs photosynthesis in plant cells only, not all cells." }
                ]
            }
        ]
    }
];

app.get("/starter-packs", (req, res) => {
    res.json(starterPacks);
});

async function seedStarterPacks() {
    console.log("[Seeding] Checking starter packs...");
    for (const pack of starterPacks) {
        if (!global.dbConnected) {
            if (!memoryQuizzes.some(q => q.quizCode === pack.quizCode)) {
                memoryQuizzes.push(pack);
            }
        } else {
            try {
                const exists = await Quiz.findOne({ quizCode: pack.quizCode });
                if (!exists) {
                    const quiz = new Quiz(pack);
                    await quiz.save();
                    console.log(`[Seeding] Seeded starter quiz #${pack.quizCode}`);
                }
            } catch (err) {
                console.warn("[Seeding] Failed to seed pack:", err.message);
            }
        }
    }
}

mongoose.connection.once("open", () => {
    seedStarterPacks();
});
setTimeout(seedStarterPacks, 2000);

// ─── 404 + error handler ──────────────────────────────────────────────────────

app.use((_req, res) => res.status(404).json({ error:"Route not found." }));
app.use((err, _req, res, _next) => { console.error(err.stack); res.status(err.status||500).json({ error:err.message||"Internal server error." }); });

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`QuizGen backend running on port ${PORT}`);
    console.log(`AI generation:       ${aiAvailable()                  ? "enabled"  : "disabled (set ANTHROPIC_API_KEY)"}`);
    console.log(`Admin stats:         ${process.env.ADMIN_API_KEY      ? "enabled"  : "disabled (set ADMIN_API_KEY)"}`);
    console.log(`Audio debrief (TTS): ${process.env.ELEVENLABS_API_KEY ? "enabled"  : "disabled (set ELEVENLABS_API_KEY)"}`);
    console.log(`Max questions/call:  ${MAX_QUESTION_COUNT}  |  BG job threshold: >${BG_JOB_THRESHOLD}  |  Leaderboard TTL: ${LEADERBOARD_TTL_MS/1000}s`);
});
