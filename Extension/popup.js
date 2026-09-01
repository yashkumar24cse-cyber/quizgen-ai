document.addEventListener("DOMContentLoaded", () => {
  const setupScreen = document.getElementById("setup-screen");
  const playScreen = document.getElementById("play-screen");
  const resultsScreen = document.getElementById("results-screen");

  const apiBaseInput = document.getElementById("api-base");
  const textInput = document.getElementById("highlighted-text");
  const countInput = document.getElementById("q-count");
  const typeInput = document.getElementById("q-type");

  const btnGenerate = document.getElementById("btn-generate");
  const btnRestart = document.getElementById("btn-restart");
  const btnNext = document.getElementById("btn-next");
  const btnResetSetup = document.getElementById("btn-reset-setup");

  const errorBox = document.getElementById("error-box");
  const successBox = document.getElementById("success-box");

  const progressText = document.getElementById("progress-text");
  const promptText = document.getElementById("prompt-text");
  const optionsContainer = document.getElementById("options-container");
  const scoreText = document.getElementById("score-text");

  let quizQuestions = [];
  let currentIdx = 0;
  let score = 0;

  // 1. Load saved preferences
  chrome.storage.local.get(["selectedText", "apiBase"], (result) => {
    if (result.selectedText) {
      textInput.value = result.selectedText;
      // Clear selection so it doesn't persist forever
      chrome.storage.local.remove("selectedText");
    }
    if (result.apiBase) {
      apiBaseInput.value = result.apiBase;
    }
  });

  // Save API Base when changed
  apiBaseInput.addEventListener("change", () => {
    chrome.storage.local.set({ apiBase: apiBaseInput.value.trim() });
  });

  // 2. Generate Quiz Handler
  btnGenerate.addEventListener("click", () => {
    hideError();
    const apiBase = apiBaseInput.value.trim() || "http://localhost:5000";
    const text = textInput.value.trim();
    const count = parseInt(countInput.value, 10) || 5;
    const type = typeInput.value;

    if (!text) {
      showError("Please enter or highlight some text first.");
      return;
    }

    btnGenerate.disabled = true;
    btnGenerate.innerText = "Generating Quiz...";

    fetch(`${apiBase}/generate-quiz`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: text,
        count: count,
        questionType: type
      })
    })
    .then(res => {
      if (!res.ok) {
        return res.json().then(e => { throw new Error(e.error || "Generation failed."); });
      }
      return res.json();
    })
    .then(data => {
      btnGenerate.disabled = false;
      btnGenerate.innerText = "Generate Quiz";

      if (!data.questions || data.questions.length === 0) {
        showError("No questions returned from server.");
        return;
      }

      quizQuestions = data.questions;
      startQuiz();
    })
    .catch(err => {
      btnGenerate.disabled = false;
      btnGenerate.innerText = "Generate Quiz";
      showError(err.message || "Failed to connect to backend server.");
    });
  });

  function startQuiz() {
    currentIdx = 0;
    score = 0;
    setupScreen.classList.add("hidden");
    playScreen.classList.remove("hidden");
    resultsScreen.classList.add("hidden");
    renderQuestion();
  }

  function renderQuestion() {
    btnNext.classList.add("hidden");
    const q = quizQuestions[currentIdx];
    progressText.innerText = `Question ${currentIdx + 1} of ${quizQuestions.length}`;
    promptText.innerText = q.questionPrompt;
    optionsContainer.innerHTML = "";

    const choices = q.choicesPool || ["True", "False"];
    choices.forEach(choice => {
      const btn = document.createElement("button");
      btn.className = "option-btn";
      btn.innerText = choice;
      btn.addEventListener("click", () => {
        // Grade immediate feedback
        const correct = choice.trim().toLowerCase() === q.correctAnswer.trim().toLowerCase();
        
        // Disable other options
        optionsContainer.querySelectorAll("button").forEach(b => {
          b.disabled = true;
          if (b.innerText.trim().toLowerCase() === q.correctAnswer.trim().toLowerCase()) {
            b.classList.add("correct");
          } else if (b.innerText === choice) {
            b.classList.add("wrong");
          }
        });

        if (correct) {
          score++;
        }

        btnNext.classList.remove("hidden");
      });
      optionsContainer.appendChild(btn);
    });
  }

  btnNext.addEventListener("click", () => {
    currentIdx++;
    if (currentIdx < quizQuestions.length) {
      renderQuestion();
    } else {
      finishQuiz();
    }
  });

  function finishQuiz() {
    playScreen.classList.add("hidden");
    resultsScreen.classList.remove("hidden");
    scoreText.innerText = `You scored ${score} out of ${quizQuestions.length} correct!`;
  }

  btnRestart.addEventListener("click", () => {
    playScreen.classList.add("hidden");
    setupScreen.classList.remove("hidden");
  });

  btnResetSetup.addEventListener("click", () => {
    resultsScreen.classList.add("hidden");
    setupScreen.classList.remove("hidden");
  });

  // UI helpers
  function showError(msg) {
    errorBox.innerText = msg;
    errorBox.classList.remove("hidden");
  }
  function hideError() {
    errorBox.classList.add("hidden");
  }
});
