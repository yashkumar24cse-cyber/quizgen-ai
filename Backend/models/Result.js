const mongoose = require("mongoose");

const EssayScoreBreakdownSchema = new mongoose.Schema(
    {
        criterion: { type: String, required: true },
        score:     { type: Number, required: true },
        feedback:  { type: String, default: "" }
    },
    { _id: false }
);

const AnswerSchema = new mongoose.Schema(
    {
        questionIndex: { type: Number, required: true },
        playerAnswer:  { type: String, default: "" },
        correct:       { type: Boolean, required: true },
        confidence: {
            type: String,
            enum: ["low", "medium", "high"],
            default: "medium"
        },
        // Track the number of Socratic hints requested before final submission
        hintsUsed: {
            type: Number,
            default: 0
        },
        // Detailed AI grading breakdown for essay type answers
        essayScoreBreakdown: {
            type: [EssayScoreBreakdownSchema],
            default: []
        }
    },
    { _id: false }
);

const ResultSchema = new mongoose.Schema({
    quizCode: {
        type: String,
        required: true,
        uppercase: true
    },
    playerName: {
        type: String,
        required: true,
        trim: true,
        maxlength: 50
    },
    score: {
        type: Number,
        required: true,
        min: 0
    },
    totalQuestions: {
        type: Number,
        required: true,
        min: 0
    },
    confidenceScore: { type: Number, default: null },
    calibrationScore:{ type: Number, default: null },
    answers: { type: [AnswerSchema], default: [] },
    email: { type: String, default: "" },
    spacedRepetitionSent: {
        type: Map,
        of: Boolean,
        default: { "1d": false, "3d": false, "7d": false }
    },
    createdAt: { type: Date, default: Date.now }
});

// ─── Indexes ──────────────────────────────────────────────────────────────────

// Fast leaderboard sort: filter by quizCode, sort by score descending.
ResultSchema.index({ quizCode: 1, score: -1 });

// Auto-expire old results from MongoDB via TTL index.
// Default 90 days; override with RESULT_TTL_DAYS env var.
const RESULT_TTL_SECONDS = (Math.max(1, parseInt(process.env.RESULT_TTL_DAYS) || 90)) * 24 * 60 * 60;
ResultSchema.index({ createdAt: 1 }, { expireAfterSeconds: RESULT_TTL_SECONDS });

module.exports = mongoose.model("Result", ResultSchema);
