// Dynamic API Base URL detection
// For production deployment, set window.BACKEND_URL in index.html BEFORE this script:
//   <script>window.BACKEND_URL = 'https://your-backend.onrender.com';</script>
const API_BASE = (typeof window.BACKEND_URL !== 'undefined' && window.BACKEND_URL)
    ? window.BACKEND_URL.replace(/\/$/, '')
    : (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
        ? 'http://localhost:5000'
        : `https://${window.location.hostname}`);

// Number of questions requested when the player has not chosen one themselves
const DEFAULT_QUESTION_COUNT = 15;

// Global State
let uploadedText = "";
let quizQuestions = [];
let currentQuestionIndex = 0;
let userAnswers = [];
let userConfidences = [];
let playerName = "";
let sharedQuizCode = "";
let quizStartTime = null;
let timerInterval = null;

// v7 Premium Workspace State
let activeNoteId = null;
let noteAutoSaveTimeout = null;
let currentFlashcards = [];
let currentFlashcardIndex = 0;
let activeGroupId = null;

// Screen management: toggles visibility of sections
function showScreen(screenId) {
    clearError();
    if (screenId !== 'screen-playing') {
        stopVoiceMode();
    }
    document.querySelectorAll('.app-screen').forEach(el => el.classList.add('hidden'));
    
    const targetScreen = document.getElementById(screenId);
    if (targetScreen) {
        targetScreen.classList.remove('hidden');
    }
    
    // Update sidebar navigation selection state
    document.querySelectorAll('.nav-sidebar-item').forEach(item => {
        item.classList.remove('bg-primary-container', 'text-on-primary-container', 'font-bold');
        item.classList.add('text-on-surface-variant');
    });
    
    // Map screenId to navigation buttons
    let navId = '';
    if (screenId === 'screen-landing') navId = 'nav-landing';
    else if (screenId === 'screen-generate') navId = 'nav-generate';
    else if (screenId === 'screen-history') navId = 'nav-history';
    else if (screenId === 'screen-join') navId = 'nav-join';
    else if (screenId === 'screen-leaderboard') navId = 'nav-leaderboard';
    else if (screenId === 'screen-notes') navId = 'nav-notes';
    else if (screenId === 'screen-flashcards') navId = 'nav-flashcards';
    else if (screenId === 'screen-library') navId = 'nav-library';
    else if (screenId === 'screen-planner') navId = 'nav-planner';
    else if (screenId === 'screen-groups') navId = 'nav-groups';
    else if (screenId === 'screen-progress') navId = 'nav-progress';
    
    const activeNav = document.getElementById(navId);
    if (activeNav) {
        activeNav.classList.remove('text-on-surface-variant');
        activeNav.classList.add('bg-primary-container', 'text-on-primary-container', 'font-bold');
    }

    // Load user player name if available
    getPlayerName();

    // Trigger Screen-specific Initializers
    if (screenId === 'screen-history') {
        loadQuizHistory();
    }
    if (screenId === 'screen-leaderboard') {
        loadGlobalLeaderboard();
    }
    if (screenId === 'screen-notes') {
        loadNotes();
    }
    if (screenId === 'screen-flashcards') {
        loadFlashcards();
    }
    if (screenId === 'screen-library') {
        loadLibrary();
    }
    if (screenId === 'screen-planner') {
        loadPlanner();
    }
    if (screenId === 'screen-groups') {
        loadGroups();
    }
    if (screenId === 'screen-progress') {
        loadProgress();
    }
}

// Error Handling
function showError(msg) {
    const errorAlert = document.getElementById('error-alert');
    errorAlert.textContent = msg;
    errorAlert.classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function clearError() {
    const errorAlert = document.getElementById('error-alert');
    errorAlert.classList.add('hidden');
}

// Initialize Page Toggles & listeners
document.addEventListener('DOMContentLoaded', () => {
    // Theme Toggle
    const themeToggle = document.getElementById('theme-toggle');
    if (themeToggle) {
        themeToggle.addEventListener('click', () => {
            document.documentElement.classList.toggle('dark');
            const isDark = document.documentElement.classList.contains('dark');
            themeToggle.textContent = isDark ? 'light_mode' : 'dark_mode';
        });
    }

    // Voice Toggle
    const voiceToggle = document.getElementById('btn-voice-toggle');
    if (voiceToggle) {
        voiceToggle.addEventListener('click', toggleVoiceMode);
    }

    // Spaced Repetition Opt-in Click
    const btnSaveSpacedRep = document.getElementById('btn-save-spaced-rep');
    if (btnSaveSpacedRep) {
        btnSaveSpacedRep.addEventListener('click', handleSpacedRepetitionOptIn);
    }

    // Document Upload Drag and Drop setup
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('source-file');
    const stateDefault = document.getElementById('state-default');
    const stateUploading = document.getElementById('state-uploading');
    const statePreview = document.getElementById('state-preview');
    const progressBar = document.getElementById('upload-progress-bar');
    const progressText = document.getElementById('progress-text-percent');
    const previewFilename = document.getElementById('preview-filename');
    const btnRemoveFile = document.getElementById('btn-remove-file');
    const btnGenerate = document.getElementById('btn-generate');
    
    if (dropZone && fileInput) {
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.classList.add('border-primary', 'bg-surface-container-high');
        });

        dropZone.addEventListener('dragleave', () => {
            dropZone.classList.remove('border-primary', 'bg-surface-container-high');
        });

        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('border-primary', 'bg-surface-container-high');
            const files = e.dataTransfer.files;
            if (files.length > 0) handleFileUpload(files[0]);
        });

        dropZone.addEventListener('click', (e) => {
            // Only click if we are in default state
            if (!stateDefault.classList.contains('hidden')) {
                fileInput.click();
            }
        });

        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) handleFileUpload(e.target.files[0]);
        });
    }

    if (btnRemoveFile) {
        btnRemoveFile.addEventListener('click', (e) => {
            e.stopPropagation();
            statePreview.classList.add('hidden');
            stateDefault.classList.remove('hidden');
            progressBar.style.width = '0%';
            progressText.innerText = '0';
            fileInput.value = '';
            uploadedText = "";
            document.getElementById('document-preview-container').classList.add('hidden');
        });
    }

    if (btnGenerate) {
        btnGenerate.addEventListener('click', handleQuizGenerationSubmit);
    }

    // Test automation upload fallback
    const testFileInput = document.getElementById('test-file-path');
    if (testFileInput) {
        testFileInput.addEventListener('change', async (e) => {
            const url = e.target.value.trim();
            if (url) {
                try {
                    const response = await fetch(url);
                    const text = await response.text();
                    const filename = url.split('/').pop();
                    const mockFile = new File([text], filename, { type: 'text/plain' });
                    handleFileUpload(mockFile);
                } catch (err) {
                    console.error("Failed to load test file:", err);
                    showError("Failed to fetch test file: " + err.message);
                }
            }
        });
    }

    // Play navigation buttons
    document.getElementById('btn-prev-question').addEventListener('click', handlePrevQuestion);
    document.getElementById('btn-next-question').addEventListener('click', handleNextQuestion);

    // Results Actions
    document.getElementById('btn-results-reset').addEventListener('click', () => showScreen('screen-generate'));
    document.getElementById('btn-results-download').addEventListener('click', downloadQuizPDF);
    document.getElementById('btn-results-share').addEventListener('click', shareQuiz);

    // Join Actions
    document.getElementById('btn-submit-join').addEventListener('click', handleJoinQuizSubmit);

    // Quiz history search bar filtering
    const searchInput = document.getElementById('history-search-input');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            const term = e.target.value.toLowerCase().trim();
            const cards = document.querySelectorAll('#history-list-grid > article');
            let visibleCount = 0;
            cards.forEach(card => {
                const text = card.innerText.toLowerCase();
                if (text.includes(term)) {
                    card.classList.remove('hidden');
                    visibleCount++;
                } else {
                    card.classList.add('hidden');
                }
            });
            
            const emptyState = document.getElementById('history-empty-state');
            const grid = document.getElementById('history-list-grid');
            if (visibleCount === 0) {
                grid.classList.add('hidden');
                emptyState.classList.remove('hidden');
                emptyState.classList.add('flex');
            } else {
                grid.classList.remove('hidden');
                emptyState.classList.add('hidden');
                emptyState.classList.remove('flex');
            }
        });
    }

    // Restore the last player name so returning players keep their leaderboard identity
    const rememberedName = readStoredPlayerName();
    if (rememberedName) {
        setPlayerName(rememberedName);
        const joinNameInput = document.getElementById('join-player-name');
        if (joinNameInput && !joinNameInput.value.trim()) joinNameInput.value = rememberedName;
    }

    // Keep the question count the player typed instead of overwriting it after an upload
    const questionCountInput = document.getElementById('question-count');
    if (questionCountInput) {
        questionCountInput.addEventListener('input', () => {
            questionCountInput.dataset.userSet = "true";
        });
    }

    // Load initial shared quiz if present in URL
    loadSharedQuizFromUrl();
});

// File Upload Handler
function handleFileUpload(file) {
    clearError();
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext !== 'txt' && ext !== 'docx') {
        showError('Only TXT and DOCX files are supported.');
        return;
    }

    const stateDefault = document.getElementById('state-default');
    const stateUploading = document.getElementById('state-uploading');
    const statePreview = document.getElementById('state-preview');
    const progressBar = document.getElementById('upload-progress-bar');
    const progressText = document.getElementById('progress-text-percent');
    const previewFilename = document.getElementById('preview-filename');

    // UI Transition to Uploading
    stateDefault.classList.add('hidden');
    stateUploading.classList.remove('hidden');

    // Simulation of progress bar
    let progress = 0;
    const interval = setInterval(() => {
        progress += Math.floor(Math.random() * 15) + 10;
        if (progress >= 100) {
            progress = 100;
            clearInterval(interval);
        }
        progressBar.style.width = progress + '%';
        progressText.innerText = progress;
    }, 150);

    // Call Backend endpoint to extract text
    const formData = new FormData();
    formData.append("document", file);

    fetch(`${API_BASE}/upload`, {
        method: "POST",
        body: formData
    })
    .then(res => res.json())
    .then(data => {
        if (data.error) {
            clearInterval(interval);
            showError(data.error);
            resetUploadState();
            return;
        }

        uploadedText = data.text;
        
        // Show Preview State
        stateUploading.classList.add('hidden');
        statePreview.classList.remove('hidden');
        previewFilename.innerText = file.name;
        
        // Populate document preview hidden element
        const docPreview = document.getElementById('document-preview');
        const docContainer = document.getElementById('document-preview-container');
        docPreview.textContent = data.text;
        docContainer.classList.remove('hidden');

        // Estimate questions count based on text length
        const countInput = document.getElementById('question-count');
        const maxQuestions = parseInt(countInput.max, 10) || DEFAULT_QUESTION_COUNT;
        const wordsCount = data.text.split(/\s+/).length;
        const estQuestions = Math.min(maxQuestions, Math.max(DEFAULT_QUESTION_COUNT, Math.round(wordsCount / 80)));
        document.getElementById('est-questions').innerText = `${estQuestions} Questions`;
        if (countInput.dataset.userSet !== "true") {
            countInput.value = estQuestions;
        }
    })
    .catch(error => {
        clearInterval(interval);
        showError("Failed to upload document to backend.");
        resetUploadState();
        console.error(error);
    });
}

