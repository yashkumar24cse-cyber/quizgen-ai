const stopWords = new Set([
    'the','a','an','and','or','but','in','on','at','to','for','from','with','by',
    'about','against','between','into','through','during','before','after',
    'above','below','of','up','down','off','over','under','again','further',
    'then','once','here','there','when','where','why','how','all','any',
    'both','each','few','more','most','other','some','such','no','nor',
    'not','only','own','same','so','than','too','very','can','will','just',
    'should','now','this','that','these','those','am','is','are','was',
    'were','be','been','being','have','has','had','having','do','does',
    'did','doing','would','could','them','their','they','its','it','he',
    'she','him','her','his','hers','you','your','us','we'
]);

// Fisher-Yates: sort(() => 0.5 - Math.random()) is a well-known biased shuffle.
// This is a proper unbiased in-place shuffle.
function shuffle(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function generateQuiz(text, targetCount) {

    let sentences = text.match(/[^.!?]+[.!?]+/g) || [text];

    sentences = sentences
        .map(s => s.trim())
        .filter(s => s.length > 25);

    const rawWords = text.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];

    // Word frequency across the whole doc — words that appear a moderate
    // number of times (not once, not everywhere) tend to be better quiz
    // answers than pure "longest word in the sentence".
    const freq = {};
    for (const w of rawWords) {
        if (!stopWords.has(w)) freq[w] = (freq[w] || 0) + 1;
    }

    const uniqueWords = Object.keys(freq);

    let quizQuestions = [];

    for (let sentence of sentences) {

        const words = sentence.match(/\b[A-Za-z]{4,}\b/g) || [];

        const keywords = words.filter(
            w => !stopWords.has(w.toLowerCase())
        );

        if (keywords.length === 0) continue;

        // Prefer capitalized words (likely proper nouns / key terms), then
        // fall back to longer words, as a proxy for "important" terms.
        keywords.sort((a, b) => {
            const aCap = /^[A-Z]/.test(a) ? 1 : 0;
            const bCap = /^[A-Z]/.test(b) ? 1 : 0;
            if (aCap !== bCap) return bCap - aCap;
            return b.length - a.length;
        });

        const answer = keywords[0];
        const answerLower = answer.toLowerCase();

        const regex = new RegExp(`\\b${answer}\\b`, "i");

        const question = sentence.replace(regex, "_______");

        let options = [answer];

        // Pick distractors of similar length to the answer where possible,
        // so options don't look obviously wrong at a glance.
        const candidatePool = shuffle(
            uniqueWords.filter(w => w !== answerLower)
        );

        const similarLength = candidatePool.filter(
            w => Math.abs(w.length - answerLower.length) <= 2
        );
        const rest = candidatePool.filter(
            w => Math.abs(w.length - answerLower.length) > 2
        );

        for (const word of [...similarLength, ...rest]) {
            if (options.length >= 4) break;
            if (!options.some(o => o.toLowerCase() === word)) {
                options.push(word);
            }
        }

        while (options.length < 4) {
            options.push("option" + options.length);
        }

        quizQuestions.push({
            sentenceOriginal: sentence,
            questionPrompt:   question,
            correctAnswer:    answer,
            choicesPool:      shuffle(options),
            explanation:      "",
            type:             "multiple-choice",
            difficulty:       "medium"
        });
    }

    quizQuestions = shuffle(quizQuestions);

    return quizQuestions.slice(0, Math.min(targetCount, quizQuestions.length));
}

module.exports = generateQuiz;
