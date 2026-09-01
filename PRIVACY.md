# Privacy Policy & GDPR Compliance

QuizGen AI is fully committed to user privacy, data transparency, and user rights under the General Data Protection Regulation (GDPR).

## 1. Data Collection & Usage
We collect and process the following user data to support educational features and analytics:
- **Player Name**: Used to record scores and display rankings on the leaderboard.
- **Email Address** (Optional): Used solely to send timed Spaced-Repetition study reminders (after 1 day, 3 days, and 7 days).
- **Quiz Performance Data**: Tracks correct/incorrect answers, difficulty levels, Brier confidence metrics, and Socratic hint usage to identify learning gaps and weak spots.

## 2. Data Minimization & Retention
To minimize the storage of personal data:
- **Anonymous/Guest Records**: Leaderboard submissions and performance logs for names like **Guest** or **Anonymous** are automatically deleted after **30 days**.
- **Registered/Named Users**: Data is retained to allow long-term tracking of learning gaps unless a deletion request is made.

## 3. Your Data Rights (GDPR)
Under the GDPR, you have the following rights regarding your data:
- **Right of Access (Data Export)**: You can export a full copy of all your scores, answers, and weaknesses in JSON format.
- **Right to Erasure (Data Deletion)**: You can request the permanent deletion of all results and performance logs associated with your name.

## 4. How to Manage Your Data

### Export Your Data
To download a complete copy of your records, send a `GET` request to:
```
/user/:your_name/data-export
```
*(Example: visiting `http://localhost:5000/user/JohnDoe/data-export` in your browser will download a JSON file containing all JohnDoe's performance statistics.)*

### Delete Your Data
To delete all records associated with your name, send a `DELETE` request to:
```
/user/:your_name/data
```
*(Example: calling `DELETE http://localhost:5000/user/JohnDoe/data` via API or terminal will permanently wipe JohnDoe's results.)*
