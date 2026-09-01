const mongoose = require("mongoose");

/**
 * Tracks each player's per-question performance across all quizzes.
 * Used for knowledge map / weak-spot analysis and item-response calibration.
 *
 * One document per question attempted — append-only.
 */
const UserPerformanceSchema = new mongoose.Schema({
    playerName:     { type: String, required: true, index: true, trim: true },
    quizCode:       { type: String, required: true, index: true, uppercase: true },
    questionIndex:  { type: Number, required: true },
    questionPrompt: { type: String, required: true },
    correctAnswer:  { type: String, required: true },
    playerAnswer:   { type: String, default: "" },
    correct:        { type: Boolean, required: true },
    confidence:     { type: String, enum: ["low","medium","high"], default: "medium" },
    difficulty:     { type: String, enum: ["easy","medium","hard"], default: "medium" },
    hintsUsed:      { type: Number, default: 0 },
    createdAt:      { type: Date, default: Date.now, index: true }
});

module.exports = mongoose.model("UserPerformance", UserPerformanceSchema);
