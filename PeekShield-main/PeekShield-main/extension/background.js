// ─────────────────────────────────────────────────────────────
// PEEKSHIELD — Background Service Worker (Manifest V3)
// Bridges Desktop AI Engine (ws://127.0.0.1:8765) with Chrome Tabs
// ─────────────────────────────────────────────────────────────

const WS_URL = "ws://127.0.0.1:8765";
let ws = null;
let reconnectTimer = null;
let isConnected = false;

let globalPrivacyState = {
  connected: false,
  strangerDetected: false,
  panicActive: false,
  factTrueActive: false,
  riskLevel: "LOW",
  categories: {
    emails: true,
    phones: true,
    cards: true,
    passwords: true,
    otps: true,
    chat: true,
  },
};

// ── Broadcast message to all open tabs ───────────────────────
async function broadcastToAllTabs(message) {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id && tab.url && !tab.url.startsWith("chrome://")) {
        chrome.tabs.sendMessage(tab.id, message).catch(() => {
          // Tab may not have content script loaded yet (e.g. newtab)
        });
      }
    }
  } catch (e) {
    console.warn("[PeekShield Background] Failed to broadcast to tabs:", e);
  }
}

// ── WebSocket Connection to Desktop Engine ───────────────────
function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }

  try {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log("[PeekShield] Connected to Desktop Privacy Engine!");
      isConnected = true;
      globalPrivacyState.connected = true;
      clearTimeout(reconnectTimer);
      chrome.storage.local.set({ peekshieldState: globalPrivacyState });
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleDesktopEvent(data);
      } catch (err) {
        console.warn("[PeekShield] Invalid WS message:", err);
      }
    };

    ws.onclose = () => {
      isConnected = false;
      globalPrivacyState.connected = false;
      ws = null;
      scheduleReconnect();
    };

    ws.onerror = () => {
      isConnected = false;
      globalPrivacyState.connected = false;
      if (ws) ws.close();
    };
  } catch (e) {
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectWebSocket, 3000);
}

// ── Desktop Event Dispatcher ─────────────────────────────────
function handleDesktopEvent(event) {
  if (!event) return;

  if (event.type === "privacy_state") {
    globalPrivacyState.strangerDetected = !!event.stranger_detected;
    globalPrivacyState.panicActive = !!event.panic;
    globalPrivacyState.riskLevel = event.risk_level || "LOW";

    if (event.action === "BLUR" || event.stranger_detected) {
      broadcastToAllTabs({ action: "BLUR_SENSITIVE", riskLevel: event.risk_level });
    } else if (event.action === "RESTORE" && !event.stranger_detected && !event.panic) {
      broadcastToAllTabs({ action: "RESTORE_SENSITIVE" });
    }

    if (event.panic) {
      broadcastToAllTabs({ action: "PANIC_ON" });
    } else if (event.panic === false && !event.stranger_detected) {
      broadcastToAllTabs({ action: "PANIC_OFF" });
    }

    chrome.storage.local.set({ peekshieldState: globalPrivacyState });
  } else if (event.type === "FACTTRUE_START") {
    globalPrivacyState.factTrueActive = true;
    chrome.storage.local.set({ peekshieldState: globalPrivacyState });
    broadcastToAllTabs({ action: "FACTTRUE_START", samplingRate: event.samplingRate || 6 });
  } else if (event.type === "FACTTRUE_STOP") {
    globalPrivacyState.factTrueActive = false;
    chrome.storage.local.set({ peekshieldState: globalPrivacyState });
    broadcastToAllTabs({ action: "FACTTRUE_STOP" });
  } else if (event.type === "FACTTRUE_CLAIM_RESULT") {
    broadcastToAllTabs({ action: "FACTTRUE_CLAIM_RESULT", result: event.payload });
  }
}

// ── Auto-sync FactTrue state to newly navigated tabs ─────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url && !tab.url.startsWith("chrome://")) {
    if (globalPrivacyState.factTrueActive) {
      chrome.tabs.sendMessage(tabId, { action: "FACTTRUE_START" }).catch(() => {});
    }
  }
});

// ── Message Listener for Popup and Content Scripts ────────────
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (
    request.type === "facttrue_segment" ||
    request.type === "facttrue_video_detected" ||
    request.type === "facttrue_error" ||
    request.type === "facttrue_toggle_request"
  ) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(request));
      sendResponse({ sent: true });
    } else {
      sendResponse({ sent: false, error: "Desktop bridge disconnected" });
    }
    return true;
  }

  if (request.action === "GET_EXTENSION_STATUS") {
    sendResponse({
      connected: isConnected,
      state: globalPrivacyState,
    });
  } else if (request.action === "SET_MANUAL_PANIC") {
    globalPrivacyState.panicActive = !!request.enabled;
    const action = request.enabled ? "PANIC_ON" : "PANIC_OFF";
    broadcastToAllTabs({ action });
    sendResponse({ ok: true });
  } else if (request.action === "UPDATE_CATEGORIES") {
    if (request.categories) {
      globalPrivacyState.categories = { ...globalPrivacyState.categories, ...request.categories };
      broadcastToAllTabs({ action: "UPDATE_CATEGORIES", categories: globalPrivacyState.categories });
      chrome.storage.local.set({ peekshieldState: globalPrivacyState });
    }
    sendResponse({ ok: true });
  }
  return true;
});

// Start connection on service worker startup
connectWebSocket();

