const mongoose = require("mongoose");

const LearningPathSchema = new mongoose.Schema({
    pathCode: {
        type: String,
        required: true,
        unique: true,
        index: true,
        uppercase: true
    },
    name: {
        type: String,
        required: true,
        trim: true
    },
    quizzes: [{
        quizCode: { type: String, required: true },
        order:    { type: Number, required: true }
    }],
    unlockThreshold: {
        type: Number,
        default: 80 // percentage score needed to unlock next quiz
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model("LearningPath", LearningPathSchema);