function resetUploadState() {
    document.getElementById('state-preview').classList.add('hidden');
    document.getElementById('state-uploading').classList.add('hidden');
    document.getElementById('state-default').classList.remove('hidden');
    document.getElementById('upload-progress-bar').style.width = '0%';
    document.getElementById('progress-text-percent').innerText = '0';
    document.getElementById('source-file').value = '';
    uploadedText = "";
    document.getElementById('document-preview-container').classList.add('hidden');
}

// Generate Quiz Submit
function handleQuizGenerationSubmit() {
    clearError();
    const playerNameInput = document.getElementById('player-name').value.trim();
    const countInput = document.getElementById('question-count');
    const minCount = parseInt(countInput.min, 10) || 1;
    const maxCount = parseInt(countInput.max, 10) || DEFAULT_QUESTION_COUNT;
    const questionCountInput = Math.min(maxCount, Math.max(minCount, parseInt(countInput.value, 10) || DEFAULT_QUESTION_COUNT));
    countInput.value = questionCountInput;
    const targetLanguage = document.getElementById('target-language')?.value || "English";
    const questionType = document.getElementById('question-type')?.value || "multiple-choice";
    const difficulty = document.getElementById('question-difficulty')?.value || "medium";
    const useAI = document.getElementById('use-ai-toggle') ? document.getElementById('use-ai-toggle').checked : true;

    if (!playerNameInput) {
        showError("Please enter your name to proceed.");
        return;
    }
    setPlayerName(playerNameInput);

    if (!uploadedText) {
        showError("Please upload a study document first.");
        return;
    }

    const btnText = document.getElementById('btn-generate-text');
    const btnLoader = document.getElementById('btn-loader-indicator');
    const btnGenerate = document.getElementById('btn-generate');

    btnText.innerText = 'Analyzing Content';
    btnText.classList.add('loading-dots');
    btnLoader.classList.remove('hidden');
    btnGenerate.classList.add('opacity-80', 'cursor-not-allowed');
    btnGenerate.disabled = true;

    fetch(`${API_BASE}/generate-quiz`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            text: uploadedText,
            count: questionCountInput,
            language: targetLanguage,
            questionType: questionType,
            difficulty: difficulty,
            useAI: useAI
        })
    })
    .then(res => res.json())
    .then(data => {
        // Reset loader
        btnText.innerText = 'Generate Quiz';
        btnText.classList.remove('loading-dots');
        btnLoader.classList.add('hidden');
        btnGenerate.classList.remove('opacity-80', 'cursor-not-allowed');
        btnGenerate.disabled = false;

        if (data.error) {
            showError(data.error);
            return;
        }

        if (!data.questions || data.questions.length === 0) {
            showError("No questions could be generated from this document.");
            return;
        }

        quizQuestions = data.questions;
        sharedQuizCode = ""; // Local generated quiz
        
        // Load Review Screen
        showScreen('screen-review');
        document.getElementById('review-source-text').textContent = uploadedText;
        document.getElementById('generated-count-text').innerText = `${quizQuestions.length} Questions generated successfully`;
        renderReviewQuestions();
    })
    .catch(error => {
        btnText.innerText = 'Generate Quiz';
        btnText.classList.remove('loading-dots');
        btnLoader.classList.add('hidden');
        btnGenerate.classList.remove('opacity-80', 'cursor-not-allowed');
        btnGenerate.disabled = false;
        showError("Quiz generation failed. Backend connection issue.");
        console.error(error);
    });
}

// Render Review Questions list
function renderReviewQuestions() {
    const container = document.getElementById('review-mcqs-container');
    container.innerHTML = "";

    quizQuestions.forEach((q, index) => {
        const card = document.createElement('div');
        card.className = "glass-card rounded-2xl p-lg hover-lift relative";
        card.innerHTML = `
            <div class="flex justify-between items-start mb-md">
                <span class="bg-primary/10 text-primary px-3 py-1 rounded-full font-label-sm text-label-sm">Question ${index + 1}</span>
                <div class="flex gap-2">
                    <button class="p-1.5 hover:bg-surface-container-high rounded transition-colors text-on-surface-variant edit-q-btn" data-index="${index}" title="Edit Question"><span class="material-symbols-outlined text-[18px]">edit</span></button>
                    <button class="p-1.5 hover:bg-error-container/20 hover:text-error rounded transition-colors text-on-surface-variant delete-q-btn" data-index="${index}" title="Delete Question"><span class="material-symbols-outlined text-[18px]">delete</span></button>
                </div>
            </div>
            <h3 class="font-headline-md text-body-lg text-on-surface mb-lg">${escapeHtml(q.questionPrompt)}</h3>
            <div class="space-y-sm">
                ${q.choicesPool && q.choicesPool.length > 0 ? q.choicesPool.map((choice, oIndex) => {
                    const isCorrect = choice.toLowerCase() === q.correctAnswer.toLowerCase();
                    const optChar = String.fromCharCode(65 + oIndex);
                    return `
                        <div class="flex items-center p-md border ${isCorrect ? 'border-primary/40 bg-primary/5 font-semibold text-primary' : 'border-outline-variant/50 bg-surface/50'} rounded-xl">
                            <span class="w-8 h-8 flex items-center justify-center rounded-full ${isCorrect ? 'bg-primary text-white' : 'border border-outline-variant'} mr-3 text-label-md">${optChar}</span>
                            <span class="font-body-md text-body-md">${escapeHtml(choice)}</span>
                            ${isCorrect ? '<span class="material-symbols-outlined ml-auto text-[#10B981]" style="font-variation-settings: \'FILL\' 1;">check_circle</span>' : ''}
                        </div>
                    `;
                }).join('') : `
                    <div class="p-md border border-outline-variant/50 bg-surface/50 rounded-xl">
                        <strong>Correct Answer:</strong> <span class="text-primary font-semibold">${escapeHtml(q.correctAnswer)}</span>
                    </div>
                `}
            </div>
        `;
        container.appendChild(card);
    });

    // Attach listeners for Edit and Delete
    container.querySelectorAll('.edit-q-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const index = parseInt(btn.getAttribute('data-index'), 10);
            const newPrompt = prompt("Edit Question Prompt:", quizQuestions[index].questionPrompt);
            if (newPrompt && newPrompt.trim()) {
                quizQuestions[index].questionPrompt = newPrompt.trim();
                renderReviewQuestions();
            }
        });
    });

    container.querySelectorAll('.delete-q-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const index = parseInt(btn.getAttribute('data-index'), 10);
            if (confirm("Are you sure you want to delete this question?")) {
                quizQuestions.splice(index, 1);
                document.getElementById('generated-count-text').innerText = `${quizQuestions.length} Questions generated successfully`;
                renderReviewQuestions();
            }
        });
    });

    // Launch Quiz session click listener
    const btnLaunch = document.getElementById('btn-launch-quiz');
    btnLaunch.onclick = () => {
        if (quizQuestions.length === 0) {
            alert("No questions in the quiz. Please generate some first.");
            return;
        }
        
        // Share/create quiz on the backend first to get a code if not shared yet
        saveQuizToLibrary().then(() => {
            startQuizPlay();
        });
    };
}

// Save Quiz on the backend
async function saveQuizToLibrary() {
    try {
        const targetLanguage = document.getElementById('target-language')?.value || "English";
        const response = await fetch(`${API_BASE}/create-quiz`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                questions: quizQuestions,
                language: targetLanguage
            })
        });
        const data = await response.json();
        if (data.quizCode) {
            sharedQuizCode = data.quizCode;
            console.log("Quiz saved successfully. Code: " + sharedQuizCode);
        }
    } catch(err) {
        console.error("Could not save quiz to database, playing locally.", err);
    }
}

// Start playing
function startQuizPlay() {
    currentQuestionIndex = 0;
    userAnswers = [];
    userConfidences = new Array(quizQuestions.length).fill("medium");
    quizStartTime = new Date();
    
    // Timer interval
    if (timerInterval) clearInterval(timerInterval);
    const timerDisplay = document.getElementById('playing-timer');
    timerDisplay.innerText = "00:00";
    timerDisplay.classList.remove('text-error', 'timer-glow');
    
    timerInterval = setInterval(() => {
        const diff = Math.floor((new Date() - quizStartTime) / 1000);
        const mins = Math.floor(diff / 60);
        const secs = diff % 60;
        timerDisplay.innerText = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }, 1000);

    // Reset spaced repetition opt-in inputs
    const emailInput = document.getElementById('spaced-rep-email');
    if (emailInput) {
        emailInput.value = "";
        emailInput.disabled = false;
    }
    const btnSaveSpaced = document.getElementById('btn-save-spaced-rep');
    if (btnSaveSpaced) {
        btnSaveSpaced.disabled = false;
        btnSaveSpaced.innerText = "Opt In";
        btnSaveSpaced.className = "bg-primary text-on-primary font-bold px-lg py-3 rounded-xl hover:bg-primary-container hover:scale-[1.02] active:scale-95 transition-all text-sm whitespace-nowrap";
    }

    showScreen('screen-playing');
    renderPlayQuestion();
    renderOverviewPanel();

    if (voiceModeActive) {
        speakQuestionCurrent();
    }
}

