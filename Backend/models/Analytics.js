const mongoose = require("mongoose");

/**
 * Lightweight analytics event log.
 * Events: "quiz_created", "result_saved"
 * Kept append-only — never update or delete rows, just insert & aggregate.
 */
const AnalyticsSchema = new mongoose.Schema({
    event:          { type: String, required: true, index: true },
    quizCode:       { type: String, default: "" },
    questionCount:  { type: Number, default: 0 },
    score:          { type: Number, default: null },
    totalQuestions: { type: Number, default: null },
    createdAt:      { type: Date,   default: Date.now, index: true }
});

module.exports = mongoose.model("Analytics", AnalyticsSchema);
