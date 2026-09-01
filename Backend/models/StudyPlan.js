const mongoose = require("mongoose");

const StudyPlanSchema = new mongoose.Schema({
    planId: {
        type: String,
        required: true,
        unique: true
    },
    playerName: {
        type: String,
        required: true,
        index: true
    },
    examName: {
        type: String,
        required: true
    },
    examDate: {
        type: Date,
        required: true
    },
    documentIds: {
        type: [String],
        default: []
    },
    schedule: {
        type: [{
            date: { type: Date, required: true },
            documentId: { type: String, required: true },
            completed: { type: Boolean, default: false }
        }],
        default: []
    }
});

module.exports = mongoose.model("StudyPlan", StudyPlanSchema);
