const mongoose = require("mongoose");

const StudyGroupSchema = new mongoose.Schema({
    groupId: {
        type: String,
        required: true,
        unique: true
    },
    name: {
        type: String,
        required: true
    },
    joinCode: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    ownerName: {
        type: String,
        required: true
    },
    members: {
        type: [String],
        default: []
    },
    sharedQuizzes: {
        type: [String],
        default: []
    },
    activityFeed: {
        type: [{
            message: { type: String, required: true },
            createdAt: { type: Date, default: Date.now }
        }],
        default: []
    }
});

module.exports = mongoose.model("StudyGroup", StudyGroupSchema);
