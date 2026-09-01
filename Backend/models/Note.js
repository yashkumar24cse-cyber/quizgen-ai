const mongoose = require("mongoose");

const NoteSchema = new mongoose.Schema({
    noteId: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    title: {
        type: String,
        required: true,
        trim: true
    },
    content: {
        type: String,
        default: ""
    },
    playerName: {
        type: String,
        required: true,
        index: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model("Note", NoteSchema);
