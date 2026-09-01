# QuizGen AI — Free Hosting Plan, Start to Finish

This is a full checklist, in order. Follow it top to bottom. I've already made the small code changes it references (a `Procfile`, a `render.yaml`, and extra guidance in `.env.example`) — they're in the project files alongside this doc.

**The three free services this plan uses:** Render (backend), Netlify (frontend), MongoDB Atlas (database). All three have genuinely free tiers suitable for a class project — no credit card required for any of them at the tier this plan uses.

---

## Part 1 — Changes made to your code before hosting (already done)

1. **`Backend/Procfile` added** — tells hosting platforms to run `node server.js` to start the app. Some platforms (Render) don't strictly need this since you set the start command in their dashboard directly, but it's a standard convention worth having.
2. **`render.yaml` added** at the project root — an optional "blueprint" file that lets Render read your service configuration from the repo instead of you clicking through every setting manually. Using it is optional; manual setup (Part 3 below) works fine too.
3. **`.env.example` extended** with a specific note about rate limits for a live classroom demo — explained fully in Part 6.

You don't need to do anything for this part — it's already in place.

---

## Part 2 — Set up MongoDB Atlas (free database) — do this first

Your app *can* run without a real database (it falls back to in-memory storage), but for real hosting you want this, because in-memory storage is wiped every time the server restarts — and free hosting platforms restart your server automatically fairly often.