// Render active playing question
function renderPlayQuestion() {
    const q = quizQuestions[currentQuestionIndex];
    
    document.getElementById('playing-progress-text').innerText = `Question ${currentQuestionIndex + 1} of ${quizQuestions.length}`;
    
    const percentage = Math.round((currentQuestionIndex / quizQuestions.length) * 100);
    document.getElementById('playing-percent-text').innerText = `${percentage}% Completed`;
    document.getElementById('playing-progress-bar').style.width = `${percentage}%`;

    document.getElementById('playing-question-text').innerText = q.questionPrompt;

    const optionsGrid = document.getElementById('playing-options-grid');
    optionsGrid.innerHTML = "";

    const isTextQuestion = !q.choicesPool || q.choicesPool.length === 0 || q.type === 'short-answer' || q.type === 'essay';

    if (isTextQuestion) {
        // Render a text box for essay or short-answer question types
        const wrapper = document.createElement('div');
        wrapper.className = "col-span-2 w-full";
        const placeholderText = q.type === 'essay' 
            ? "Write your detailed essay answer here..." 
            : "Type your short answer here...";
        wrapper.innerHTML = `
            <textarea id="playing-text-answer" class="w-full p-md border border-outline-variant rounded-xl focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none text-on-background bg-white font-body-md" rows="5" placeholder="${placeholderText}"></textarea>
        `;
        optionsGrid.appendChild(wrapper);

        const textarea = wrapper.querySelector('textarea');
        textarea.value = userAnswers[currentQuestionIndex] || "";
        textarea.addEventListener('input', (e) => {
            userAnswers[currentQuestionIndex] = e.target.value;
            renderOverviewPanel();
        });
    } else {
        // Render MCQ options
        q.choicesPool.forEach((choice, index) => {
            const optChar = String.fromCharCode(65 + index);
            const card = document.createElement('div');
            
            const isSelected = userAnswers[currentQuestionIndex] === choice;
            
            card.className = `option-card group relative p-md border rounded-xl bg-white hover:bg-surface-container-low cursor-pointer flex items-center gap-md ${isSelected ? 'option-selected' : 'border-outline-variant/50'}`;
            card.innerHTML = `
                <div class="w-10 h-10 rounded-lg flex items-center justify-center font-bold transition-colors ${isSelected ? 'bg-primary-container text-on-primary-container' : 'bg-surface-container-highest group-hover:bg-primary-container group-hover:text-on-primary-container'}">${optChar}</div>
                <p class="font-body-md text-body-md">${escapeHtml(choice)}</p>
            `;
            
            card.addEventListener('click', () => {
                userAnswers[currentQuestionIndex] = choice;
                renderPlayQuestion();
                renderOverviewPanel();
            });
            
            optionsGrid.appendChild(card);
        });
    }

    // Render confidence selector dynamically below the options grid
    let confContainer = document.getElementById('playing-confidence-container');
    if (!confContainer) {
        confContainer = document.createElement('div');
        confContainer.id = 'playing-confidence-container';
        confContainer.className = 'mt-lg border-t border-outline-variant/30 pt-md w-full col-span-2';
        optionsGrid.parentNode.insertBefore(confContainer, optionsGrid.nextSibling);
    }

    const activeConf = userConfidences[currentQuestionIndex] || "medium";
    confContainer.innerHTML = `
        <label class="block font-label-md text-label-md font-bold mb-xs text-on-surface-variant uppercase tracking-wider">YOUR CONFIDENCE LEVEL</label>
        <div class="flex gap-md mt-sm">
            ${["low", "medium", "high"].map(level => {
                const isActive = activeConf === level;
                const btnClass = isActive 
                    ? 'bg-primary text-on-primary border-primary' 
                    : 'bg-white text-on-surface border-outline-variant hover:bg-surface-container-low';
                return `
                    <button class="flex-1 py-2.5 px-md border rounded-xl font-label-md text-center transition-all active:scale-95 confidence-btn ${btnClass}" data-level="${level}">
                        ${level.toUpperCase()}
                    </button>
                `;
            }).join('')}
        </div>
    `;

    confContainer.querySelectorAll('.confidence-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const level = btn.getAttribute('data-level');
            userConfidences[currentQuestionIndex] = level;
            renderPlayQuestion();
        });
    });

    // Navigation buttons toggle
    const prevBtn = document.getElementById('btn-prev-question');
    const nextBtn = document.getElementById('btn-next-question');

    prevBtn.disabled = currentQuestionIndex === 0;
    if (currentQuestionIndex === 0) {
        prevBtn.classList.add('opacity-50', 'cursor-not-allowed');
    } else {
        prevBtn.classList.remove('opacity-50', 'cursor-not-allowed');
    }

    if (currentQuestionIndex === quizQuestions.length - 1) {
        nextBtn.innerHTML = `Submit Quiz <span class="material-symbols-outlined">check_circle</span>`;
        nextBtn.classList.replace('bg-primary', 'bg-error');
        nextBtn.classList.replace('text-on-primary', 'text-on-error');
    } else {
        nextBtn.innerHTML = `Next Question <span class="material-symbols-outlined">arrow_forward</span>`;
        nextBtn.classList.replace('bg-error', 'bg-primary');
        nextBtn.classList.replace('text-on-error', 'text-on-primary');
    }
}

// Question Overview sidebar panel
function renderOverviewPanel() {
    const grid = document.getElementById('playing-questions-overview-grid');
    grid.innerHTML = "";

    quizQuestions.forEach((q, index) => {
        const item = document.createElement('div');
        const isAnswered = userAnswers[index] !== undefined;
        const isActive = index === currentQuestionIndex;
        
        item.className = `aspect-square rounded-lg flex items-center justify-center font-label-md cursor-pointer transition-all border `;
        if (isActive) {
            item.className += "border-primary font-bold text-primary ring-2 ring-primary ring-offset-2 bg-primary-container/20";
        } else if (isAnswered) {
            item.className += "border-primary bg-primary-container text-on-primary-container";
        } else {
            item.className += "border-outline-variant text-on-surface-variant hover:bg-surface-container-low";
        }
        
        item.innerText = (index + 1).toString().padStart(2, '0');
        item.addEventListener('click', () => {
            currentQuestionIndex = index;
            renderPlayQuestion();
            renderOverviewPanel();
        });
        grid.appendChild(item);
    });
}

function handlePrevQuestion() {
    if (currentQuestionIndex > 0) {
        currentQuestionIndex--;
        renderPlayQuestion();
        renderOverviewPanel();
    }
}

function handleNextQuestion() {
    if (currentQuestionIndex === quizQuestions.length - 1) {
        // Submit Quiz
        if (userAnswers.length < quizQuestions.length) {
            const unanswered = quizQuestions.map((_, i) => i + 1).filter(i => !userAnswers[i - 1]);
            if (!confirm(`You have unanswered questions (Question ${unanswered.join(', ')}). Submit anyway?`)) {
                return;
            }
        }
        submitQuizResults();
    } else {
        currentQuestionIndex++;
        renderPlayQuestion();
        renderOverviewPanel();
    }
}

// Submit results
function submitQuizResults() {
    if (timerInterval) clearInterval(timerInterval);

    const totalTimeSec = Math.floor((new Date() - quizStartTime) / 1000);
    const mins = Math.floor(totalTimeSec / 60);
    const secs = totalTimeSec % 60;
    const timeTakenStr = `${mins.toString().padStart(2, '0')}m ${secs.toString().padStart(2, '0')}s`;

    let correctCount = 0;
    const answersPayload = quizQuestions.map((q, index) => {
        const playerAns = (userAnswers[index] || "").trim();
        const correctAns = (q.correctAnswer || "").trim();
        const isCorrect = playerAns !== "" && playerAns.toLowerCase() === correctAns.toLowerCase();
        if (isCorrect) {
            correctCount++;
        }
        return {
            questionIndex: index,
            questionPrompt: q.questionPrompt,
            correctAnswer: q.correctAnswer,
            playerAnswer: playerAns,
            correct: isCorrect,
            confidence: userConfidences[index] || "medium",
            difficulty: q.difficulty || "medium",
            hintsUsed: 0
        };
    });

    const scorePercentage = Math.round((correctCount / quizQuestions.length) * 100);

    const resultPayload = {
        quizCode: sharedQuizCode || "LOCAL",
        playerName: getPlayerName(),
        score: correctCount,
        totalQuestions: quizQuestions.length,
        answers: answersPayload
    };

    if (!navigator.onLine) {
        queueOfflineResult(resultPayload);
        document.getElementById('results-calibration-score').innerText = "Offline";
        document.getElementById('results-confidence-score').innerText = "Offline";
    } else {
        // Save result to backend
        fetch(`${API_BASE}/save-result`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(resultPayload)
        })
        .then(res => res.json())
        .then(data => {
            console.log("Result saved:", data);
            if (data.calibrationScore !== null && data.calibrationScore !== undefined) {
                document.getElementById('results-calibration-score').innerText = `${data.calibrationScore}%`;
            } else {
                document.getElementById('results-calibration-score').innerText = "-";
            }
            if (data.confidenceScore !== null && data.confidenceScore !== undefined) {
                document.getElementById('results-confidence-score').innerText = `${data.confidenceScore} pts`;
            } else {
                document.getElementById('results-confidence-score').innerText = "-";
            }
        })
        .catch(err => {
            console.error("Could not save result to server:", err);
            queueOfflineResult(resultPayload);
            document.getElementById('results-calibration-score').innerText = "Queued";
            document.getElementById('results-confidence-score').innerText = "Queued";
        });
    }

    // Show Results Screen
    showScreen('screen-results');

    // Trigger confetti
    createConfetti();

    // Populate Results info
    document.getElementById('results-score-display').innerText = `0%`;
    document.getElementById('results-correct-count').innerText = correctCount;
    document.getElementById('results-wrong-count').innerText = quizQuestions.length - correctCount;
    document.getElementById('results-time-taken').innerText = timeTakenStr;
    document.getElementById('results-total-questions').innerText = quizQuestions.length;

    // Headline and badge config
    let badge = "Knowledge Seeker";
    let headline = "Good effort on the evaluation!";
    if (scorePercentage === 100) {
        badge = "Grandmaster of QuizGen";
        headline = "Perfect score! Outstanding achievement!";
    } else if (scorePercentage >= 80) {
        badge = "Architect of Wisdom";
        headline = "Incredible Performance! You've mastered this quiz!";
    } else if (scorePercentage >= 50) {
        badge = "Knowledge Scholar";
        headline = "Good job! You have passed the quiz assessment.";
    }
    document.getElementById('results-badge-title').innerText = badge;
    document.getElementById('results-headline').innerText = headline;

    // Animate Score circle ring
    setTimeout(() => {
        animateScoreIndicator(scorePercentage);
    }, 400);

    // Render Answer Review Breakdown
    renderAnswerReview();

    // Render Session Leaderboard
    loadSessionLeaderboard();
}

// Confetti Effect
function createConfetti() {
    const root = document.getElementById('confetti-root');
    root.innerHTML = "";
    const colors = ['#4f46e5', '#3525cd', '#00687a', '#ff9800', '#f44336'];
    
    for (let i = 0; i < 80; i++) {
        const confetti = document.createElement('div');
        confetti.className = 'confetti-piece';
        
        const size = Math.random() * 8 + 6 + 'px';
        confetti.style.width = size;
        confetti.style.height = size;
        confetti.style.left = Math.random() * 100 + 'vw';
        confetti.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
        confetti.style.animationDuration = (Math.random() * 2 + 1.5) + 's';
        confetti.style.animationDelay = (Math.random() * 1.5) + 's';
        confetti.style.opacity = Math.random();
        confetti.style.borderRadius = Math.random() > 0.5 ? '50%' : '2px';
        
        root.appendChild(confetti);
        
        confetti.addEventListener('animationend', () => {
            confetti.remove();
        });
    }
}

// Circle Animation
function animateScoreIndicator(targetScore) {
    const circle = document.getElementById('score-circle-indicator');
    const text = document.getElementById('results-score-display');
    const radius = 110;
    const circumference = 2 * Math.PI * radius;
    
    const duration = 1500;
    const start = performance.now();

    function update(now) {
        const elapsed = now - start;
        const progress = Math.min(elapsed / duration, 1);
        
        // Easing out
        const ease = 1 - Math.pow(1 - progress, 3);
        const currentScore = Math.floor(ease * targetScore);
        
        text.textContent = currentScore + '%';
        const offset = circumference - (ease * targetScore / 100) * circumference;
        circle.style.strokeDashoffset = offset;
        
        if (progress < 1) {
            requestAnimationFrame(update);
        }
    }
    
    requestAnimationFrame(update);
}

