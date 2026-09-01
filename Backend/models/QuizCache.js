const mongoose = require("mongoose");

/**
 * Persistent 24-hour cache for AI-generated quiz questions.
 * MongoDB's TTL index handles automatic expiry — no cron needed.
 *
 * Cache key = SHA-256(text + count + questionType + difficulty)
 * This is the L2 cache; the in-process Map in aiQuizGenerator.js is L1.
 */
const QuizCacheSchema = new mongoose.Schema({
    cacheKey: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    questions:    { type: Array,  required: true },
    questionType: { type: String, default: "multiple-choice" },
    // Track cache utility — incremented on every hit
    hitCount:     { type: Number, default: 0 },
    createdAt:    { type: Date,   default: Date.now }
});

// MongoDB TTL index: documents expire 24 hours after creation.
QuizCacheSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });

module.exports = mongoose.model("QuizCache", QuizCacheSchema);
