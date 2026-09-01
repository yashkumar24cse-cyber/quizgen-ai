# 🧠 QuizGen AI — All-in-One Intelligent Study Platform

> **Stop alt-tabbing between tools.** QuizGen AI is an end-to-end study companion that replaces Notion, Anki, ChatGPT summaries, Google Calendar study scheduling, and WhatsApp study groups — all in one place.

---

## ✨ What It Does

Upload any document (PDF, DOCX, PPTX, TXT) and QuizGen AI becomes your complete study workflow:

| Feature | Replaces |
|---|---|
| 📝 **Notes Editor** — write notes, auto-save, generate quizzes directly | Notion / Google Docs |
| 🃏 **Flashcard Mode** — AI-generated cards with SM-2 spaced repetition | Anki / Quizlet |
| 📋 **Summarizer** — key points, definitions, overview in one click | ChatGPT / Claude |
| 📚 **Personal Library** — saved documents, tags, re-generate quizzes | Zotero / reference managers |
| 📅 **Study Planner** — spaced-repetition calendar from now to exam day | Google Calendar |
| 👥 **Study Groups** — create/join groups, share quizzes, group leaderboard | Discord / WhatsApp |
| 📊 **Progress Reports** — score trends, time studied, exportable transcript | Spreadsheets |
| 💡 **Explain Concept** — inline Claude explanation, mid-quiz, no tab-switching | Googling mid-quiz |

### Quiz Question Types
- Multiple Choice · True/False · Fill in the Blank · Short Answer · Essay · Explain Your Reasoning

### Additional Features
- 🏆 Live leaderboard per quiz + global leaderboard
- 🔊 Voice mode (Web Speech API) — speak your answers
- 🔗 Shareable quiz codes + URL sharing
- 📄 Print-ready PDF export
- 📡 Offline PWA support — results queue and sync on reconnect
- 🤖 AI confidence calibration scoring (Brier score)
- 🛡️ Content moderation + GDPR data export/delete
- 🔐 Admin dashboard with recalibration

---

## 🚀 Quick Start (Local)

### Prerequisites
- Node.js 18+ (https://nodejs.org)
- MongoDB 6+ running locally OR a free MongoDB Atlas cluster (optional — falls back to in-memory storage without it)
- An Anthropic API key (https://console.anthropic.com) (optional — falls back to local generator without it)

### 1. Clone and install
```
git clone https://github.com/YOUR_USERNAME/quizgen-ai.git
cd quizgen-ai
```

### 2. Set up the backend
```
cd Backend
copy .env.example .env
# Edit .env with your values (see table below)
npm install
npm start
# → Backend running on http://localhost:5000
```

### 3. Serve the frontend
```
cd ../Frontend
npm install
node static-server.js
# → Frontend at http://localhost:8080
```

Open **http://localhost:8080** and you're ready.

---

## ⚙️ Environment Variables

All variables live in `Backend/.env`. Copy from `Backend/.env.example`.

| Variable | Required | Description |
|---|---|---|
| MONGO_URI | No | MongoDB connection URI. Omit to use in-memory storage. |
| ANTHROPIC_API_KEY | No | Claude API key for AI generation. Omit for local fallback generator. |
| PORT | No | Backend port. Default 5000. |
| FRONTEND_URL | No | Your deployed frontend URL. Used in reminder emails. Default http://localhost:8080. |
| RESEND_API_KEY | No | Resend API key for spaced-repetition emails. Omit to log to console only. |
| ALLOWED_ORIGINS | No | Comma-separated CORS origins. Default: localhost origins. |
| ADMIN_API_KEY | No | Secret key for GET /admin/dashboard. Leave blank to disable. |
| ELEVENLABS_API_KEY | No | ElevenLabs key for audio debrief TTS. |
| MAX_QUESTION_COUNT | No | Max questions per generation call. Default 100. |
| BG_JOB_THRESHOLD | No | Question count above which generation runs as a background job. Default 30. |
| LEADERBOARD_CACHE_TTL_MS | No | Leaderboard cache duration in ms. Default 30000. |
| RESULT_TTL_DAYS | No | MongoDB TTL for result documents. Default 90. |

---

## 🌐 Deployment

### Backend (Render / Railway)
1. Create a new Web Service pointing to the `Backend/` folder.
2. Set build command: `npm install`
3. Set start command: `node server.js`
4. Add all environment variables from the table above.
5. Set `ALLOWED_ORIGINS` to your frontend deployed URL.

### Frontend (Vercel / Netlify / GitHub Pages)
1. Deploy the `Frontend/` folder as a static site.
2. In `Frontend/index.html`, add this line BEFORE the `<script src="script.js">` tag:
   ```html
   <script>window.BACKEND_URL = 'https://your-backend.onrender.com';</script>
   ```
3. That's it — no build step needed.

---

## 🗂️ Project Structure

```
QuizGen/
├── Backend/
│   ├── server.js           # Express app (50+ routes)
│   ├── aiQuizGenerator.js  # Claude AI integration + caching
│   ├── quizGenerator.js    # Local fallback generator
│   ├── contentModerator.js # Content safety checks
│   ├── database.js         # MongoDB connection
│   ├── models/             # Mongoose schemas
│   │   ├── Quiz.js
│   │   ├── Result.js
│   │   ├── Note.js
│   │   ├── Flashcard.js
│   │   ├── StudyPlan.js
│   │   ├── StudyGroup.js
│   │   ├── SourceDocument.js
│   │   ├── UserPerformance.js
│   │   ├── Analytics.js
│   │   └── LearningPath.js
│   ├── .env.example        # Template for environment variables
│   └── package.json
├── Frontend/
│   ├── index.html          # Single-page app UI
│   ├── script.js           # All client-side logic
│   ├── style.css           # Custom styles
│   ├── sw.js               # Service worker (PWA / offline)
│   └── static-server.js    # Local dev server
├── Extension/              # Browser extension (optional)
└── README.md
```

---

## 🧪 Running Tests

```
cd Backend
node smoke-test-v7.js
```

The smoke test verifies all 7 core feature areas: Notes, Flashcards, Summarizer, Study Planner, Groups, Progress, and Concept Explanation.

---

## 📜 License

MIT — free to use, modify, and distribute.

---

## 🙏 Built With

- Express.js — Backend framework
- MongoDB + Mongoose — Database
- Anthropic Claude — AI question and flashcard generation
- jsPDF — PDF export
- Web Speech API — Voice mode