// Render review details
function renderAnswerReview() {
    const container = document.getElementById('results-review-container');
    container.innerHTML = "";

    if (quizQuestions.length === 0) {
        container.innerHTML = "<p class='text-on-surface-variant text-center py-4'>No questions to review.</p>";
        return;
    }

    quizQuestions.forEach((q, index) => {
        const answer = (userAnswers[index] || "").trim();
        const correctAnswer = (q.correctAnswer || "").trim();
        const isCorrect = answer !== "" && answer.toLowerCase() === correctAnswer.toLowerCase();

        const answerBadge = answer
            ? `<span class="badge ${isCorrect ? 'badge-success' : 'badge-error'}">${escapeHtml(answer)}</span>`
            : `<span class="badge badge-neutral">Unanswered</span>`;

        const item = document.createElement('div');
        item.className = 'review-item border border-outline-variant/30 bg-surface/50 rounded-xl p-md';
        item.innerHTML = `
            <div class="review-q font-semibold text-on-surface mb-2">${index + 1}. ${escapeHtml(q.questionPrompt)}</div>
            <div class="review-ans font-body-sm text-body-sm flex flex-col gap-1.5">
                <div><strong>Your Selection:</strong> ${answerBadge}</div>
                ${!isCorrect && correctAnswer ? `<div><strong>Correct Answer:</strong> <span class="badge badge-success">${escapeHtml(correctAnswer)}</span></div>` : ''}
                ${q.explanation ? `<div class="text-on-surface-variant"><strong>Why:</strong> ${escapeHtml(q.explanation)}</div>` : ''}
            </div>
        `;
        container.appendChild(item);
    });
}

// Leaderboard Loading
function loadSessionLeaderboard() {
    const container = document.getElementById('results-leaderboard-container');
    container.innerHTML = "<p class='text-on-surface-variant text-center py-4'>Loading leaderboard...</p>";

    const code = sharedQuizCode || "LOCAL";

    fetch(`${API_BASE}/leaderboard/${code}`)
    .then(res => res.json())
    .then(data => {
        container.innerHTML = "";
        if (data.length === 0) {
            container.innerHTML = "<p class='text-on-surface-variant text-center py-4'>No leaderboard results for this session yet.</p>";
            return;
        }

        data.forEach((p, index) => {
            const row = document.createElement('div');
            const isUser = p.playerName === playerName;
            row.className = `flex items-center justify-between p-md border-b border-outline-variant/20 ${isUser ? 'bg-primary/5 rounded-xl font-bold border' : ''}`;
            
            let rankBadge = `${index + 1}`;
            if (index === 0) rankBadge = "🥇";
            else if (index === 1) rankBadge = "🥈";
            else if (index === 2) rankBadge = "🥉";

            row.innerHTML = `
                <div class="flex items-center gap-md">
                    <span class="w-8 text-center font-bold text-headline-md">${rankBadge}</span>
                    <span class="text-on-surface">${escapeHtml(p.playerName)}</span>
                </div>
                <div class="text-right text-primary">${p.score} / ${p.totalQuestions}</div>
            `;
            container.appendChild(row);
        });
    })
    .catch(err => {
        container.innerHTML = "<p class='text-error text-center py-4'>Could not load leaderboard data.</p>";
        console.error(err);
    });
}

// Join Quiz form submit
function handleJoinQuizSubmit(e) {
    clearError();
    const code = document.getElementById('join-quiz-code').value.toUpperCase().trim();
    const name = document.getElementById('join-player-name').value.trim();

    if (!code) {
        alert("Please enter a Quiz Code.");
        return;
    }
    if (!name) {
        alert("Please enter your name.");
        return;
    }

    const btn = document.getElementById('btn-submit-join');
    const originalText = btn.innerHTML;
    btn.innerHTML = `<span class="material-symbols-outlined animate-spin">progress_activity</span> Joining...`;
    btn.disabled = true;

    fetch(`${API_BASE}/quiz/${code}`)
    .then(res => {
        if (!res.ok) throw new Error("Quiz not found on server");
        return res.json();
    })
    .then(data => {
        btn.innerHTML = originalText;
        btn.disabled = false;

        if (!data.questions || data.questions.length === 0) {
            alert("No questions found in this quiz.");
            return;
        }

        quizQuestions = data.questions;
        sharedQuizCode = code;
        setPlayerName(name);

        // Transition to Quiz Playing Screen
        startQuizPlay();
    })
    .catch(err => {
        btn.innerHTML = originalText;
        btn.disabled = false;
        alert("Quiz not found or network connection failed.");
        console.error(err);
    });
}

// Load shared quiz from URL query parameters
function loadSharedQuizFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const quizCodeParam = params.get('quiz');
    if (quizCodeParam) {
        document.getElementById('join-quiz-code').value = quizCodeParam;
        showScreen('screen-join');
    }
}

// Share Quiz URL link generator
function shareQuiz() {
    if (!sharedQuizCode) {
        alert("Play or save a quiz on the server before sharing.");
        return;
    }

    const quizLink = `${window.location.origin}${window.location.pathname}?quiz=${sharedQuizCode}`;

    if (navigator.share) {
        navigator.share({
            title: "QuizGen AI Shared Quiz Session",
            text: `Join my live QuizGen session using code: ${sharedQuizCode}`,
            url: quizLink
        });
    } else {
        navigator.clipboard.writeText(quizLink)
        .then(() => {
            alert("Quiz link copied to clipboard:\n\n" + quizLink);
        })
        .catch(err => {
            alert("Link: " + quizLink);
        });
    }
}

// Download PDF document logic
function downloadQuizPDF() {
    if (!quizQuestions || quizQuestions.length === 0) {
        alert("No quiz available to download.");
        return;
    }

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF();
    let y = 20;

    pdf.setFontSize(16);
    pdf.text("QuizGen AI Generated Assessment", 10, y);
    y += 15;
    pdf.setFontSize(11);

    quizQuestions.forEach((q, index) => {
        let questionText = `${index + 1}. ${q.questionPrompt}`;
        let questionLines = pdf.splitTextToSize(questionText, 180);

        if (y + questionLines.length * 6 > 280) {
            pdf.addPage();
            y = 20;
        }

        pdf.text(questionLines, 10, y);
        y += questionLines.length * 6;

        (q.choicesPool || []).forEach((choice) => {
            let optionLines = pdf.splitTextToSize("- " + choice, 170);
            if (y + optionLines.length * 6 > 280) {
                pdf.addPage();
                y = 20;
            }
            pdf.text(optionLines, 15, y);
            y += optionLines.length * 6;
        });

        y += 8;
    });

    y += 10;
    if (y > 260) {
        pdf.addPage();
        y = 20;
    }

    pdf.setFontSize(16);
    pdf.text("Answer Key Sheet", 10, y);
    y += 15;
    pdf.setFontSize(11);

    quizQuestions.forEach((q, index) => {
        if (y > 280) {
            pdf.addPage();
            y = 20;
        }
        let answer = `${index + 1}. Correct Answer Option: ${q.correctAnswer}`;
        let lines = pdf.splitTextToSize(answer, 180);
        pdf.text(lines, 10, y);
        y += lines.length * 6;
    });

    pdf.save(`QuizGen_${sharedQuizCode || "local"}.pdf`);
}

// Load Quiz History from database
function loadQuizHistory() {
    const grid = document.getElementById('history-list-grid');
    const emptyState = document.getElementById('history-empty-state');
    
    grid.innerHTML = "<p class='text-on-surface-variant text-center py-10 col-span-3'>Loading history...</p>";
    emptyState.classList.add('hidden');
    grid.classList.remove('hidden');

    fetch(`${API_BASE}/quiz-history`)
    .then(res => res.json())
    .then(quizzes => {
        grid.innerHTML = "";
        
        if (quizzes.length === 0) {
            grid.classList.add('hidden');
            emptyState.classList.remove('hidden');
            emptyState.classList.add('flex');
            return;
        }

        quizzes.forEach((quiz) => {
            const card = document.createElement('article');
            card.className = "quiz-card-hover bg-surface-container-lowest rounded-xl border border-outline-variant/30 flex flex-col h-full overflow-hidden";
            
            const dateStr = new Date(quiz.createdAt).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
                year: 'numeric'
            });

            card.innerHTML = `
                <div class="p-lg flex-1">
                    <div class="flex justify-between items-start mb-md">
                        <span class="bg-secondary-container text-on-secondary-container px-3 py-1 rounded-full text-label-sm font-label-sm uppercase tracking-wider">General</span>
                        <span class="text-outline font-label-sm text-label-sm">#${quiz.quizCode}</span>
                    </div>
                    <h3 class="font-headline-md text-headline-md text-on-surface mb-2 line-clamp-2">AI Quiz Assessment</h3>
                    <div class="flex flex-wrap gap-md mt-4 text-on-surface-variant">
                        <div class="flex items-center gap-1.5 font-label-md text-label-md">
                            <span class="material-symbols-outlined text-[18px]">format_list_bulleted</span>
                            ${quiz.questions.length} Questions
                        </div>
                        <div class="flex items-center gap-1.5 font-label-md text-label-md">
                            <span class="material-symbols-outlined text-[18px]">calendar_today</span>
                            ${dateStr}
                        </div>
                    </div>
                </div>
                <div class="bg-surface-container-low p-md flex gap-md border-t border-outline-variant/20">
                    <button class="flex-1 bg-primary/10 text-primary hover:bg-primary hover:text-on-primary py-2 rounded-lg font-label-md transition-all active:scale-95 flex items-center justify-center gap-2 play-history-btn" data-code="${quiz.quizCode}">
                        <span class="material-symbols-outlined text-[18px]">visibility</span>
                        Play Quiz
                    </button>
                    <button class="px-3 py-2 text-error hover:bg-error-container/50 rounded-lg transition-all active:scale-95 flex items-center justify-center delete-history-btn" data-code="${quiz.quizCode}">
                        <span class="material-symbols-outlined text-[20px]">delete</span>
                    </button>
                </div>
            `;
            grid.appendChild(card);
        });

        // Click listeners
        grid.querySelectorAll('.play-history-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const code = btn.getAttribute('data-code');
                loadQuizByCodeAndPlay(code);
            });
        });

        grid.querySelectorAll('.delete-history-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const code = btn.getAttribute('data-code');
                if (confirm(`Are you sure you want to delete quiz #${code}?`)) {
                    deleteQuizByCode(code);
                }
            });
        });
    })
    .catch(err => {
        grid.innerHTML = "<p class='text-error text-center py-10 col-span-3'>Unable to load quiz history.</p>";
        console.error(err);
    });
}

function loadQuizByCodeAndPlay(code) {
    fetch(`${API_BASE}/quiz/${code}`)
    .then(res => res.json())
    .then(data => {
        if (!data.questions || data.questions.length === 0) {
            alert("No questions found in this quiz.");
            return;
        }

        quizQuestions = data.questions;
        sharedQuizCode = code;
        getPlayerName();
        startQuizPlay();
    })
    .catch(err => {
        alert("Failed to retrieve quiz.");
        console.error(err);
    });
}

