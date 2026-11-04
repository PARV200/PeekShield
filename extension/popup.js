// ─────────────────────────────────────────────────────────────
// PEEKSHIELD — Popup Controller Script
// ─────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  const connPill = document.getElementById("connection-status-pill");
  const connText = document.getElementById("conn-text");
  const riskCard = document.getElementById("risk-card");
  const riskValue = document.getElementById("risk-value");
  const riskDesc = document.getElementById("risk-desc");
  const btnPanic = document.getElementById("btn-popup-panic");
  const btnPanicText = document.getElementById("btn-panic-text");

  const checkboxes = {
    cards: document.getElementById("cat-cards"),
    passwords: document.getElementById("cat-passwords"),
    emails: document.getElementById("cat-emails"),
    phones: document.getElementById("cat-phones"),
    otps: document.getElementById("cat-otps"),
    chat: document.getElementById("cat-chat"),
  };

  let isPanicActive = false;

  function updateUI(status) {
    if (!status) return;

    // Connection indicator
    if (status.connected) {
      connPill.className = "status-pill status-connected";
      connText.textContent = "AI Engine Active";
    } else {
      connPill.className = "status-pill status-disconnected";
      connText.textContent = "AI Standby";
    }

    const state = status.state || {};
    isPanicActive = !!state.panicActive;

    // Risk card
    if (isPanicActive) {
      riskCard.className = "risk-card risk-high";
      riskValue.textContent = "CRITICAL (PANIC)";
      riskDesc.textContent = "Panic Privacy Mode is manually or gesture-activated.";
      btnPanic.classList.add("active");
      btnPanicText.textContent = "DEACTIVATE PANIC";
    } else if (state.strangerDetected) {
      riskCard.className = "risk-card risk-high";
      riskValue.textContent = "HIGH RISK ⚠️";
      riskDesc.textContent = "Unknown person detected near screen. Blur active.";
      btnPanic.classList.remove("active");
      btnPanicText.textContent = "ACTIVATE PANIC MODE";
    } else {
      riskCard.className = "risk-card";
      riskValue.textContent = "LOW RISK ✓";
      riskDesc.textContent = "No unauthorized observers. Browsing is safe.";
      btnPanic.classList.remove("active");
      btnPanicText.textContent = "ACTIVATE PANIC MODE";
    }

    // Category checkboxes
    if (state.categories) {
      for (const [key, cb] of Object.entries(checkboxes)) {
        if (cb && state.categories[key] !== undefined) {
          cb.checked = state.categories[key];
        }
      }
    }
  }

  // Request status from background worker
  try {
    chrome.runtime.sendMessage({ action: "GET_EXTENSION_STATUS" }, (res) => {
      if (res) updateUI(res);
    });
  } catch (e) {}

  // Panic button toggle
  btnPanic.addEventListener("click", () => {
    isPanicActive = !isPanicActive;
    chrome.runtime.sendMessage({ action: "SET_MANUAL_PANIC", enabled: isPanicActive }, () => {
      chrome.runtime.sendMessage({ action: "GET_EXTENSION_STATUS" }, (res) => {
        if (res) updateUI(res);
      });
    });
  });

  // Checkbox change handlers
  for (const [key, cb] of Object.entries(checkboxes)) {
    if (cb) {
      cb.addEventListener("change", () => {
        const categories = {};
        for (const [k, box] of Object.entries(checkboxes)) {
          categories[k] = box.checked;
        }
        chrome.runtime.sendMessage({ action: "UPDATE_CATEGORIES", categories });
      });
    }
  }
});

