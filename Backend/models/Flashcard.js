const mongoose = require("mongoose");

const FlashcardSchema = new mongoose.Schema({
    cardId: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    quizCode: {
        type: String,
        default: ""
    },
    playerName: {
        type: String,
        required: true,
        index: true
    },
    front: {
        type: String,
        required: true
    },
    back: {
        type: String,
        required: true
    },
    interval: {
        type: Number,
        default: 0
    },
    easeFactor: {
        type: Number,
        default: 2.5
    },
    repetitions: {
        type: Number,
        default: 0
    },
    nextReviewDate: {
        type: Date,
        default: Date.now,
        index: true
    }
});

module.exports = mongoose.model("Flashcard", FlashcardSchema);