function deleteQuizByCode(code) {
    fetch(`${API_BASE}/quiz/${code}`, {
        method: "DELETE"
    })
    .then(res => res.json())
    .then(data => {
        loadQuizHistory();
    })
    .catch(err => {
        alert("Could not delete quiz from server.");
        console.error(err);
    });
}

function regenerateQuizCurrent() {
    if (!uploadedText) return;
    const questionCountInput = quizQuestions.length || 5;
    const targetLanguage = document.getElementById('target-language')?.value || "English";
    const questionType = document.getElementById('question-type')?.value || "multiple-choice";
    const difficulty = document.getElementById('question-difficulty')?.value || "medium";
    const useAI = document.getElementById('use-ai-toggle') ? document.getElementById('use-ai-toggle').checked : true;
    
    const container = document.getElementById('review-mcqs-container');
    container.innerHTML = "<p class='text-on-surface-variant text-center py-12'>Regenerating quiz questions...</p>";

    fetch(`${API_BASE}/generate-quiz`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            text: uploadedText,
            count: questionCountInput,
            language: targetLanguage,
            questionType: questionType,
            difficulty: difficulty,
            useAI: useAI
        })
    })
    .then(res => res.json())
    .then(data => {
        if (data.error) {
            alert(data.error);
            renderReviewQuestions();
            return;
        }
        quizQuestions = data.questions;
        renderReviewQuestions();
    })
    .catch(err => {
        alert("Failed to regenerate quiz.");
        renderReviewQuestions();
        console.error(err);
    });
}

// Utility: Escape HTML text to prevent XSS issues
function escapeHtml(text) {
    if (!text) return "";
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function loadGlobalLeaderboard() {
    const tbody = document.getElementById('global-leaderboard-tbody');
    const emptyState = document.getElementById('global-leaderboard-empty');
    const podium = document.getElementById('global-leaderboard-podium');
    const tableContainer = document.getElementById('global-leaderboard-table-container');

    tbody.innerHTML = "<tr><td colspan='4' class='text-on-surface-variant text-center py-10'>Loading leaderboard...</td></tr>";
    emptyState.classList.add('hidden');
    podium.classList.remove('hidden');
    tableContainer.classList.remove('hidden');

    fetch(`${API_BASE}/leaderboard/GLOBAL`)
    .then(res => res.json())
    .then(data => {
        tbody.innerHTML = "";

        if (!data || data.length === 0) {
            podium.classList.add('hidden');
            tableContainer.classList.add('hidden');
            emptyState.classList.remove('hidden');
            emptyState.classList.add('flex');
            return;
        }

        // Top 3 Podium players
        const top3 = data.slice(0, 3);
        const remaining = data.slice(3);

        // Reset/Set Podium 1
        if (top3[0]) {
            document.getElementById('podium-1-container').style.opacity = '1';
            document.getElementById('podium-name-1').innerText = top3[0].playerName;
            document.getElementById('podium-score-1').innerText = `${top3[0].score} / ${top3[0].totalQuestions} pts`;
            document.getElementById('podium-avatar-1').innerHTML = `<span class="text-amber-600 font-bold">${getInitials(top3[0].playerName)}</span>`;
        } else {
            document.getElementById('podium-1-container').style.opacity = '0.3';
            document.getElementById('podium-name-1').innerText = "Winner";
            document.getElementById('podium-score-1').innerText = "-";
            document.getElementById('podium-avatar-1').innerHTML = "1";
        }

        // Reset/Set Podium 2
        if (top3[1]) {
            document.getElementById('podium-2-container').style.opacity = '1';
            document.getElementById('podium-name-2').innerText = top3[1].playerName;
            document.getElementById('podium-score-2').innerText = `${top3[1].score} / ${top3[1].totalQuestions} pts`;
            document.getElementById('podium-avatar-2').innerHTML = `<span class="text-slate-600 font-bold">${getInitials(top3[1].playerName)}</span>`;
        } else {
            document.getElementById('podium-2-container').style.opacity = '0.3';
            document.getElementById('podium-name-2').innerText = "Second Place";
            document.getElementById('podium-score-2').innerText = "-";
            document.getElementById('podium-avatar-2').innerHTML = "2";
        }

        // Reset/Set Podium 3
        if (top3[2]) {
            document.getElementById('podium-3-container').style.opacity = '1';
            document.getElementById('podium-name-3').innerText = top3[2].playerName;
            document.getElementById('podium-score-3').innerText = `${top3[2].score} / ${top3[2].totalQuestions} pts`;
            document.getElementById('podium-avatar-3').innerHTML = `<span class="text-orange-600 font-bold">${getInitials(top3[2].playerName)}</span>`;
        } else {
            document.getElementById('podium-3-container').style.opacity = '0.3';
            document.getElementById('podium-name-3').innerText = "Third Place";
            document.getElementById('podium-score-3').innerText = "-";
            document.getElementById('podium-avatar-3').innerHTML = "3";
        }

        // Populate remaining table
        if (remaining.length === 0) {
            tbody.innerHTML = "<tr><td colspan='4' class='text-on-surface-variant text-center py-6 text-body-sm'>No other rankings yet</td></tr>";
        } else {
            remaining.forEach((p, index) => {
                const row = document.createElement('tr');
                row.className = "hover:bg-surface-container-low transition-colors";
                row.innerHTML = `
                    <td class="px-lg py-md text-center font-bold text-on-surface-variant">${index + 4}</td>
                    <td class="px-lg py-md font-semibold text-on-surface">${escapeHtml(p.playerName)}</td>
                    <td class="px-lg py-md text-on-surface-variant font-mono text-sm">#${escapeHtml(p.quizCode)}</td>
                    <td class="px-lg py-md text-right font-bold text-primary">${p.score} / ${p.totalQuestions}</td>
                `;
                tbody.appendChild(row);
            });
        }
    })
    .catch(err => {
        tbody.innerHTML = "<tr><td colspan='4' class='text-error text-center py-10'>Unable to fetch global leaderboard</td></tr>";
        console.error(err);
    });
}

function getInitials(name) {
    if (!name) return "?";
    return name.split(/\s+/).map(n => n[0]).join('').substring(0, 2).toUpperCase();
}

// ─── Voice Mode Accessibility Support ──────────────────────────────────────────

let voiceModeActive = false;
let speechRecognition = null;

function toggleVoiceMode() {
    voiceModeActive = !voiceModeActive;
    const icon = document.getElementById('voice-icon');
    const text = document.getElementById('voice-text');
    const btn = document.getElementById('btn-voice-toggle');

    if (voiceModeActive) {
        icon.textContent = 'mic';
        if (text) text.textContent = 'Voice Mode ON';
        btn.classList.add('border-primary', 'text-primary', 'bg-primary/5');
        speakQuestionCurrent();
        startSpeechListening();
    } else {
        icon.textContent = 'mic_off';
        if (text) text.textContent = 'Voice Mode OFF';
        btn.classList.remove('border-primary', 'text-primary', 'bg-primary/5');
        stopVoiceMode();
    }
}

function stopVoiceMode() {
    if (window.speechSynthesis) {
        window.speechSynthesis.cancel();
    }
    if (speechRecognition) {
        try {
            speechRecognition.stop();
        } catch (e) {}
    }
}

function speakText(msgText, callback) {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(msgText);
    if (callback) {
        utterance.onend = callback;
    }
    window.speechSynthesis.speak(utterance);
}

function speakQuestionCurrent() {
    if (!voiceModeActive || !quizQuestions[currentQuestionIndex]) return;
    const q = quizQuestions[currentQuestionIndex];
    let speechString = `Question ${currentQuestionIndex + 1}. ${q.questionPrompt}. `;
    if (q.choicesPool && q.choicesPool.length > 0) {
        speechString += "Your options are: ";
        q.choicesPool.forEach((choice, index) => {
            const letter = String.fromCharCode(65 + index);
            speechString += `Option ${letter}: ${choice}. `;
        });
        speechString += "Please speak your selected option, for example option A.";
    } else {
        speechString += "This is a text question. Please say your answer.";
    }

    speakText(speechString, () => {
        // Start listening after speaking finishes
        startSpeechListening();
    });
}

function startSpeechListening() {
    if (!voiceModeActive) return;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        console.warn("Speech recognition is not supported in this browser.");
        return;
    }

    if (!speechRecognition) {
        speechRecognition = new SpeechRecognition();
        speechRecognition.continuous = false;
        speechRecognition.interimResults = false;
        speechRecognition.lang = document.getElementById('target-language')?.value === "Spanish" ? "es-ES" : "en-US";

        speechRecognition.onresult = (event) => {
            const resultText = event.results[0][0].transcript.trim().toLowerCase();
            console.log("Speech heard:", resultText);
            handleSpokenInput(resultText);
        };

        speechRecognition.onend = () => {
            // Automatically restart listening if voice mode is still active
            if (voiceModeActive && !window.speechSynthesis.speaking) {
                try {
                    speechRecognition.start();
                } catch (e) {}
            }
        };

        speechRecognition.onerror = (e) => {
            console.warn("Speech error:", e.error);
        };
    }

    try {
        speechRecognition.start();
    } catch (e) {}
}

function handleSpokenInput(input) {
    const q = quizQuestions[currentQuestionIndex];
    if (!q) return;

    // Check navigation keywords
    if (input.includes("next") || input.includes("siguiente") || input.includes("submit") || input.includes("enviar")) {
        handleNextQuestion();
        setTimeout(() => speakQuestionCurrent(), 600);
        return;
    }
    if (input.includes("previous") || input.includes("back") || input.includes("anterior") || input.includes("atrás")) {
        handlePrevQuestion();
        setTimeout(() => speakQuestionCurrent(), 600);
        return;
    }

    const isTextQuestion = !q.choicesPool || q.choicesPool.length === 0 || q.type === 'short-answer' || q.type === 'essay';

    if (isTextQuestion) {
        // Populate input area
        const textarea = document.getElementById('playing-text-answer');
        if (textarea) {
            const currentVal = userAnswers[currentQuestionIndex] || "";
            userAnswers[currentQuestionIndex] = currentVal ? `${currentVal} ${input}` : input;
            textarea.value = userAnswers[currentQuestionIndex];
            renderOverviewPanel();
            speakText("Spoken answer appended.");
        }
    } else {
        // Option selection
        let matchedIndex = -1;
        
        // Match option letter
        const matchLetterRegex = /\boption\s+([a-d])\b|^\s*([a-d])\s*$/i;
        const match = input.match(matchLetterRegex);
        if (match) {
            const letter = (match[1] || match[2]).toUpperCase();
            matchedIndex = letter.charCodeAt(0) - 65;
        } else {
            // Try to match option text content
            q.choicesPool.forEach((choice, index) => {
                if (input.includes(choice.toLowerCase()) || choice.toLowerCase().includes(input)) {
                    matchedIndex = index;
                }
            });
        }

        if (matchedIndex >= 0 && matchedIndex < q.choicesPool.length) {
            const selection = q.choicesPool[matchedIndex];
            userAnswers[currentQuestionIndex] = selection;
            renderPlayQuestion();
            renderOverviewPanel();
            
            const letter = String.fromCharCode(65 + matchedIndex);
            speakText(`Selected option ${letter}: ${selection}. Say next to continue.`);
        } else {
            speakText("Sorry, I didn't recognize that option. Please try again.");
        }
    }
}

