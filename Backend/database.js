const mongoose = require("mongoose");

global.dbConnected = false;

function connectDB() {
    const uri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/quizgen";

    console.log("Trying MongoDB connection...");

    mongoose
        .connect(uri)
        .then(() => {
            console.log("MongoDB connected");
            global.dbConnected = true;
        })
        .catch((error) => {
            console.log("MongoDB error:", error.message);
            console.log("Falling back to in-memory storage. Data will NOT persist between restarts.");
            global.dbConnected = false;
        });

    // If the connection drops later (not just on initial connect), reflect that too
    mongoose.connection.on("disconnected", () => {
        console.log("MongoDB disconnected — falling back to in-memory storage");
        global.dbConnected = false;
    });

    mongoose.connection.on("reconnected", () => {
        console.log("MongoDB reconnected");
        global.dbConnected = true;
    });
}

module.exports = connectDB;
