const mongoose = require("mongoose");

const FlaggedContentSchema = new mongoose.Schema({
    statement:   { type: String, required: true },
    issue:       { type: String, required: true },
    explanation: { type: String, required: true }
}, { _id: false });

const SourceDocumentSchema = new mongoose.Schema({
    documentId: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    filename: {
        type: String,
        required: true
    },
    text: {
        type: String,
        required: true
    },
    images: [{
        filename: String,
        data:     String // base64 representation
    }],
    flaggedContent: {
        type: [FlaggedContentSchema],
        default: []
    },
    playerName: {
        type: String,
        default: "Guest",
        index: true
    },
    title: {
        type: String,
        default: "Untitled Document"
    },
    sourceType: {
        type: String,
        default: "txt"
    },
    tags: {
        type: [String],
        default: []
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model("SourceDocument", SourceDocumentSchema);