// ─── Offline PWA Sync Support ──────────────────────────────────────────────────

function queueOfflineResult(payload) {
    let queue = [];
    try {
        queue = JSON.parse(localStorage.getItem("offlineQuizResultsQueue")) || [];
    } catch (e) {
        queue = [];
    }
    queue.push(payload);
    localStorage.setItem("offlineQuizResultsQueue", JSON.stringify(queue));
    showOfflineAlert("Quiz completed offline! Result saved locally. It will sync automatically when your internet connection is restored.");
}

async function syncOfflineResults() {
    if (!navigator.onLine) return;
    let queue = [];
    try {
        queue = JSON.parse(localStorage.getItem("offlineQuizResultsQueue")) || [];
    } catch (e) {
        return;
    }
    if (queue.length === 0) return;

    console.log(`[Offline Sync] Syncing ${queue.length} offline results...`);
    const successfulSyncs = [];

    for (const payload of queue) {
        try {
            const response = await fetch(`${API_BASE}/save-result`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
            if (response.ok) {
                successfulSyncs.push(payload);
            }
        } catch (err) {
            console.error("[Offline Sync] Failed to upload result", err);
            break; // Stop and retry later if network fails again
        }
    }

    // Filter out successful syncs
    const remaining = queue.filter(item => !successfulSyncs.includes(item));
    localStorage.setItem("offlineQuizResultsQueue", JSON.stringify(remaining));

    if (successfulSyncs.length > 0) {
        showOfflineAlert(`Successfully synced ${successfulSyncs.length} offline quiz results to the leaderboard!`, true);
        if (typeof fetchLeaderboard === "function") {
            fetchLeaderboard("GLOBAL");
        }
    }
}

function showOfflineAlert(message, isSuccess = false) {
    const alertDiv = document.createElement("div");
    alertDiv.className = `fixed bottom-4 right-4 z-50 px-lg py-md rounded-premium shadow-lg font-body-md text-sm transition-all duration-300 max-w-sm ${
        isSuccess ? "bg-emerald-100 text-emerald-950 border border-emerald-300" : "bg-amber-100 text-amber-950 border border-amber-300"
    }`;
    alertDiv.style.opacity = "0";
    alertDiv.style.transform = "translateY(20px)";
    alertDiv.innerText = message;
    document.body.appendChild(alertDiv);

    // Fade in
    setTimeout(() => {
        alertDiv.style.opacity = "1";
        alertDiv.style.transform = "translateY(0)";
    }, 100);

    // Fade out after 5 seconds
    setTimeout(() => {
        alertDiv.style.opacity = "0";
        alertDiv.style.transform = "translateY(20px)";
        setTimeout(() => alertDiv.remove(), 300);
    }, 5000);
}

// Register service worker and load offline synchronization listeners
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(reg => console.log('[PWA] Service Worker registered with scope:', reg.scope))
            .catch(err => console.warn('[PWA] Service Worker registration failed:', err));
    });
}

window.addEventListener('online', syncOfflineResults);
window.addEventListener('load', syncOfflineResults);

async function handleSpacedRepetitionOptIn() {
    const emailInput = document.getElementById('spaced-rep-email');
    const email = emailInput ? emailInput.value.trim() : "";
    const btn = document.getElementById('btn-save-spaced-rep');

    if (!email) {
        alert("Please enter a valid email address.");
        return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        alert("Please enter a valid email format.");
        return;
    }

    btn.disabled = true;
    btn.innerText = "Opting In...";

    try {
        const quizCodeToUse = sharedQuizCode || "LOCAL";
        const response = await fetch(`${API_BASE}/quiz/${quizCodeToUse}/spaced-repetition-opt-in`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, playerName: playerName || "Guest" })
        });
        const data = await response.json();
        if (response.ok) {
            btn.innerText = "Opted In ✓";
            btn.className = "bg-emerald-600 text-white font-bold px-lg py-3 rounded-xl cursor-default text-sm whitespace-nowrap";
            emailInput.disabled = true;
        } else {
            btn.disabled = false;
            btn.innerText = "Opt In";
            alert(data.error || "Failed to opt in. Try again.");
        }
    } catch (err) {
        btn.disabled = false;
        btn.innerText = "Opt In";
        console.error(err);
        alert("Failed to connect to backend server.");
    }
}

window.loadStarterPack = async function(code) {
    clearError();
    let name = document.getElementById('player-name')?.value.trim() || readStoredPlayerName();
    if (!name) {
        name = prompt("Please enter your name to play this template:", "Guest");
        if (!name) return;
    }
    setPlayerName(name);

    try {
        const response = await fetch(`${API_BASE}/starter-packs`);
        if (!response.ok) throw new Error("Could not fetch starter packs.");
        const packs = await response.json();
        const pack = packs.find(p => p.quizCode === code);
        if (!pack) {
            alert("Starter pack not found.");
            return;
        }

        quizQuestions = pack.questions;
        sharedQuizCode = pack.quizCode;

        startQuizPlay();
    } catch (err) {
        console.error(err);
        alert("Failed to load starter pack quiz. Connection issue.");
    }
};

// ─── Study Assistant Premium Suite (v7) ──────────────────────────────────────

const PLAYER_NAME_STORAGE_KEY = "quizgenPlayerName";

function readStoredPlayerName() {
    try {
        return (localStorage.getItem(PLAYER_NAME_STORAGE_KEY) || "").trim();
    } catch (e) {
        return "";
    }
}

// Records the name the player identified themselves with, from any entry point
// (host form, join form or starter pack prompt) and keeps the inputs in sync.
function setPlayerName(name) {
    const clean = (name || "").trim();
    if (!clean) return playerName;

    playerName = clean;
    try {
        localStorage.setItem(PLAYER_NAME_STORAGE_KEY, clean);
    } catch (e) { /* storage unavailable, keep the in-memory value */ }

    const hostInput = document.getElementById('player-name');
    if (hostInput && hostInput.value.trim() !== clean) hostInput.value = clean;

    return playerName;
}

function getPlayerName() {
    const typed = document.getElementById('player-name')?.value.trim();
    if (typed) {
        setPlayerName(typed);
    } else if (!playerName) {
        playerName = readStoredPlayerName() || "Guest";
    }
    return playerName;
}

// ─── 1. Notes Editor ─────────────────────────────────────────────────────────

window.loadNotes = async function() {
    getPlayerName();
    try {
        const res = await fetch(`${API_BASE}/notes?player=${encodeURIComponent(playerName)}`);
        if (!res.ok) throw new Error();
        const notes = await res.json();
        
        const listContainer = document.getElementById('notes-list-container');
        listContainer.innerHTML = "";
        
        if (notes.length === 0) {
            listContainer.innerHTML = `<p class="text-xs text-outline text-center py-4">No notes created yet.</p>`;
            newNote();
            return;
        }

        notes.forEach(note => {
            const div = document.createElement('div');
            div.className = `p-sm border rounded-xl cursor-pointer hover:bg-slate-50 transition-colors text-left ${activeNoteId === note.noteId ? 'border-primary bg-indigo-50/50' : 'border-outline-variant/30'}`;
            div.onclick = () => loadSpecificNote(note.noteId, notes);
            div.innerHTML = `
                <h4 class="font-bold text-sm text-on-surface truncate">${note.title || "Untitled Note"}</h4>
                <p class="text-[10px] text-outline">${new Date(note.updatedAt).toLocaleDateString()}</p>
            `;
            listContainer.appendChild(div);
        });

        if (activeNoteId && notes.some(n => n.noteId === activeNoteId)) {
            const cur = notes.find(n => n.noteId === activeNoteId);
            document.getElementById('note-title-input').value = cur.title;
            document.getElementById('note-content-input').value = cur.content;
        } else {
            loadSpecificNote(notes[0].noteId, notes);
        }
    } catch (e) {
        console.error("Failed to load notes");
    }
};

window.loadSpecificNote = function(id, notesArray) {
    activeNoteId = id;
    const note = notesArray.find(n => n.noteId === id);
    if (note) {
        document.getElementById('note-title-input').value = note.title;
        document.getElementById('note-content-input').value = note.content;
        document.getElementById('note-status-text').innerText = "Saved";
        
        document.querySelectorAll('#notes-list-container > div').forEach((div, idx) => {
            if (notesArray[idx] && notesArray[idx].noteId === id) {
                div.className = "p-sm border rounded-xl cursor-pointer hover:bg-slate-50 transition-colors text-left border-primary bg-indigo-50/50";
            } else {
                div.className = "p-sm border rounded-xl cursor-pointer hover:bg-slate-50 transition-colors text-left border-outline-variant/30";
            }
        });
    }
};

window.newNote = function() {
    activeNoteId = null;
    document.getElementById('note-title-input').value = "";
    document.getElementById('note-content-input').value = "";
    document.getElementById('note-status-text').innerText = "New Draft";
    document.querySelectorAll('#notes-list-container > div').forEach(div => {
        div.className = "p-sm border rounded-xl cursor-pointer hover:bg-slate-50 transition-colors text-left border-outline-variant/30";
    });
};

window.triggerNoteAutoSave = function() {
    document.getElementById('note-status-text').innerText = "Saving...";
    if (noteAutoSaveTimeout) clearTimeout(noteAutoSaveTimeout);
    noteAutoSaveTimeout = setTimeout(saveActiveNote, 1500);
};

window.saveActiveNote = async function() {
    getPlayerName();
    const title = document.getElementById('note-title-input').value.trim() || "Untitled Note";
    const content = document.getElementById('note-content-input').value;

    try {
        const response = await fetch(`${API_BASE}/notes`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                noteId: activeNoteId,
                title,
                content,
                playerName
            })
        });
        const data = await response.json();
        if (response.ok) {
            activeNoteId = data.noteId;
            document.getElementById('note-status-text').innerText = "Saved ✓";
            
            const res = await fetch(`${API_BASE}/notes?player=${encodeURIComponent(playerName)}`);
            const notes = await res.json();
            const listContainer = document.getElementById('notes-list-container');
            listContainer.innerHTML = "";
            notes.forEach(note => {
                const div = document.createElement('div');
                div.className = `p-sm border rounded-xl cursor-pointer hover:bg-slate-50 transition-colors text-left ${activeNoteId === note.noteId ? 'border-primary bg-indigo-50/50' : 'border-outline-variant/30'}`;
                div.onclick = () => loadSpecificNote(note.noteId, notes);
                div.innerHTML = `
                    <h4 class="font-bold text-sm text-on-surface truncate">${note.title || "Untitled Note"}</h4>
                    <p class="text-[10px] text-outline">${new Date(note.updatedAt).toLocaleDateString()}</p>
                `;
                listContainer.appendChild(div);
            });
        }
    } catch (e) {
        document.getElementById('note-status-text').innerText = "Error Saving";
    }
};

