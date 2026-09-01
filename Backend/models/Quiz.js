const mongoose = require("mongoose");

const DistractorDetailSchema = new mongoose.Schema(
    {
        text:                  { type: String, required: true },
        misconceptionAddressed:{ type: String, default: "" }
    },
    { _id: false }
);

const EssayRubricSchema = new mongoose.Schema(
    {
        criterion: { type: String, required: true },
        maxPoints: { type: Number, required: true }
    },
    { _id: false }
);

const QuestionSchema = new mongoose.Schema(
    {
        sentenceOriginal: { type: String, default: "" },
        questionPrompt:   { type: String, required: true },
        correctAnswer:    { type: String, required: true },
        choicesPool:      { type: [String], default: [] },
        explanation:      { type: String, default: "" },
        type: {
            type: String,
            enum: ["multiple-choice", "true-false", "short-answer", "explain", "essay"],
            default: "multiple-choice"
        },
        difficulty: {
            type: String,
            enum: ["easy", "medium", "hard"],
            default: "medium"
        },
        sourceFile: { type: String, default: "" },

        // Misconception-aware distractor metadata (populated for AI-generated MCQ only)
        distractorDetails: { type: [DistractorDetailSchema], default: [] },

        // Diagram/image reference from docx media folders (stores filename/id)
        imageRef: { type: String, default: "" },

        // Rubric details generated specifically for essay questions
        essayRubric: { type: [EssayRubricSchema], default: [] },

        // Flag indicating if question passed the self-critique pass
        qualityChecked: { type: Boolean, default: false },

        // Item-response calibration (populated by /admin/recalibrate)
        observedPassRate:  { type: Number, default: null },  // 0.0 – 1.0
        observedAttempts:  { type: Number, default: 0 }
    },
    { _id: false }
);

const QuizSchema = new mongoose.Schema({
    quizCode: {
        type: String,
        required: true,
        unique: true,
        index: true,
        uppercase: true
    },
    questions: {
        type: [QuestionSchema],
        required: true,
        validate: {
            validator: (arr) => Array.isArray(arr) && arr.length > 0,
            message: "A quiz needs at least one question"
        }
    },
    sources: {
        type: [String],
        default: []
    },
    language: {
        type: String,
        default: "English"
    },
    summaryOverview: {
        type: String,
        default: ""
    },
    summaryPoints: {
        type: [String],
        default: []
    },
    summaryDefinitions: {
        type: [{
            term: { type: String },
            definition: { type: String }
        }],
        default: []
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

// Descending sort index for GET /quiz-history
QuizSchema.index({ createdAt: -1 });

module.exports = mongoose.model("Quiz", QuizSchema);
