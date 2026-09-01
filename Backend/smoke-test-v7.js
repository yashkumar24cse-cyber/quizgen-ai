const http = require("http");

const BASE_URL = "http://127.0.0.1:5000";

function request(method, path, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, BASE_URL);
        const options = {
            method: method,
            hostname: url.hostname,
            port: url.port || 80,
            path: url.pathname + url.search,
            headers: {
                "Content-Type": "application/json",
                ...headers
            }
        };

        const req = http.request(options, res => {
            let data = "";
            res.on("data", chunk => data += chunk);
            res.on("end", () => {
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: data ? JSON.parse(data) : null
                });
            });
        });

        req.on("error", reject);
        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

async function run() {
    console.log("=== QuizGen v7 Ultimate Learning Suite Smoke Test ===");

    const player = "TesterV7";

    // 1. Notes API
    console.log("\n1. Testing Notes CRUD...");
    let noteId = "";
    try {
        const createRes = await request("POST", "/notes", {
            title: "Test Note v7",
            content: "This is some test study notes content about photosynthesis.",
            playerName: player
        });
        console.log(`POST /notes Status: ${createRes.status}`);
        console.log(`noteId: ${createRes.body.noteId}`);
        noteId = createRes.body.noteId;

        const getRes = await request("GET", `/notes?player=${player}`);
        console.log(`GET /notes Status: ${getRes.status}`);
        console.log(`Notes returned count: ${getRes.body.length}`);

        if (createRes.status !== 200 || getRes.status !== 200 || getRes.body.length === 0) {
            throw new Error("Notes CRUD failed.");
        }
    } catch (e) {
        console.error("FAIL:", e.message);
        process.exit(1);
    }

    // 2. Flashcards & SM-2 API
    console.log("\n2. Testing Flashcards & SM-2 algorithm...");
    let cardId = "";
    try {
        const genRes = await request("POST", "/generate-flashcards", {
            playerName: player,
            text: "Photosynthesis is the process by which green plants make food.",
            count: 2
        });
        console.log(`POST /generate-flashcards Status: ${genRes.status}`);
        console.log(`Cards generated count: ${genRes.body.flashcards.length}`);
        cardId = genRes.body.flashcards[0].cardId;

        const getRes = await request("GET", `/flashcards?player=${player}`);
        console.log(`GET /flashcards Status: ${getRes.status}`);
        console.log(`Total: ${getRes.body.totalCards} | Due: ${getRes.body.dueCardsCount}`);

        const revRes = await request("POST", `/flashcards/${cardId}/review`, {
            quality: 4 // good rating
        });
        console.log(`POST /flashcards/:id/review Status: ${revRes.status}`);
        console.log(`Next Interval: ${revRes.body.nextInterval} days | Repetitions: ${revRes.body.repetitions}`);

        if (genRes.status !== 200 || getRes.status !== 200 || revRes.status !== 200) {
            throw new Error("Flashcards SM-2 failed.");
        }
    } catch (e) {
        console.error("FAIL:", e.message);
        process.exit(1);
    }

    // 3. Summarizer API
    console.log("\n3. Testing Summarizer...");
    try {
        const res = await request("POST", "/summarize", {
            noteId: noteId
        });
        console.log(`POST /summarize Status: ${res.status}`);
        console.log(`Overview: ${res.body.summaryOverview}`);
        console.log(`Points count: ${res.body.summaryPoints.length}`);
        if (res.status !== 200) throw new Error("Summarizer failed.");
    } catch (e) {
        console.error("FAIL:", e.message);
        process.exit(1);
    }

    // 4. Reference Library API
    console.log("\n4. Testing Study Reference Library...");
    try {
        // Upload a doc first using generate-quiz (which populates library document)
        const uploadRes = await request("POST", "/create-quiz", {
            playerName: player,
            sources: ["Library Doc v7"],
            questions: [{ questionPrompt: "A", correctAnswer: "B" }]
        });

        // Let's query the library
        const res = await request("GET", `/library?player=${player}`);
        console.log(`GET /library Status: ${res.status}`);
        console.log(`Documents count: ${res.body.length}`);
        if (res.status !== 200) throw new Error("Library query failed.");
    } catch (e) {
        console.error("FAIL:", e.message);
        process.exit(1);
    }

    // 5. Study Planner API
    console.log("\n5. Testing Study Planner...");
    let planId = "";
    try {
        // Create library document first to use
        const mockDocId = "doc_TEST123";
        // Seed dummy in memory doc
        const createRes = await request("POST", "/study-plans", {
            playerName: player,
            examName: "Biology Midterm",
            examDate: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
            documentIds: [mockDocId]
        });
        console.log(`POST /study-plans Status: ${createRes.status}`);
        console.log(`planId: ${createRes.body.planId}`);
        planId = createRes.body.planId;

        const getRes = await request("GET", `/study-plans?player=${player}`);
        console.log(`GET /study-plans Status: ${getRes.status}`);
        console.log(`Schedule events count: ${getRes.body[0].schedule.length}`);

        const compRes = await request("POST", `/study-plans/${planId}/complete-day`, {
            documentId: mockDocId,
            date: getRes.body[0].schedule[0].date
        });
        console.log(`POST complete-day Status: ${compRes.status}`);

        if (createRes.status !== 200 || getRes.status !== 200 || compRes.status !== 200) {
            throw new Error("Study Planner failed.");
        }
    } catch (e) {
        console.error("FAIL:", e.message);
        process.exit(1);
    }

    // 6. Collaborative Study Groups API
    console.log("\n6. Testing Collaborative Study Groups...");
    let groupId = "";
    let joinCode = "";
    try {
        const createRes = await request("POST", "/groups", {
            name: "V7 Chem Team",
            ownerName: player
        });
        console.log(`POST /groups Status: ${createRes.status}`);
        console.log(`joinCode: ${createRes.body.joinCode}`);
        groupId = createRes.body.groupId;
        joinCode = createRes.body.joinCode;

        const joinRes = await request("POST", "/groups/join", {
            playerName: "TesterV7Partner",
            joinCode
        });
        console.log(`POST /groups/join Status: ${joinRes.status}`);

        const getRes = await request("GET", `/groups?player=${player}`);
        console.log(`GET /groups Status: ${getRes.status}`);
        console.log(`Groups player is in count: ${getRes.body.length}`);

        const lbRes = await request("GET", `/groups/${groupId}/leaderboard`);
        console.log(`GET /groups/:id/leaderboard Status: ${lbRes.status}`);
        console.log(`Leaderboard rank count: ${lbRes.body.length}`);

        if (createRes.status !== 200 || joinRes.status !== 200 || getRes.status !== 200 || lbRes.status !== 200) {
            throw new Error("Study Groups failed.");
        }
    } catch (e) {
        console.error("FAIL:", e.message);
        process.exit(1);
    }

    // 7. Progress & Analytics API
    console.log("\n7. Testing Progress Dashboard...");
    try {
        const res = await request("GET", `/user/${player}/progress`);
        console.log(`GET /user/:name/progress Status: ${res.status}`);
        console.log(`Quizzes played: ${res.body.totalQuizzesPlayed}`);
        console.log(`Average score: ${res.body.averageScorePct}%`);
        if (res.status !== 200) throw new Error("Progress stats failed.");
    } catch (e) {
        console.error("FAIL:", e.message);
        process.exit(1);
    }

    // 8. Concept Explanation API
    console.log("\n8. Testing Socratic Concept Explanation...");
    try {
        const res = await request("POST", "/explain-concept", {
            questionPrompt: "What organelle is the powerhouse of the cell?",
            correctAnswer: "Mitochondria"
        });
        console.log(`POST /explain-concept Status: ${res.status}`);
        console.log(`Explanation length: ${res.body.explanation.length} chars`);
        if (res.status !== 200) throw new Error("Concept explanation failed.");
    } catch (e) {
        console.error("FAIL:", e.message);
        process.exit(1);
    }

    console.log("\n=== ALL V7 PREMIUM TESTS PASSED SUCCESSFULLY! ===");
}

run();