window.deleteActiveNote = async function() {
    if (!activeNoteId) {
        newNote();
        return;
    }
    if (!confirm("Are you sure you want to delete this note?")) return;
    try {
        const response = await fetch(`${API_BASE}/notes/${activeNoteId}`, { method: "DELETE" });
        if (response.ok) {
            activeNoteId = null;
            newNote();
            loadNotes();
        }
    } catch (e) {
        alert("Deletion failed.");
    }
};

window.generateQuizFromActiveNote = async function() {
    if (!activeNoteId) {
        alert("Please write and save your note first!");
        return;
    }
    await saveActiveNote();

    showError("Generating quiz from notes...");
    try {
        const response = await fetch(`${API_BASE}/generate-quiz`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                noteId: activeNoteId,
                count: 5,
                useAI: true,
                questionType: "multiple-choice",
                difficulty: "medium"
            })
        });
        const data = await response.json();
        if (response.ok) {
            clearError();
            quizQuestions = data.questions;
            sharedQuizCode = data.quizCode || "LOCAL";
            startQuizPlay();
        } else {
            showError(data.error || "Failed to generate quiz.");
        }
    } catch (e) {
        showError("Failed to connect to generator endpoint.");
    }
};

// ─── 2. Flashcards (SM-2 review) ──────────────────────────────────────────────

window.loadFlashcards = async function() {
    getPlayerName();
    try {
        const libRes = await fetch(`${API_BASE}/library?player=${encodeURIComponent(playerName)}`);
        const libDocs = await libRes.json();
        
        const select = document.getElementById('fc-source-select');
        select.innerHTML = "";
        
        if (libDocs.length === 0) {
            select.innerHTML = `<option value="">-- No documents in library --</option>`;
        } else {
            libDocs.forEach(d => {
                select.innerHTML += `<option value="${d.documentId}">${d.title}</option>`;
            });
        }

        const res = await fetch(`${API_BASE}/flashcards?player=${encodeURIComponent(playerName)}`);
        const fcData = await res.json();
        
        document.getElementById('fc-total-count').innerText = fcData.totalCards || 0;
        document.getElementById('fc-due-count').innerText = fcData.dueCardsCount || 0;

        currentFlashcards = fcData.dueCards || [];
        currentFlashcardIndex = 0;

        if (currentFlashcards.length > 0) {
            document.getElementById('fc-review-area').classList.remove('hidden');
            document.getElementById('fc-empty-reviews').classList.add('hidden');
            renderFlashcard();
        } else {
            document.getElementById('fc-review-area').classList.add('hidden');
            document.getElementById('fc-empty-reviews').classList.remove('hidden');
        }
    } catch (e) {
        console.error("Flashcards loading failure");
    }
};

window.renderFlashcard = function() {
    const card = currentFlashcards[currentFlashcardIndex];
    if (card) {
        document.getElementById('fc-front-text').innerText = card.front;
        document.getElementById('fc-back-text').innerText = card.back;
        
        document.getElementById('fc-card-front').style.transform = "rotateY(0deg)";
        document.getElementById('fc-card-back').style.transform = "rotateY(180deg)";
    }
};

window.flipFlashcard = function() {
    const front = document.getElementById('fc-card-front');
    const back = document.getElementById('fc-card-back');
    const isFlipped = back.style.transform === "rotateY(0deg)";
    
    front.style.transform = isFlipped ? "rotateY(0deg)" : "rotateY(-180deg)";
    back.style.transform = isFlipped ? "rotateY(180deg)" : "rotateY(0deg)";
};

window.generateFlashcardsFromLibrary = async function() {
    getPlayerName();
    const docId = document.getElementById('fc-source-select').value;
    const count = parseInt(document.getElementById('fc-count-input').value) || 5;

    if (!docId) {
        alert("Please upload a document to your library first!");
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/generate-flashcards`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                documentId: docId,
                count,
                playerName
            })
        });
        if (response.ok) {
            alert("Flashcards generated successfully!");
            loadFlashcards();
        } else {
            const err = await response.json();
            alert(err.error || "Generation failed.");
        }
    } catch (e) {
        alert("Connection issue.");
    }
};

window.submitFlashcardReview = async function(quality) {
    const card = currentFlashcards[currentFlashcardIndex];
    if (!card) return;

    try {
        const response = await fetch(`${API_BASE}/flashcards/${card.cardId}/review`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ quality })
        });
        if (response.ok) {
            currentFlashcardIndex++;
            if (currentFlashcardIndex < currentFlashcards.length) {
                renderFlashcard();
            } else {
                alert("Review session complete!");
                loadFlashcards();
            }
        }
    } catch (e) {
        alert("Recall review submission failed.");
    }
};

// ─── 3. Personal Reference Library ─────────────────────────────────────────────

window.loadLibrary = function() {
    getPlayerName();
    renderLibraryItems();
};

window.renderLibraryItems = async function() {
    getPlayerName();
    const query = document.getElementById('library-search-input').value.toLowerCase().trim();

    try {
        const res = await fetch(`${API_BASE}/library?player=${encodeURIComponent(playerName)}`);
        const docs = await res.json();
        
        const container = document.getElementById('library-grid-container');
        container.innerHTML = "";

        const filtered = docs.filter(d => {
            return d.title.toLowerCase().includes(query) || 
                   d.tags.some(t => t.toLowerCase().includes(query)) ||
                   d.filename.toLowerCase().includes(query);
        });

        if (filtered.length === 0) {
            document.getElementById('library-empty-state').classList.remove('hidden');
            return;
        }
        document.getElementById('library-empty-state').classList.add('hidden');

        filtered.forEach(doc => {
            const div = document.createElement('div');
            div.className = "bg-white border border-outline-variant/30 rounded-2xl p-lg shadow-sm flex flex-col justify-between text-left";
            const tagsSpan = doc.tags.map(t => `<span class="px-2 py-0.5 bg-indigo-50 text-indigo-700 text-xs font-semibold rounded-full">${t}</span>`).join(" ");
            
            div.innerHTML = `
                <div>
                    <div class="flex justify-between items-start mb-sm">
                        <span class="text-2xl">${doc.sourceType === 'pdf' ? '📕' : doc.sourceType === 'docx' ? '📘' : '📝'}</span>
                        <span class="text-xs text-outline">${new Date(doc.createdAt).toLocaleDateString()}</span>
                    </div>
                    <h4 class="font-headline-sm text-headline-sm text-on-surface mb-2 truncate">${doc.title}</h4>
                    <p class="text-xs text-on-surface-variant mb-md">${(doc.textLength / 1024).toFixed(1)} KB &bull; ${doc.imagesCount} Images</p>
                    <div class="flex flex-wrap gap-xs mb-lg">
                        ${tagsSpan || '<span class="text-[10px] text-outline">No tags</span>'}
                    </div>
                </div>
                <div class="flex gap-sm border-t border-outline-variant/20 pt-md">
                    <button onclick="editLibraryTags('${doc.documentId}', '${doc.tags.join(",")}')" class="flex-grow bg-surface border border-outline-variant text-on-surface-variant hover:bg-surface-container-high py-2 rounded-xl text-xs font-semibold transition-all">Tags</button>
                    <button onclick="generateQuizFromLibrary('${doc.documentId}')" class="flex-grow bg-primary text-on-primary hover:bg-primary-container py-2 rounded-xl text-xs font-bold transition-all">Play Quiz</button>
                    <button onclick="deleteLibraryDoc('${doc.documentId}')" class="bg-rose-50 hover:bg-rose-100 text-rose-600 px-3 py-2 rounded-xl text-xs transition-all"><span class="material-symbols-outlined text-[16px] block">delete</span></button>
                </div>
            `;
            container.appendChild(div);
        });
    } catch (e) {
        console.error("Library render failure");
    }
};

window.editLibraryTags = async function(id, existingTagsStr) {
    const raw = prompt("Enter tags separated by commas:", existingTagsStr);
    if (raw === null) return;
    const tags = raw.split(",").map(t => t.trim()).filter(Boolean);

    try {
        const response = await fetch(`${API_BASE}/library/${id}/tags`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tags })
        });
        if (response.ok) {
            renderLibraryItems();
        }
    } catch (e) {
        alert("Failed to update tags.");
    }
};

window.deleteLibraryDoc = async function(id) {
    if (!confirm("Are you sure you want to delete this document from your library?")) return;
    try {
        const response = await fetch(`${API_BASE}/library/${id}`, { method: "DELETE" });
        if (response.ok) {
            renderLibraryItems();
        }
    } catch (e) {
        alert("Deletion failed.");
    }
};

window.generateQuizFromLibrary = async function(id) {
    showError("Generating quiz from library...");
    try {
        const response = await fetch(`${API_BASE}/generate-quiz`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                documentId: id,
                count: 5,
                useAI: true,
                questionType: "multiple-choice",
                difficulty: "medium"
            })
        });
        const data = await response.json();
        if (response.ok) {
            clearError();
            quizQuestions = data.questions;
            sharedQuizCode = data.quizCode || "LOCAL";
            startQuizPlay();
        } else {
            showError(data.error || "Failed to generate quiz.");
        }
    } catch (e) {
        showError("Failed to connect to generator.");
    }
};

// ─── 4. Study Planner ─────────────────────────────────────────────────────────

window.loadPlanner = async function() {
    getPlayerName();
    try {
        const libRes = await fetch(`${API_BASE}/library?player=${encodeURIComponent(playerName)}`);
        const libDocs = await libRes.json();
        
        const container = document.getElementById('planner-docs-checkboxes');
        container.innerHTML = "";
        
        if (libDocs.length === 0) {
            container.innerHTML = `<p class="text-xs text-outline p-2">Upload study notes first.</p>`;
        } else {
            libDocs.forEach(d => {
                container.innerHTML += `
                    <label class="flex items-center gap-2 text-xs font-semibold cursor-pointer">
                        <input type="checkbox" name="plan-docs" value="${d.documentId}" class="rounded border-outline-variant">
                        <span>${d.title}</span>
                    </label>
                `;
            });
        }

        const res = await fetch(`${API_BASE}/study-plans?player=${encodeURIComponent(playerName)}`);
        const plans = await res.json();
        
        if (plans.length > 0) {
            document.getElementById('planner-active-plan').classList.remove('hidden');
            const plan = plans[0];
            document.getElementById('planner-active-title').innerText = plan.examName;
            document.getElementById('planner-active-date').innerText = `Exam Date: ${new Date(plan.examDate).toLocaleDateString()}`;
            
            const list = document.getElementById('planner-schedule-list');
            list.innerHTML = "";
            
            plan.schedule.forEach(item => {
                const div = document.createElement('div');
                div.className = `p-md border rounded-xl flex items-center justify-between shadow-sm bg-white ${item.completed ? 'opacity-60 border-slate-200' : 'border-outline-variant/30'}`;
                div.innerHTML = `
                    <div>
                        <p class="text-xs font-bold text-primary">${new Date(item.date).toLocaleDateString()}</p>
                        <p class="font-headline-sm text-sm text-on-surface font-semibold">${item.docTitle}</p>
                    </div>
                    <div>
                        ${item.completed ? '<span class="text-xs font-bold text-emerald-600 px-3 py-1 bg-emerald-50 rounded-full">✓ Completed</span>' : `<button onclick="togglePlannerTask('${plan.planId}', '${item.documentId}', '${item.date}')" class="px-3 py-1.5 bg-primary text-on-primary hover:bg-primary-container font-bold text-xs rounded-lg transition-all">Mark Read</button>`}
                    </div>
                `;
                list.appendChild(div);
            });
        } else {
            document.getElementById('planner-active-plan').classList.add('hidden');
        }
    } catch (e) {
        console.error("Planner loading failure");
    }
};

window.createStudyPlan = async function() {
    getPlayerName();
    const examName = document.getElementById('plan-exam-name').value.trim();
    const examDate = document.getElementById('plan-exam-date').value;
    
    const checkboxes = document.querySelectorAll('input[name="plan-docs"]:checked');
    const documentIds = Array.from(checkboxes).map(cb => cb.value);

    if (!examName || !examDate || documentIds.length === 0) {
        alert("Please fill in the exam subject, date, and check at least one study material.");
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/study-plans`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                playerName,
                examName,
                examDate,
                documentIds
            })
        });
        if (response.ok) {
            alert("Spaced-repetition study planner calendar generated!");
            loadPlanner();
        } else {
            const err = await response.json();
            alert(err.error || "Failed to create planner.");
        }
    } catch (e) {
        alert("Connection failure.");
    }
};

