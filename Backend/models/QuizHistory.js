const mongoose = require("mongoose");


const quizHistorySchema = new mongoose.Schema({

    name:{
        type:String,
        required:true
    },

    score:{
        type:Number,
        required:true
    },

    totalQuestions:{
        type:Number,
        required:true
    },

    percentage:{
        type:Number,
        required:true
    },

    createdAt:{
        type:Date,
        default:Date.now
    }

});


module.exports = mongoose.model(
"QuizHistory",
quizHistorySchema
);