1. Go to https://www.mongodb.com/cloud/atlas/register and create a free account.
2. Create a new **free M0 cluster** (the free tier is called "M0" — pick any cloud provider/region, it doesn't matter for this project).
3. When prompted to create a database user, set a username and password — **write these down**, you'll need them in a moment.
4. Under **Network Access**, click "Add IP Address" and choose **"Allow access from anywhere"** (`0.0.0.0/0`). This is necessary because Render's servers don't have a fixed IP address you could whitelist instead.
5. Go to **Database → Connect → Drivers**, and copy the connection string. It looks like:
   ```
   mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```
6. Replace `<username>` and `<password>` with the real values from step 3, and add a database name after the `.net/` part, e.g.:
   ```
   mongodb+srv://myuser:mypassword@cluster0.xxxxx.mongodb.net/quizgen?retryWrites=true&w=majority
   ```
7. **Save this full string somewhere** — this is your `MONGO_URI`, needed in Part 3.

---

## Part 3 — Deploy the backend to Render

1. Push your project to a GitHub repository if it isn't already (Render deploys from a Git repo, not a manual file upload).
2. Go to https://render.com and sign up (GitHub login is easiest).
3. Click **New → Web Service**, and connect your GitHub repo.
4. Configure it:
   - **Root Directory**: `Backend`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: Free
5. Under **Environment Variables**, add these (get `ANTHROPIC_API_KEY` from https://console.anthropic.com if you haven't already):

   | Key | Value |
   |---|---|
   | `MONGO_URI` | the full string you saved in Part 2 |
   | `ANTHROPIC_API_KEY` | your Claude API key |
   | `ALLOWED_ORIGINS` | leave blank for now — you'll come back and set this in Part 5 |
   | `FRONTEND_URL` | leave blank for now too |

6. Click **Create Web Service**. Render will build and deploy it — this takes a few minutes the first time.
7. Once deployed, Render gives you a URL like `https://quizgen-ai-backend.onrender.com`. **Save this URL** — you need it in Part 4.
8. Test it directly by visiting `https://your-backend-url.onrender.com/quiz-history` in a browser — you should get back JSON (probably an empty list `[]`), not an error page.

---

## Part 4 — Deploy the frontend to Netlify

1. In `Frontend/index.html`, find the line right before `<script src="script.js"></script>` and add this line above it, using your **real** Render URL from Part 3:
   ```html
   <script>window.BACKEND_URL = 'https://quizgen-ai-backend.onrender.com';</script>
   ```
   This is the one line that tells your frontend where its backend actually lives once they're no longer both on `localhost`.
2. Go to https://netlify.com and sign up.
3. Click **Add new site → Deploy manually**, and drag your entire `Frontend` folder onto the upload area. (Alternatively, connect it to GitHub and set the **Publish directory** to `Frontend` for automatic redeploys whenever you push changes.)
4. Netlify gives you a URL like `https://quizgen-ai.netlify.app`. **Save this URL** — you need it in the next step.

---

## Part 5 — Connect the two: fix CORS

Right now your backend doesn't know your Netlify URL is allowed to talk to it.

1. Go back to your Render dashboard → your backend service → **Environment**.
2. Set `ALLOWED_ORIGINS` to your real Netlify URL from Part 4, e.g.:
   ```
   https://quizgen-ai.netlify.app
   ```
3. Set `FRONTEND_URL` to the same value.
4. Save — Render will automatically redeploy with the new settings.

**Why this step has to happen after both deploys, not before:** you need the real Netlify URL to exist before you can tell the backend to trust it, and you needed the real Render URL to exist before you could tell the frontend where to find it. This is genuinely a "chicken and egg" order of operations, not a mistake in the plan.

---

## Part 6 — Before you go live with 10+ people: read this

### The single biggest thing that will surprise you if you don't know about it: cold starts

**Render's free tier automatically shuts your backend down after 15 minutes of no traffic.** The very next request after that has to wait for it to wake back up — this typically takes **30-60 seconds**. If 10 people all click a shared quiz link at the exact scheduled start time, and your backend has been asleep, the first request will feel like it's hanging or broken for up to a minute.

**How to handle this, practically:** about 2-3 minutes before your class/demo starts, open the backend URL yourself in a browser (e.g. visit `/quiz-history`) to "wake it up." As long as it stays under 15 minutes of inactivity after that, it'll be warm and fast when everyone joins.

### The rate-limiting detail from earlier in our conversation, now made concrete

I already checked this in your actual code: **playing an existing quiz, submitting a score, and viewing the leaderboard are not rate-limited at all** — `GET /quiz/:code`, `POST /save-result`, and `GET /leaderboard/:code` have no limiter attached in `server.js`. Ten or more people hitting these simultaneously is completely fine as-is, with zero changes needed.

**The only scenario that could hit a limit**: if *several different people*, all on the same wifi network, each try to *generate their own separate quiz* within the same 15-minute window — because the rate limiter tracks requests by IP address, and people on the same wifi typically share one public IP. If your demo plan is "one person generates and shares a quiz code, everyone else just plays it," you will never hit this. If your plan is "everyone generates their own quiz independently," raise the limits beforehand using the values I added to `.env.example`:
```
RATE_GENERATE_MAX=100
RATE_UPLOAD_MAX=100
```
Set these as environment variables in Render's dashboard, the same way you set `MONGO_URI`.

### MongoDB Atlas free tier limits

The M0 free tier allows up to 500 simultaneous connections — you will not come close to that with 10-30 people. No action needed here.

### Anthropic API rate limits

These depend on your specific account tier and are visible in your Anthropic Console dashboard. If several people generate AI quizzes at close to the same moment, you could hit your account's requests-per-minute limit rather than anything in your own code. Check your current limits at https://console.anthropic.com before a live demo with many simultaneous generators, and consider whether you need to request a higher tier if you're expecting heavy simultaneous use.

---

## Part 7 — Actually testing this yourself before the real thing

You don't need 10 real people to test this — here's how to simulate it:

**The easy way (no new tools):** open 10 separate browser tabs (or better, a mix of regular + incognito windows, since some apps behave differently per-tab vs. genuinely separate sessions), paste the same shared quiz link into each, and click through playing the quiz in all of them within a short window of time. This tests the exact real scenario — many people hitting `/quiz/:code`, `/save-result`, and `/leaderboard/:code` around the same time.

**A more rigorous way, if you want real load-testing numbers:** a tool called `autocannon` can fire many requests at your backend automatically.
```bash
npm install -g autocannon
autocannon -c 10 -d 10 https://your-backend-url.onrender.com/quiz-history
```
This sends traffic from 10 concurrent connections (`-c 10`) for 10 seconds (`-d 10`) and prints out how many requests succeeded, how many failed, and how fast responses came back — genuinely useful evidence to bring to a mentor if asked "did you actually test this at scale," rather than just assuming it would work.

---

## Quick final checklist before you consider yourselves "hosted and ready"

- [ ] MongoDB Atlas cluster created, network access set to allow from anywhere, connection string saved
- [ ] Backend deployed on Render, with `MONGO_URI` and `ANTHROPIC_API_KEY` set
- [ ] Frontend deployed on Netlify, with `window.BACKEND_URL` pointing at the real Render URL
- [ ] `ALLOWED_ORIGINS` and `FRONTEND_URL` on Render updated to the real Netlify URL
- [ ] Backend "woken up" a few minutes before any live demo
- [ ] Rate limits raised temporarily if multiple people will generate quizzes independently, not just play one shared quiz
- [ ] Tested with at least 10 simultaneous browser tabs, or `autocannon`, before trusting it with real people