window.togglePlannerTask = async function(planId, documentId, date) {
    try {
        const response = await fetch(`${API_BASE}/study-plans/${planId}/complete-day`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ documentId, date })
        });
        if (response.ok) {
            loadPlanner();
        }
    } catch (e) {
        alert("Failed to update task.");
    }
};

// ─── 5. Collaborative Study Groups ────────────────────────────────────────────

window.loadGroups = async function() {
    getPlayerName();
    try {
        const res = await fetch(`${API_BASE}/groups?player=${encodeURIComponent(playerName)}`);
        const groups = await res.json();
        
        const container = document.getElementById('group-list-container');
        container.innerHTML = "";
        
        if (groups.length === 0) {
            container.innerHTML = `<p class="text-xs text-outline py-4 col-span-3 text-center">You are not in any study groups yet.</p>`;
            return;
        }

        groups.forEach(g => {
            const div = document.createElement('div');
            div.className = "bg-white border border-outline-variant/30 p-lg rounded-2xl shadow-sm text-left hover:scale-[1.01] transition-transform cursor-pointer";
            div.onclick = () => openGroup(g.groupId);
            div.innerHTML = `
                <h4 class="font-headline-sm text-headline-sm text-on-surface mb-xs truncate">${g.name}</h4>
                <p class="text-[10px] text-outline uppercase tracking-wider mb-sm">Code: ${g.joinCode}</p>
                <p class="text-xs text-on-surface-variant">${g.members.length} Members &bull; ${g.sharedQuizzes.length} Shared Quizzes</p>
            `;
            container.appendChild(div);
        });
    } catch (e) {
        console.error("Groups loading failure");
    }
};

window.createStudyGroup = async function() {
    getPlayerName();
    const name = document.getElementById('group-create-name').value.trim();
    if (!name) {
        alert("Enter a group name!");
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/groups`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, ownerName: playerName })
        });
        if (response.ok) {
            document.getElementById('group-create-name').value = "";
            alert("Study group created successfully!");
            loadGroups();
        }
    } catch (e) {
        alert("Group creation failed.");
    }
};

window.joinStudyGroup = async function() {
    getPlayerName();
    const joinCode = document.getElementById('group-join-code').value.trim();
    if (!joinCode) {
        alert("Enter the six-letter invite code!");
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/groups/join`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ playerName, joinCode })
        });
        if (response.ok) {
            document.getElementById('group-join-code').value = "";
            alert("Joined group successfully!");
            loadGroups();
        } else {
            const err = await response.json();
            alert(err.error || "Invalid join code.");
        }
    } catch (e) {
        alert("Connection failure.");
    }
};

window.openGroup = async function(groupId) {
    activeGroupId = groupId;
    getPlayerName();

    try {
        document.getElementById('group-join-create-row').classList.add('hidden');
        document.getElementById('group-selector-panel').classList.add('hidden');
        document.getElementById('group-detail-view').classList.remove('hidden');

        const res = await fetch(`${API_BASE}/groups?player=${encodeURIComponent(playerName)}`);
        const groups = await res.json();
        const group = groups.find(g => g.groupId === groupId);

        if (!group) return;

        document.getElementById('group-title').innerText = group.name;
        document.getElementById('group-code-label').innerText = group.joinCode;

        const quizList = document.getElementById('group-shared-quizzes-list');
        quizList.innerHTML = "";
        if (group.sharedQuizzes.length === 0) {
            quizList.innerHTML = `<p class="text-xs text-outline py-2">No shared materials. Start a quiz and click 'Share with group' to add one!</p>`;
        } else {
            group.sharedQuizzes.forEach(code => {
                quizList.innerHTML += `
                    <div class="flex justify-between items-center bg-white p-sm border border-outline-variant/30 rounded-xl">
                        <span class="text-xs font-bold text-indigo-600 font-mono">Quiz #${code}</span>
                        <button onclick="playSharedQuiz('${code}')" class="px-3 py-1 bg-primary text-on-primary hover:bg-primary-container font-bold text-[10px] rounded-lg transition-all">Play Now</button>
                    </div>
                `;
            });
        }

        const feedList = document.getElementById('group-activity-list');
        feedList.innerHTML = "";
        group.activityFeed.slice(-15).reverse().forEach(log => {
            feedList.innerHTML += `
                <div class="text-[11px] text-on-surface-variant flex justify-between items-start border-b border-outline-variant/20 pb-xs">
                    <span>${log.message}</span>
                    <span class="text-[9px] text-outline">${new Date(log.createdAt).toLocaleTimeString()}</span>
                </div>
            `;
        });

        const lbRes = await fetch(`${API_BASE}/groups/${groupId}/leaderboard`);
        const lbData = await lbRes.json();
        
        const lbList = document.getElementById('group-leaderboard-list');
        lbList.innerHTML = "";
        lbData.forEach((mem, index) => {
            lbList.innerHTML += `
                <div class="flex justify-between items-center bg-white p-sm border border-outline-variant/30 rounded-xl">
                    <div class="flex items-center gap-2">
                        <span class="w-5 h-5 rounded-full ${index===0 ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-700'} flex items-center justify-center text-[10px] font-bold">${index+1}</span>
                        <span class="text-xs font-semibold text-on-surface">${mem.playerName}</span>
                    </div>
                    <div class="text-right">
                        <p class="text-xs font-bold text-primary">${mem.averageScorePct}%</p>
                        <p class="text-[9px] text-outline">${mem.attempts} Plays</p>
                    </div>
                </div>
            `;
        });
    } catch (e) {
        console.error("Open group detail error");
    }
};

window.playSharedQuiz = async function(code) {
    clearError();
    try {
        const response = await fetch(`${API_BASE}/quiz/${code}`);
        if (!response.ok) throw new Error();
        const data = await response.json();
        quizQuestions = data.questions;
        sharedQuizCode = data.quizCode;
        startQuizPlay();
    } catch (e) {
        alert("Failed to load shared group quiz. Route/ID invalid.");
    }
};

window.closeGroupView = function() {
    activeGroupId = null;
    document.getElementById('group-join-create-row').classList.remove('hidden');
    document.getElementById('group-selector-panel').classList.remove('hidden');
    document.getElementById('group-detail-view').classList.add('hidden');
    loadGroups();
};

window.shareQuizWithGroup = async function() {
    if (!sharedQuizCode) {
        alert("Play a quiz first before trying to share!");
        return;
    }
    getPlayerName();
    
    try {
        const res = await fetch(`${API_BASE}/groups?player=${encodeURIComponent(playerName)}`);
        const groups = await res.json();
        if (groups.length === 0) {
            alert("You are not in any study groups! Join one first.");
            return;
        }

        const names = groups.map((g, i) => `${i+1}. ${g.name} (Code: ${g.joinCode})`).join("\n");
        const sel = prompt(`Select Group to share Quiz #${sharedQuizCode} into:\n\n${names}`, "1");
        if (sel === null) return;
        
        const idx = parseInt(sel) - 1;
        if (groups[idx]) {
            const response = await fetch(`${API_BASE}/groups/${groups[idx].groupId}/share-quiz`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ quizCode: sharedQuizCode, playerName })
            });
            if (response.ok) {
                alert(`Quiz #${sharedQuizCode} shared successfully with group ${groups[idx].name}!`);
            }
        }
    } catch (e) {
        alert("Failed to share quiz.");
    }
};

// ─── 6. Progress Report Transcript ────────────────────────────────────────────

window.loadProgress = async function() {
    getPlayerName();
    try {
        const res = await fetch(`${API_BASE}/user/${encodeURIComponent(playerName)}/progress`);
        const data = await res.json();

        document.getElementById('prog-total-played').innerText = data.totalQuizzesPlayed || 0;
        document.getElementById('prog-avg-score').innerText = `${data.averageScorePct || 0}%`;
        document.getElementById('prog-time-spent').innerText = `${data.totalStudyTimeMinutes || 0} Mins`;

        const tbody = document.getElementById('prog-trend-table-body');
        tbody.innerHTML = "";
        
        if (data.scoreTrend.length === 0) {
            tbody.innerHTML = `<tr><td colspan="3" class="text-center py-4 text-outline text-xs">No study records yet.</td></tr>`;
            return;
        }

        data.scoreTrend.reverse().forEach(attempt => {
            tbody.innerHTML += `
                <tr class="hover:bg-slate-50 transition-colors">
                    <td class="px-lg py-3 font-mono font-bold text-indigo-600 text-sm">#${attempt.quizCode}</td>
                    <td class="px-lg py-3 text-sm font-semibold">${attempt.scorePct}%</td>
                    <td class="px-lg py-3 text-right text-xs text-outline">${new Date(attempt.date).toLocaleDateString()}</td>
                </tr>
            `;
        });
    } catch (e) {
        console.error("Progress tracker load failure");
    }
};

window.exportProgressReport = function() {
    getPlayerName();
    window.location.href = `${API_BASE}/user/${encodeURIComponent(playerName)}/progress/export`;
};

// ─── 7. Concept Explanation ───────────────────────────────────────────────────

window.explainCurrentConcept = async function() {
    const q = quizQuestions[currentQuestionIndex];
    if (!q) return;

    const modal = document.getElementById('explain-concept-modal');
    const content = document.getElementById('explain-modal-content');
    
    modal.classList.remove('hidden');
    content.innerText = "Consulting Claude for explanation...";

    try {
        const response = await fetch(`${API_BASE}/explain-concept`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                questionPrompt: q.questionPrompt,
                correctAnswer: q.correctAnswer
            })
        });
        if (response.ok) {
            const data = await response.json();
            content.innerText = data.explanation;
        } else {
            content.innerText = "Could not fetch explanation details.";
        }
    } catch (e) {
        content.innerText = "Connection issue occurred while explaining concept.";
    }
};

window.closeConceptExplanation = function() {
    document.getElementById('explain-concept-modal').classList.add('hidden');
};
