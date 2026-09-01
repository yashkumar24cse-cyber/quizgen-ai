# QuizGen Bug Fixes & Question Limit Update

Summary of changes made on 26 Jul 2026.

## Question Limit

- Default question count raised from **5 → 15** on the Create Quiz screen.
- Maximum remains **25** in the UI (backend still allows up to 100).
- Document upload no longer overwrites a count the user already typed; the auto-estimate only fills the field when the user hasn’t set one.
- Generate requests clamp the count to the input’s min/max before sending.

## Join Screen UI Bugs

- **Invisible “Join Session” button** — `.btn-primary` was used in markup but never defined in CSS, so the label was white on a transparent background. Added a primary gradient style.
- **Overlapping floating labels** — “Quiz Code” / “Player Name” sat on top of the typed value. Labels now float to the top of the field with adjusted input padding so text stays clear.
- **Double border on inputs** — Tailwind Forms was drawing a second border inside each field; the inner input is now borderless so only the wrapper outline shows.
- **Unstyled join card** — added the missing `.premium-card` surface styles.

## “Guest” on the Leaderboard

Root cause: every `showScreen()` call ran `getPlayerName()`, which only read the *host* form’s `#player-name` and reset the join player’s name to `"Guest"`.

- Added `setPlayerName()` / `readStoredPlayerName()` so the name is set from any entry point (join, host, starter pack) and remembered in `localStorage`.
- `getPlayerName()` no longer overwrites a name that’s already set.
- History replay no longer hardcodes `"Guest User"`.

## Answer Breakdown Review

- Added missing `.badge`, `.badge-success`, `.badge-error`, and `.badge-neutral` styles so correct / wrong / unanswered answers are visible.
- Null-safe and trim-consistent scoring (aligned with submit scoring).
- Unanswered questions show a neutral “Unanswered” badge instead of being compared as empty strings.
- AI explanations are shown when present.
- Empty quiz state handled gracefully.

## Local Dev Server

- `static-server.js` previously 404’d on share links like `/?quiz=CODE` because the query string wasn’t stripped from the path. Fixed.

## Files Touched

| File | Change |
|------|--------|
| `Frontend/index.html` | Default question count `5` → `15` |
| `Frontend/script.js` | Player name helpers, review/scoring fixes, count clamping & upload behaviour |
| `Frontend/style.css` | `.btn-primary`, `.premium-card`, badges, floating-label layout, related utilities |
| `Frontend/static-server.js` | Query-string aware path resolution for share links |

## Deploy Note

The live Netlify build injects:

```html
<script>window.BACKEND_URL = 'https://quizgen-ai-excp.onrender.com';</script>
```

Keep that line when redeploying the frontend so the app continues to call the Render backend.
