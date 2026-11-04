// ─────────────────────────────────────────────────────────────
// PEEKSHIELD — Content Script (Smart Sensitive Information Scanner & Frosted Blur)
// 100% Client-Side Local Processing
// Detects OTPs, Passwords, Banking, Cards, Gmail, SMS, Chats & PII
// ─────────────────────────────────────────────────────────────

(() => {
  "use strict";

  // Prevent multiple injections
  if (window.__peekshield_injected__) return;
  window.__peekshield_injected__ = true;

  // ── Configuration & State ──────────────────────────────────
  const state = {
    privacyRisk: "SAFE",      // "SAFE" | "MEDIUM" | "HIGH" | "CRITICAL"
    isStrangerPresent: false,
    isPanicActive: false,
    blurActive: false,
    blurIntensity: 14,
    categories: {
      cards: true,
      bankAccounts: true,
      passwords: true,
      otps: true,
      emails: true,
      phones: true,
      chat: true,
      messages: true,
      pii: true,
    },
    hoverPeekAllowed: false,
    currentProfile: "GENERAL",
  };

  // Automatically adapt categories & sensitivity based on active website profile
  if (typeof resolveProfileForUrl === "function") {
    const matchedProfile = resolveProfileForUrl(window.location.href);
    if (matchedProfile) {
      state.categories = { ...state.categories, ...matchedProfile.categories };
      state.blurIntensity = matchedProfile.blurIntensity || 14;
      state.currentProfile = matchedProfile.id;
    }
  }

  // ── Regular Expression Patterns (Stateless, No /g flag for .test) ──
  const PATTERNS = {
    // Standard Email addresses
    email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/i,

    // US & International phone numbers
    phone: /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/,

    // 16-digit credit/debit card numbers with dashes or spaces + 15-digit Amex
    card: /\b(?:\d{4}[ -]?){3}\d{4}\b|\b3[47]\d{2}[ -]?\d{6}[ -]?\d{5}\b/,

    // Bank Account numbers & IBAN
    bankAccount: /\b(?:(?:Account|Acc|A\/C|Acct)\s*(?:#|No|Number)?\s*[:.-]?\s*)\d{8,17}\b/i,
    routingNumber: /\b(?:(?:Routing|ABA|RTN)\s*(?:#|No|Number)?\s*[:.-]?\s*)\d{9}\b/i,
    iban: /\b[A-Z]{2}\d{2}[A-Z0-9]{4}\d{7}([A-Z0-9]?){0,16}\b/i,

    // Financial balance amounts
    balance: /(?:Balance|Available|Total|Due|Transfer|Payment)\s*[:.-]?\s*[\$€£₹]\s*[\d,]+(?:\.\d{2})?/i,

    // 4 to 8 digit OTP / 2FA verification codes
    otp: /\b(?<![#$])\d{4,8}\b(?!\d)/,

    // API Keys and secret tokens (OpenAI, GitHub, Google AIza, Bearer tokens, JWT)
    token: /\b(?:sk-proj-[0-9a-zA-Z_-]{20,}|sk_live_[0-9a-zA-Z]{20,}|ghp_[0-9a-zA-Z]{36}|AIza[0-9A-Za-z-_]{35}|Bearer\s+[a-zA-Z0-9_\-\.]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/,

    // US SSN / National Identification Numbers
    ssn: /\b\d{3}-\d{2}-\d{4}\b/,
  };

  // ── Contextual Cues for OTP & Verification Codes ───────────
  const OTP_CONTEXT_KEYWORDS = [
    "otp", "code", "verification", "verify", "pin", "passcode",
    "one-time", "2fa", "mfa", "auth", "security code", "authenticator", "valid for", "expires in"
  ];

  // ── Application-Specific Message & Email Selectors ─────────
  const APP_MESSAGE_SELECTORS = [
    // 1. Gmail (mail.google.com)
    ".ii.gt",                     // Email body container
    ".a3s.aiL",                   // Message text container
    "[role='listitem'] .adn",     // Expanded email card
    ".bog",                       // Email subject line in thread
    ".bqe",                       // Subject header in message view
    ".y6",                        // Snippet preview in inbox list
    ".zF",                        // Sender display name in inbox
    ".nH.hx .h7",                 // Gmail message thread wrapper

    // 2. Google Messages / Web SMS (messages.google.com)
    "mws-message-wrapper",
    ".text-content",
    "mws-text-message-part",
    "[data-e2e-message-text]",
    ".message-bubble",
    ".conv-item-snippet",

    // 3. WhatsApp Web (web.whatsapp.com)
    ".copyable-text",
    "[data-pre-plain-text]",
    ".message-in .selectable-text",
    ".message-out .selectable-text",

    // 4. Telegram Web (web.telegram.org)
    ".message-content",
    ".text-content",
    ".bubble-content",

    // 5. Discord / Slack / Teams
    ".messageContent-2t3eYr",
    ".c-message__body",
    "[data-message-author]",
    ".ui-chat__message__content",

    // 6. Generic Chat / SMS Classes
    ".chat-message",
    ".im-msg",
    ".chat-bubble",
    ".message-text",
    "div[role='row'] .message"
  ].join(",");

  const SENSITIVE_INPUT_ATTRS = [
    "credit-card", "cardnumber", "cvv", "cvc", "ssn", "pin",
    "security-code", "token", "secret", "otp", "password", "passcode", "account-number"
  ];

  const CONFIDENTIAL_MARKERS = [
    "confidential", "strictly private", "internal only", "do not share",
    "proprietary", "restricted", "one-time password", "verification code"
  ];

  // ── Sensitive Node Registry ────────────────────────────────
  const sensitiveNodes = new Set();
  let scanDebounceTimer = null;
  let pillElement = null;

  // ── Floating Status Pill ───────────────────────────────────
  function createOrUpdatePill() {
    if (!pillElement) {
      pillElement = document.createElement("div");
      pillElement.id = "peekshield-page-pill";
      pillElement.title = "PeekShield Smart Privacy Shield — Click to toggle frosted blur";
      pillElement.addEventListener("click", () => {
        setBlurState(!state.blurActive);
      });
      document.body.appendChild(pillElement);
    }

    const count = sensitiveNodes.size;
    let statusText = "🛡️ Protected";
    let stateClass = "state-safe";

    const icon = state.currentProfile === "BANKING"
      ? "🏦"
      : (state.currentProfile === "EMAIL_MESSAGING" ? "✉️" : (state.currentProfile === "SOCIAL_MEDIA" ? "💬" : "🛡️"));

    if (state.isPanicActive) {
      statusText = "⚡ PANIC ACTIVE (FROSTED)";
      stateClass = "state-panic";
    } else if (state.isStrangerPresent || state.privacyRisk === "HIGH" || state.blurActive) {
      statusText = `⚠️ PRIVACY ACTIVE (${count} Shielded)`;
      stateClass = "state-alert";
    } else {
      statusText = `${icon} ${state.currentProfile} (${count} Protected)`;
      stateClass = "state-safe";
    }

    pillElement.className = stateClass;
    pillElement.innerHTML = `
      <span class="pill-dot"></span>
      <span>${statusText}</span>
    `;
  }

  // ── Text Scanner (TreeWalker) ──────────────────────────────
  function isElementVisible(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return true;
    const style = window.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  function shouldSkipNode(node) {
    if (!node || !node.parentElement) return true;
    const tag = node.parentElement.tagName;
    if (["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "OPTION", "SVG"].includes(tag)) {
      return true;
    }
    if (node.parentElement.classList.contains("peekshield-sensitive-element") ||
        node.parentElement.classList.contains("peekshield-sensitive-block")) {
      return true;
    }
    return !isElementVisible(node.parentElement);
  }

  function scanTextNode(textNode) {
    if (shouldSkipNode(textNode)) return;
    const text = textNode.nodeValue;
    if (!text || text.trim().length < 3) return;

    let matchFound = false;
    let categoryFound = null;
    const lowerParent = (textNode.parentElement.textContent || "").toLowerCase();

    // 1. Credit & Debit Cards
    if (state.categories.cards && PATTERNS.card.test(text)) {
      matchFound = true;
      categoryFound = "card";
    }
    // 2. Bank Account & Routing Numbers
    else if (state.categories.bankAccounts && (PATTERNS.bankAccount.test(text) || PATTERNS.routingNumber.test(text) || PATTERNS.iban.test(text))) {
      matchFound = true;
      categoryFound = "bank-account";
    }
    // 3. Passwords, Tokens & API Keys
    else if (state.categories.passwords && PATTERNS.token.test(text)) {
      matchFound = true;
      categoryFound = "credential";
    }
    // 4. One-Time Passwords (OTPs) & Verification Codes
    else if (state.categories.otps && PATTERNS.otp.test(text)) {
      const hasOtpContext = OTP_CONTEXT_KEYWORDS.some((kw) => lowerParent.includes(kw));
      if (hasOtpContext) {
        matchFound = true;
        categoryFound = "otp";
      }
    }
    // 5. Emails
    else if (state.categories.emails && PATTERNS.email.test(text)) {
      matchFound = true;
      categoryFound = "email";
    }
    // 6. Phone Numbers
    else if (state.categories.phones && PATTERNS.phone.test(text)) {
      matchFound = true;
      categoryFound = "phone";
    }
    // 7. SSN / PII
    else if (state.categories.pii && PATTERNS.ssn.test(text)) {
      matchFound = true;
      categoryFound = "pii";
    }
    // 8. Financial Balance / Transactions
    else if (state.categories.bankAccounts && PATTERNS.balance.test(text)) {
      matchFound = true;
      categoryFound = "balance";
    }

    if (matchFound && categoryFound) {
      wrapSensitiveText(textNode, categoryFound);
    }
  }

  function wrapSensitiveText(textNode, category) {
    try {
      const span = document.createElement("span");
      span.className = "peekshield-sensitive-element";
      span.setAttribute("data-peekshield-cat", category);
      if (state.hoverPeekAllowed) span.classList.add("peekshield-hover-peek");
      if (state.blurActive) span.classList.add("peekshield-blurred");

      const parent = textNode.parentNode;
      if (!parent) return;

      span.textContent = textNode.nodeValue;
      parent.replaceChild(span, textNode);
      sensitiveNodes.add(span);
    } catch (e) {
      // Ignore replacement collisions
    }
  }

  // ── Input Fields Scanner (Passwords, CVV, Card inputs) ──────
  function scanInputElements(root = document) {
    const inputs = root.querySelectorAll("input, textarea");
    inputs.forEach((input) => {
      if (input.classList.contains("peekshield-sensitive-input")) return;

      const type = (input.getAttribute("type") || "").toLowerCase();
      const name = (input.getAttribute("name") || "").toLowerCase();
      const id = (input.getAttribute("id") || "").toLowerCase();
      const autocomplete = (input.getAttribute("autocomplete") || "").toLowerCase();
      const placeholder = (input.getAttribute("placeholder") || "").toLowerCase();

      let isSensitive = false;
      if (type === "password" && state.categories.passwords) {
        isSensitive = true;
      } else {
        for (const attr of SENSITIVE_INPUT_ATTRS) {
          if (name.includes(attr) || id.includes(attr) || autocomplete.includes(attr) || placeholder.includes(attr)) {
            isSensitive = true;
            break;
          }
        }
      }

      if (isSensitive) {
        input.classList.add("peekshield-sensitive-input");
        if (state.blurActive) input.classList.add("peekshield-blurred");
        sensitiveNodes.add(input);
      }
    });
  }

  // ── Message & Email Scanner (Gmail, SMS, WhatsApp, Chat) ───
  function scanAppMessages(root = document) {
    if (!state.categories.messages && !state.categories.chat) return;

    try {
      const elements = root.querySelectorAll(APP_MESSAGE_SELECTORS);
      elements.forEach((el) => {
        if (!el.classList.contains("peekshield-sensitive-block")) {
          // Verify it contains readable text
          const text = (el.textContent || "").trim();
          if (text.length > 2) {
            el.classList.add("peekshield-sensitive-block");
            el.setAttribute("data-peekshield-cat", "message");
            if (state.hoverPeekAllowed) el.classList.add("peekshield-hover-peek");
            if (state.blurActive) el.classList.add("peekshield-blurred");
            sensitiveNodes.add(el);
          }
        }
      });
    } catch (e) {}

    // Scan for confidential document markings
    try {
      const paras = root.querySelectorAll("p, div, blockquote, span");
      paras.forEach((p) => {
        if (p.children.length > 3) return; // Only leaf-like blocks
        const txt = (p.textContent || "").toLowerCase();
        for (const marker of CONFIDENTIAL_MARKERS) {
          if (txt.includes(marker) && !p.classList.contains("peekshield-sensitive-block")) {
            p.classList.add("peekshield-sensitive-block");
            p.setAttribute("data-peekshield-cat", "confidential");
            if (state.blurActive) p.classList.add("peekshield-blurred");
            sensitiveNodes.add(p);
            break;
          }
        }
      });
    } catch (e) {}
  }

  // ── Complete DOM Pass ──────────────────────────────────────
  function runFullScan() {
    scanInputElements(document);
    scanAppMessages(document);

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      null,
      false
    );

    let node;
    const textNodes = [];
    while ((node = walker.nextNode())) {
      textNodes.push(node);
      if (textNodes.length > 600) break; // Performance limit per pass
    }

    textNodes.forEach((tn) => scanTextNode(tn));
    createOrUpdatePill();
  }

  function scheduleScan() {
    clearTimeout(scanDebounceTimer);
    scanDebounceTimer = setTimeout(runFullScan, 200);
  }

  // ── Realistic Frosted-Glass State Control ──────────────────
  function setBlurState(active) {
    state.blurActive = !!active;

    sensitiveNodes.forEach((node) => {
      if (state.blurActive) {
        node.classList.add("peekshield-blurred");
      } else {
        node.classList.remove("peekshield-blurred");
      }
    });

    if (state.isPanicActive) {
      document.body.classList.add("peekshield-panic-active");
    } else {
      document.body.classList.remove("peekshield-panic-active");
    }

    createOrUpdatePill();
  }

  // ── Observer for Dynamically Injected Content (Gmail/SMS/Chats) ─
  const observer = new MutationObserver((mutations) => {
    let shouldScan = false;
    for (const m of mutations) {
      if (m.addedNodes && m.addedNodes.length > 0) {
        for (const n of m.addedNodes) {
          if (n.nodeType === Node.ELEMENT_NODE && n.id !== "peekshield-page-pill") {
            shouldScan = true;
            break;
          }
        }
      }
      if (shouldScan) break;
    }
    if (shouldScan) scheduleScan();
  });

  if (document.body) {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  // ── Chrome Extension IPC Listener ──────────────────────────
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg) return;

      if (msg.action === "BLUR_SENSITIVE") {
        state.isStrangerPresent = true;
        setBlurState(true);
        sendResponse({ ok: true, shieldedCount: sensitiveNodes.size });
      } else if (msg.action === "RESTORE_SENSITIVE") {
        state.isStrangerPresent = false;
        if (!state.isPanicActive) {
          setBlurState(false);
        }
        sendResponse({ ok: true });
      } else if (msg.action === "PANIC_ON") {
        state.isPanicActive = true;
        setBlurState(true);
        sendResponse({ ok: true });
      } else if (msg.action === "PANIC_OFF") {
        state.isPanicActive = false;
        if (!state.isStrangerPresent) {
          setBlurState(false);
        }
        sendResponse({ ok: true });
      } else if (msg.action === "GET_PAGE_STATUS") {
        sendResponse({
          sensitiveCount: sensitiveNodes.size,
          blurActive: state.blurActive,
          panicActive: state.isPanicActive,
          strangerPresent: state.isStrangerPresent,
          currentProfile: state.currentProfile,
        });
      } else if (msg.action === "UPDATE_CATEGORIES") {
        if (msg.categories) {
          state.categories = { ...state.categories, ...msg.categories };
          runFullScan();
        }
        sendResponse({ ok: true });
      } else if (msg.action === "FACTTRUE_START") {
        startFactTrueCapture(msg.samplingRate || 6);
        setRightPanelActive(true);
        sendResponse({ ok: true, tracking: true });
      } else if (msg.action === "FACTTRUE_STOP") {
        stopFactTrueCapture();
        setRightPanelActive(false);
        sendResponse({ ok: true, tracking: false });
      } else if (msg.action === "FACTTRUE_CLAIM_RESULT") {
        if (msg.result && Array.isArray(msg.result.claims)) {
          appendClaimsToPanel(msg.result.claims);
        }
        sendResponse({ ok: true });
      }
      return true;
    });
  }

  // ── FactTrue Real-Time Media & Claim Capture ───────────────
  let factTrueTimer = null;
  let captionObserver = null;
  let accumulatedTranscript = "";
  let unverifiedSpeechQueue = "";
  let lastDispatchedSpeech = "";

  function formatTime(secs) {
    if (isNaN(secs) || secs < 0) return "00:00";
    const m = Math.floor(secs / 60).toString().padStart(2, "0");
    const s = Math.floor(secs % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  }

  function findActiveVideo() {
    // 1. YouTube player video
    const ytVideo = document.querySelector("#movie_player video, .html5-video-player video");
    if (ytVideo) return ytVideo;

    // 2. Generic HTML5 videos currently playing or loaded
    const videos = Array.from(document.querySelectorAll("video"));
    if (videos.length > 0) {
      const playing = videos.find((v) => !v.paused && !v.ended && v.readyState > 2);
      return playing || videos[0];
    }
    return null;
  }

  function getVideoTitle() {
    // YouTube title
    const ytTitle = document.querySelector("h1.ytd-watch-metadata yt-formatted-string, #title h1 yt-formatted-string, ytd-watch-flexy h1");
    if (ytTitle && ytTitle.textContent.trim()) return ytTitle.textContent.trim();

    // OpenGraph or page title
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle && ogTitle.content) return ogTitle.content.trim();

    return document.title || "Web Video";
  }

  function appendCaptionDelta(existing, incoming) {
    if (!incoming) return existing;
    const cleanNew = incoming.trim().replace(/\s+/g, " ");
    if (!cleanNew) return existing;
    if (!existing) return cleanNew;

    const lowerExist = existing.toLowerCase();
    const lowerNew = cleanNew.toLowerCase();

    // Already ends with the incoming string
    if (lowerExist.endsWith(lowerNew)) return existing;

    const wordsExisting = existing.split(" ");
    const wordsNew = cleanNew.split(" ");

    // Look for overlap between tail of existing and head of incoming
    let maxOverlap = 0;
    const maxK = Math.min(wordsExisting.length, wordsNew.length, 12);
    for (let k = maxK; k >= 1; k--) {
      const tail = wordsExisting.slice(wordsExisting.length - k).join(" ").toLowerCase();
      const head = wordsNew.slice(0, k).join(" ").toLowerCase();
      if (tail === head) {
        maxOverlap = k;
        break;
      }
    }

    if (maxOverlap > 0) {
      const freshWords = wordsNew.slice(maxOverlap);
      if (freshWords.length === 0) return existing;
      return `${existing} ${freshWords.join(" ")}`;
    }

    return `${existing} ${cleanNew}`;
  }

  function handleIncomingCaptions(rawText) {
    if (!rawText) return;
    const previous = accumulatedTranscript;
    accumulatedTranscript = appendCaptionDelta(accumulatedTranscript, rawText);

    if (accumulatedTranscript !== previous) {
      const prevWords = previous ? previous.split(" ") : [];
      const newWords = accumulatedTranscript.split(" ");
      const deltaWords = newWords.slice(prevWords.length);

      if (deltaWords.length > 0) {
        const deltaStr = deltaWords.join(" ");
        unverifiedSpeechQueue = unverifiedSpeechQueue ? `${unverifiedSpeechQueue} ${deltaStr}` : deltaStr;

        // Display rolling continuous dialogue in the live speech box
        const preview = newWords.slice(-25).join(" ");
        updatePanelSpeech(preview);

        checkAndDispatchReadySpeech();
      }
    }
  }

  function checkAndDispatchReadySpeech() {
    if (!panelActive) return;
    const queue = unverifiedSpeechQueue.trim();
    if (!queue) return;

    const words = queue.split(/\s+/);
    const hasPunctuation = /[.?!;:]/.test(queue);

    // Dispatch immediately when complete sentence or 14+ words spoken
    if ((hasPunctuation && words.length >= 7) || words.length >= 14) {
      dispatchCurrentSpeechBatch();
    }
  }

  function dispatchCurrentSpeechBatch() {
    const queue = unverifiedSpeechQueue.trim();
    if (!queue || queue.length < 12) return;

    const currentVideo = findActiveVideo();
    if (!currentVideo) return;

    const timestamp = formatTime(currentVideo.currentTime);
    const frame = captureFrameBase64(currentVideo);

    // Send complete recent narrative context (last ~45 words) so Gemini extracts multiple compound facts
    const allWords = accumulatedTranscript.split(/\s+/);
    const contextWords = allWords.slice(-45).join(" ");
    const transcriptToSend = contextWords || queue;

    if (transcriptToSend === lastDispatchedSpeech) return;
    lastDispatchedSpeech = transcriptToSend;
    unverifiedSpeechQueue = "";

    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({
        type: "facttrue_segment",
        payload: {
          videoTitle: getVideoTitle(),
          videoUrl: window.location.href,
          timestamp,
          transcript: transcriptToSend,
          frameBase64: frame,
        },
      });
    }
  }

  function initCaptionObserver() {
    if (captionObserver) return;
    try {
      captionObserver = new MutationObserver(() => {
        const text = readCurrentCaptions();
        if (text) {
          handleIncomingCaptions(text);
        }
      });

      const root = document.body || document.documentElement;
      if (root) {
        captionObserver.observe(root, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      }
    } catch (e) {}
  }

  function readCurrentCaptions() {
    // 1. YouTube caption segments
    const ytSegments = Array.from(document.querySelectorAll(".ytp-caption-segment, .caption-window span, .ytp-caption-window-container span"));
    if (ytSegments.length > 0) {
      const parts = ytSegments.map((el) => el.textContent.trim()).filter(Boolean);
      if (parts.length > 0) return parts.join(" ");
    }

    // 2. YouTube transcript panel if active
    const transcriptActive = document.querySelector("ytd-transcript-segment-renderer[active] .segment-text, .ytd-transcript-segment-renderer.active .segment-text, ytd-transcript-segment-renderer.selected .segment-text");
    if (transcriptActive && transcriptActive.textContent.trim()) {
      return transcriptActive.textContent.trim();
    }

    // 3. Test portal or custom subtitle containers
    const testCaptions = document.querySelector(".facttrue-transcript, #active-transcript, [data-transcript]");
    if (testCaptions && testCaptions.textContent.trim()) {
      return testCaptions.textContent.trim();
    }

    // 4. HTML5 textTracks active cues
    const video = findActiveVideo();
    if (video && video.textTracks && video.textTracks.length > 0) {
      for (let i = 0; i < video.textTracks.length; i++) {
        const track = video.textTracks[i];
        if (track.activeCues && track.activeCues.length > 0) {
          const cues = Array.from(track.activeCues).map((c) => c.text.trim()).filter(Boolean);
          if (cues.length > 0) return cues.join(" ");
        }
      }
    }

    return "";
  }

  function captureFrameBase64(video) {
    if (!video || video.readyState < 2) return null;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 480;
      canvas.height = 270;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", 0.6);
    } catch (e) {
      return null;
    }
  }

  function startFactTrueCapture(intervalSecs = 4) {
    stopFactTrueCapture();
    initCaptionObserver();
    tryEnableYouTubeSubtitles();

    const video = findActiveVideo();
    if (video) {
      const title = getVideoTitle();
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({
          type: "facttrue_video_detected",
          payload: {
            title,
            url: window.location.href,
            duration: formatTime(video.duration || 0),
            currentTime: formatTime(video.currentTime || 0),
          },
        });
      }
    }

    const poller = () => {
      const currentVideo = findActiveVideo();
      if (!currentVideo) return;

      tryEnableYouTubeSubtitles();
      const text = readCurrentCaptions();
      if (text) {
        handleIncomingCaptions(text);
      }

      // If pending unverified speech exists, dispatch it periodically
      if (unverifiedSpeechQueue.trim().split(/\s+/).length >= 6) {
        dispatchCurrentSpeechBatch();
      }
    };

    poller();
    factTrueTimer = setInterval(poller, Math.max(3, intervalSecs) * 1000);
  }

  function stopFactTrueCapture() {
    if (factTrueTimer) {
      clearInterval(factTrueTimer);
      factTrueTimer = null;
    }
    if (captionObserver) {
      try { captionObserver.disconnect(); } catch (e) {}
      captionObserver = null;
    }
  }

  // ── FactTrue YouTube Right-Side Real-Time Panel ───────────
  let userExplicitlyCollapsed = false;
  let panelMounted = false;
  let panelActive = false;
  let panelClaims = [];

  function ensureRightPanelMounted() {
    let panel = document.getElementById("facttrue-right-panel");
    let pill = document.getElementById("facttrue-floating-pill");

    const isVideoPage =
      window.location.href.includes("watch") ||
      window.location.href.includes("shorts") ||
      window.location.hostname.includes("youtube.com") ||
      !!document.querySelector("video");

    if (panel && pill) {
      if (isVideoPage && !userExplicitlyCollapsed) {
        panel.classList.remove("collapsed");
        pill.style.display = "none";
      }
      return;
    }

    const container = document.body || document.documentElement;
    if (!container) return;

    // 1. Floating quick-access pill on right screen edge
    if (!pill) {
      pill = document.createElement("div");
      pill.id = "facttrue-floating-pill";
      pill.innerHTML = `
        <div class="ft-pill-dot"></div>
        <span>FactTrue Live</span>
        <span id="ft-pill-badge" style="font-size: 10px; opacity: 0.8; background: rgba(255,255,255,0.15); padding: 1px 6px; border-radius: 8px;">0</span>
      `;
      container.appendChild(pill);

      pill.addEventListener("click", () => {
        userExplicitlyCollapsed = false;
        const p = document.getElementById("facttrue-right-panel");
        if (p) p.classList.remove("collapsed");
        pill.style.display = "none";
        tryEnableYouTubeSubtitles();
      });
    }

    // 2. Right-Side Frosted Real-Time Fact Panel
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "facttrue-right-panel";

      if (isVideoPage && !userExplicitlyCollapsed) {
        panel.className = ""; // Start OPEN by default on video pages
        pill.style.display = "none";
      } else {
        panel.className = "collapsed";
        pill.style.display = "flex";
      }

      panel.innerHTML = `
        <div class="ft-panel-header">
          <div class="ft-brand">
            <span style="font-size: 16px;">🔍</span>
            <span class="ft-brand-title">FactTrue Live</span>
            <span class="ft-live-tag" id="ft-live-indicator">● READY</span>
          </div>
          <div class="ft-header-actions">
            <button id="ft-btn-toggle" class="ft-btn-toggle">▶ Start</button>
            <button id="ft-btn-close" class="ft-btn-close" title="Collapse panel">❯</button>
          </div>
        </div>

        <div class="ft-video-strip">
          <div class="ft-video-title" id="ft-video-title-label">Detecting active video...</div>
          <div class="ft-video-time-row">
            <span>YouTube Live Sync</span>
            <span class="ft-clock" id="ft-video-clock">⏱ 00:00</span>
          </div>
        </div>

        <div class="ft-live-speech-box">
          <div class="ft-speech-label">🎙️ Live English Facts & Speech:</div>
          <div class="ft-speech-text" id="ft-speech-text">Awaiting spoken statements or captions...</div>
        </div>

        <div class="ft-panel-body" id="ft-panel-claims-list">
          <div class="ft-empty-notice" id="ft-empty-notice">
            <div class="ft-empty-icon">📺</div>
            <div style="font-weight: 700; color: #fff; font-size: 13px; margin-bottom: 4px;">FactTrue Active on YouTube</div>
            <p style="font-size: 11.5px; margin: 0; line-height: 1.4; color: #94a3b8;">Real-time AI fact-checking verifies statements as this video plays.</p>
            <div style="margin-top: 10px; display: flex; flex-direction: column; gap: 6px;">
              <button id="ft-btn-sample-fact" class="ft-btn-sample" style="background: rgba(168, 85, 247, 0.16); border: 1px solid rgba(168, 85, 247, 0.4); color: #c084fc; border-radius: 8px; padding: 6px 10px; font-size: 11px; font-weight: 600; cursor: pointer; text-align: left;">
                ⚡ Test Fact: "The Eiffel Tower was built in 1889."
              </button>
              <button id="ft-btn-sample-debunk" class="ft-btn-sample" style="background: rgba(239, 68, 68, 0.16); border: 1px solid rgba(239, 68, 68, 0.4); color: #f87171; border-radius: 8px; padding: 6px 10px; font-size: 11px; font-weight: 600; cursor: pointer; text-align: left;">
                ⚡ Test Claim: "Great Wall of China is visible from space."
              </button>
            </div>
          </div>
        </div>

        <div class="ft-panel-footer">
          <span class="ft-footer-count" id="ft-footer-count">0 Verified Facts</span>
          <button id="ft-btn-clear" class="ft-btn-clear">Clear Feed</button>
        </div>
      `;

      container.appendChild(panel);
      panelMounted = true;

      // Collapse panel on close button click
      panel.querySelector("#ft-btn-close").addEventListener("click", () => {
        userExplicitlyCollapsed = true;
        panel.classList.add("collapsed");
        const pi = document.getElementById("facttrue-floating-pill");
        if (pi) pi.style.display = "flex";
      });

      // Start / Stop toggle directly from YouTube panel
      panel.querySelector("#ft-btn-toggle").addEventListener("click", () => {
        const nextActive = !panelActive;
        setRightPanelActive(nextActive);
        if (nextActive) {
          startFactTrueCapture(6);
        } else {
          stopFactTrueCapture();
        }

        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({ type: "facttrue_toggle_request" });
        }
        tryEnableYouTubeSubtitles();
      });

      // Interactive Test Claim Buttons
      const btnTestFact = panel.querySelector("#ft-btn-sample-fact");
      if (btnTestFact) {
        btnTestFact.addEventListener("click", () => {
          updatePanelSpeech("The Eiffel Tower was constructed from 1887 to 1889 in Paris, France.");
          if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
            chrome.runtime.sendMessage({
              type: "facttrue_segment",
              payload: {
                videoTitle: getVideoTitle(),
                videoUrl: window.location.href,
                timestamp: "00:15",
                transcript: "The Eiffel Tower was constructed from 1887 to 1889 in Paris, France.",
              },
            });
          }
        });
      }

      const btnTestDebunk = panel.querySelector("#ft-btn-sample-debunk");
      if (btnTestDebunk) {
        btnTestDebunk.addEventListener("click", () => {
          updatePanelSpeech("The Great Wall of China is easily visible from low Earth orbit with the unaided eye.");
          if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
            chrome.runtime.sendMessage({
              type: "facttrue_segment",
              payload: {
                videoTitle: getVideoTitle(),
                videoUrl: window.location.href,
                timestamp: "00:25",
                transcript: "The Great Wall of China is easily visible from low Earth orbit with the unaided human eye.",
              },
            });
          }
        });
      }

      // Clear claims list
      panel.querySelector("#ft-btn-clear").addEventListener("click", () => {
        panelClaims = [];
        renderPanelClaims();
      });

      // Continuously sync video clock & ensure subtitles
      setInterval(() => {
        const v = findActiveVideo();
        if (v) {
          const clk = document.getElementById("ft-video-clock");
          if (clk) clk.textContent = `⏱ ${formatTime(v.currentTime)}`;
          const ttl = document.getElementById("ft-video-title-label");
          if (ttl) ttl.textContent = getVideoTitle();
        }
      }, 500);
    }
  }

  function tryEnableYouTubeSubtitles() {
    if (!window.location.hostname.includes("youtube.com")) return;
    try {
      const ccBtn = document.querySelector(".ytp-subtitles-button");
      if (ccBtn) {
        const isPressed = ccBtn.getAttribute("aria-pressed") === "true";
        if (!isPressed) {
          ccBtn.click();
        }
      }
    } catch (e) {}
  }

  function setRightPanelActive(active) {
    ensureRightPanelMounted();
    panelActive = !!active;

    const btnToggle = document.getElementById("ft-btn-toggle");
    const liveIndicator = document.getElementById("ft-live-indicator");
    const panel = document.getElementById("facttrue-right-panel");
    const pill = document.getElementById("facttrue-floating-pill");

    if (btnToggle) {
      if (panelActive) {
        btnToggle.textContent = "⏹ Stop";
        btnToggle.classList.add("active");
      } else {
        btnToggle.textContent = "▶ Start";
        btnToggle.classList.remove("active");
      }
    }

    if (liveIndicator) {
      if (panelActive) {
        liveIndicator.textContent = "● REAL-TIME";
        liveIndicator.style.color = "#34d399";
      } else {
        liveIndicator.textContent = "● READY";
        liveIndicator.style.color = "#94a3b8";
      }
    }

    if (panelActive && panel && panel.classList.contains("collapsed")) {
      panel.classList.remove("collapsed");
      if (pill) pill.style.display = "none";
      tryEnableYouTubeSubtitles();
    }
  }

  function updatePanelSpeech(text) {
    const el = document.getElementById("ft-speech-text");
    if (el && text) {
      el.textContent = text;
    }
  }

  function appendClaimsToPanel(newClaims) {
    ensureRightPanelMounted();
    if (!Array.isArray(newClaims) || newClaims.length === 0) return;

    for (const c of newClaims) {
      if (panelClaims.some((existing) => existing.id === c.id || existing.claim.trim().toLowerCase() === c.claim.trim().toLowerCase())) continue;
      panelClaims.unshift(c);
    }

    if (panelClaims.length > 80) {
      panelClaims = panelClaims.slice(0, 80);
    }

    renderPanelClaims();
  }

  function renderPanelClaims() {
    const container = document.getElementById("ft-panel-claims-list");
    const pillBadge = document.getElementById("ft-pill-badge");
    const footerCount = document.getElementById("ft-footer-count");

    if (!container) return;

    if (pillBadge) pillBadge.textContent = `${panelClaims.length}`;
    if (footerCount) footerCount.textContent = `${panelClaims.length} Verified Fact${panelClaims.length === 1 ? "" : "s"}`;

    if (panelClaims.length === 0) {
      container.innerHTML = `
        <div class="ft-empty-notice">
          <div class="ft-empty-icon">📺</div>
          <div style="font-weight: 700; color: #fff; font-size: 13px; margin-bottom: 4px;">FactTrue Active on YouTube</div>
          <p style="font-size: 11.5px; margin: 0; line-height: 1.4;">Real-time AI fact-checking verifies statements as this video plays.</p>
        </div>
      `;
      return;
    }

    let html = "";
    for (const item of panelClaims) {
      let badgeClass = "ft-badge-unverified";
      let icon = "?";
      if (item.status === "Supported") { badgeClass = "ft-badge-supported"; icon = "✓"; }
      else if (item.status === "Contradicted") { badgeClass = "ft-badge-contradicted"; icon = "✕"; }
      else if (item.status === "Partially supported") { badgeClass = "ft-badge-partial"; icon = "≈"; }
      else if (item.status === "Opinion or prediction") { badgeClass = "ft-badge-opinion"; icon = "💭"; }

      let sourcesHtml = "";
      if (Array.isArray(item.sources) && item.sources.length > 0) {
        sourcesHtml = `
          <div class="ft-card-sources">
            ${item.sources.slice(0, 3).map((s) => `
              <a href="${s.url}" target="_blank" rel="noopener noreferrer" class="ft-source-link">
                🌐 ${escapeHtml(s.domain || "Source")}
              </a>
            `).join("")}
          </div>
        `;
      }

      html += `
        <div class="ft-card">
          <div class="ft-card-top">
            <span class="ft-card-time">⏱ ${item.timestamp || "00:00"}</span>
            <span class="ft-badge ${badgeClass}">${icon} ${item.status}</span>
          </div>
          <div class="ft-card-claim">"${escapeHtml(item.claim)}"</div>
          <div class="ft-card-explanation">${escapeHtml(item.explanation)}</div>
          ${item.evidence ? `<div class="ft-card-evidence"><strong>Evidence:</strong> ${escapeHtml(item.evidence)}</div>` : ""}
          ${sourcesHtml}
        </div>
      `;
    }

    container.innerHTML = html;
  }

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // YouTube SPA Dynamic Navigation & DOM Event Listeners
  window.addEventListener("yt-navigate-finish", () => {
    ensureRightPanelMounted();
    tryEnableYouTubeSubtitles();
  });
  window.addEventListener("yt-page-data-updated", () => {
    ensureRightPanelMounted();
    tryEnableYouTubeSubtitles();
  });
  window.addEventListener("popstate", () => {
    ensureRightPanelMounted();
  });

  // Guarantee panel presence across dynamic YouTube page transitions
  setInterval(() => {
    if (window.location.hostname.includes("youtube.com") || document.querySelector("video")) {
      ensureRightPanelMounted();
    }
  }, 1000);

  // Synchronize state with Desktop Engine / Background
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
    chrome.runtime.sendMessage({ action: "GET_EXTENSION_STATUS" }, (res) => {
      if (res && res.state) {
        if (res.state.factTrueActive) {
          startFactTrueCapture(6);
          setRightPanelActive(true);
        }
        if (res.state.strangerDetected || res.state.panicActive) {
          applyFrostedBlur(document);
        }
      }
    });
  }

  // Initial Scan when document is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      runFullScan();
      if (window.location.hostname.includes("youtube.com") || document.querySelector("video")) {
        ensureRightPanelMounted();
      }
    });
  } else {
    runFullScan();
    if (window.location.hostname.includes("youtube.com") || document.querySelector("video")) {
      ensureRightPanelMounted();
    }
  }
})();
