// Global variables to track state
let joinAttempts = 0
let joinSuccessful = false
let networkRetries = 0
const MAX_JOIN_ATTEMPTS = 20
const MAX_NETWORK_RETRIES = 5
let lastJoinAttemptTime = 0
const meetingPlatform = detectMeetingPlatform()
const joinStartTime = Date.now()
let networkBackoffDelay = 1000 // Start with 1 second, will increase exponentially
let pageLoadTimeout = null
let joinInterval = null
let longPollInterval = null
let networkCheckInterval = null
let mutationObserver = null

// Detect which meeting platform we're on
function detectMeetingPlatform() {
  const url = window.location.href

  if (url.includes("meet.google.com")) return "google"
  if (url.includes("zoom.us")) return "zoom"
  if (url.includes("teams.microsoft.com")) return "teams"
  if (url.includes("webex.com")) return "webex"

  return "unknown"
}

// Log with timestamp for better debugging
function logWithTime(message, level = "info") {
  const now = new Date()
  const timestamp = now.toLocaleTimeString() + "." + now.getMilliseconds().toString().padStart(3, "0")
  const logMessage = `[${timestamp}] [${meetingPlatform.toUpperCase()}] ${message}`

  if (level === "error") {
    console.error(logMessage)
  } else if (level === "warn") {
    console.warn(logMessage)
  } else {
    console.log(logMessage)
  }

  // Report critical errors to background script
  if (level === "error") {
    try {
      if (typeof chrome !== "undefined" && chrome.runtime) {
        chrome.runtime.sendMessage({
          action: "logError",
          message: message,
          platform: meetingPlatform,
          url: window.location.href,
        })
      } else {
        logWithTime("Chrome runtime is not available.", "warn")
      }
    } catch (e) {
      // Ignore errors sending to background script
    }
  }
}

// Initialize and set up all intervals and observers
function initialize() {
  logWithTime("Initializing auto-join system")

  // Monitor page load state
  monitorPageLoadState()

  // Set up network status check
  networkCheckInterval = setInterval(checkNetworkStatus, 30000)

  // Run auto-join with an initial delay to ensure page has loaded
  setTimeout(() => {
    autoJoinMeeting()
    checkJoinStatus()
  }, 3000)

  // Run at different intervals to catch different scenarios
  joinInterval = setInterval(() => {
    if (joinSuccessful) {
      clearInterval(joinInterval)
      return
    }

    autoJoinMeeting()
    if (checkJoinStatus()) {
      clearInterval(joinInterval)
    }
  }, 3000)

  // Keep a longer interval active to handle delayed UI changes
  longPollInterval = setInterval(() => {
    if (joinSuccessful) {
      clearInterval(longPollInterval)
      return
    }

    // If we've been trying to join for more than 5 minutes, report failure
    if (Date.now() - joinStartTime > 5 * 60 * 1000 && !joinSuccessful) {
      logWithTime("Failed to join meeting after 5 minutes of attempts", "error")
      reportJoinFailure("timeout")
      clearInterval(longPollInterval)
      return
    }

    autoJoinMeeting()
    checkJoinStatus()
  }, 10000)

  // Watch for DOM changes to detect when join buttons appear
  setupMutationObserver()

  // Detect network status changes
  setupNetworkListeners()

  // Handle page visibility changes
  setupVisibilityListener()
}

function setupMutationObserver() {
  // Clean up existing observer if any
  if (mutationObserver) {
    mutationObserver.disconnect()
  }

  mutationObserver = new MutationObserver(() => {
    if (!joinSuccessful) {
      autoJoinMeeting()
    }
  })

  // Start observing the document with the configured parameters
  mutationObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: false,
  })
}

function setupNetworkListeners() {
  window.addEventListener("online", () => {
    logWithTime("Network connection restored - attempting to rejoin")
    networkRetries = 0
    networkBackoffDelay = 1000 // Reset backoff delay
    autoJoinMeeting()
  })

  window.addEventListener("offline", () => {
    logWithTime("Network connection lost", "warn")
    // Increase backoff delay for future attempts
    networkBackoffDelay = Math.min(networkBackoffDelay * 2, 30000) // Max 30 seconds
  })
}

function setupVisibilityListener() {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !joinSuccessful) {
      logWithTime("Tab became visible, attempting to join meeting")
      autoJoinMeeting()
    }
  })
}

// Check network status and report to background script
async function checkNetworkStatus() {
  try {
    // Simple check if navigator reports online
    if (!navigator.onLine) {
      logWithTime("Device reports offline status", "warn")
      return false
    }

    // Try a fetch to verify actual connectivity
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 5000)

      const response = await fetch("https://www.google.com/favicon.ico", {
        mode: "no-cors",
        cache: "no-store",
        signal: controller.signal,
      })

      clearTimeout(timeoutId)
      return true
    } catch (error) {
      if (error.name === "AbortError") {
        logWithTime("Network check timed out - connection may be slow", "warn")
      } else {
        logWithTime(`Network check failed: ${error.message}`, "warn")
      }

      // Increase backoff delay for future attempts
      networkBackoffDelay = Math.min(networkBackoffDelay * 2, 30000) // Max 30 seconds
      return false
    }
  } catch (e) {
    logWithTime(`Error checking network status: ${e.message}`, "error")
    return navigator.onLine // Fallback to basic check
  }
}

function autoJoinMeeting() {
  // Don't keep trying if we've already joined or exceeded max attempts
  if (joinSuccessful) {
    return
  }

  if (joinAttempts > MAX_JOIN_ATTEMPTS) {
    logWithTime("Max join attempts reached. Pausing automatic join attempts.", "warn")
    reportJoinFailure("max_attempts")
    return
  }

  // Throttle join attempts to prevent excessive CPU usage
  const now = Date.now()
  if (now - lastJoinAttemptTime < networkBackoffDelay) {
    // Use dynamic backoff delay
    return
  }
  lastJoinAttemptTime = now

  joinAttempts++

  // Check if page is fully loaded
  if (document.readyState !== "complete") {
    logWithTime("Page still loading, waiting before attempting to join...")
    return
  }

  // Check for loading indicators
  const loadingIndicators = document.querySelectorAll('.loading-indicator, .loadingIndicator, [role="progressbar"]')
  if (loadingIndicators.length > 0) {
    logWithTime("Loading indicators present, waiting...")
    return
  }

  // Platform-specific join logic
  switch (meetingPlatform) {
    case "google":
      joinGoogleMeet()
      break
    case "zoom":
      joinZoomMeeting()
      break
    case "teams":
      joinTeamsMeeting()
      break
    case "webex":
      joinWebexMeeting()
      break
    default:
      // Try generic approach for unknown platforms
      joinGenericMeeting()
  }

  // Handle network connection issues
  checkNetworkIssues()
}

function joinGoogleMeet() {
  // Advanced button selection strategies for Google Meet
  const joinSelectors = [
    'button[data-tooltip="Join now"]',
    'button[aria-label="Join now"]',
    'button[aria-label="Ask to join"]',
    'span[jsname="V67aGc"]:contains("Join now")',
    'span[jsname="V67aGc"]:contains("Ask to join")',
    'div[jsname="Qx7uuf"] span:contains("Join")',
    'div[jsname="Qx7uuf"] span:contains("Ask")',
    // XPath selectors for more flexible matching
    'xpath://button[contains(., "Join")]',
    'xpath://button[contains(., "Ask to join")]',
    'xpath://span[contains(text(), "Join now")]/ancestor::button',
    'xpath://span[contains(text(), "Ask to join")]/ancestor::button',
  ]

  // Try all join button selectors
  let joinButtonFound = false
  for (const selector of joinSelectors) {
    if (tryClickButton(selector)) {
      joinButtonFound = true
      logWithTime("Clicked Google Meet join button: " + selector)
      break
    }
  }

  // Dismiss common Google Meet popups and overlays
  if (!joinButtonFound) {
    const dismissSelectors = [
      'button[aria-label="Close"]',
      'button[aria-label="Dismiss"]',
      'button[data-tooltip="Close"]',
      'button:contains("Close")',
      'button:contains("Dismiss")',
      'button:contains("No thanks")',
      'button:contains("Not now")',
      'button[aria-label="Got it"]',
      'button:contains("Got it")',
      'xpath://button[contains(., "Close")]',
      'xpath://button[contains(., "Dismiss")]',
    ]

    // Try to dismiss popups without logging errors
    for (const selector of dismissSelectors) {
      if (tryClickButton(selector, false)) {
        logWithTime("Dismissed popup: " + selector)
      }
    }
  }
}

// Other platform-specific join functions remain the same...
function joinZoomMeeting() {
  // Zoom join button selectors
  const joinSelectors = [
    'button:contains("Join")',
    'button:contains("Join with Computer Audio")',
    'button:contains("Join Audio")',
    'button:contains("Join with Video")',
    'button:contains("Join without Video")',
    "button#joinBtn",
    "button.join-btn",
    'xpath://button[contains(., "Join")]',
  ]

  // Try all join button selectors
  for (const selector of joinSelectors) {
    if (tryClickButton(selector)) {
      logWithTime("Clicked Zoom join button: " + selector)
      break
    }
  }

  // Handle Zoom-specific popups
  const dismissSelectors = [
    'button:contains("Got it")',
    'button:contains("I Agree")',
    'button:contains("Accept")',
    "button.btn-confirm",
    'button:contains("Later")',
  ]

  for (const selector of dismissSelectors) {
    tryClickButton(selector, false)
  }
}

function joinTeamsMeeting() {
  // Teams join button selectors
  const joinSelectors = [
    'button:contains("Join now")',
    'button:contains("Join meeting")',
    'button[data-tid="prejoin-join-button"]',
    'button[data-tid="call-prejoin-join-button"]',
    'xpath://button[contains(., "Join")]',
  ]

  // Try all join button selectors
  for (const selector of joinSelectors) {
    if (tryClickButton(selector)) {
      logWithTime("Clicked Teams join button: " + selector)
      break
    }
  }

  // Handle Teams-specific popups
  const dismissSelectors = [
    'button:contains("Got it")',
    'button:contains("Dismiss")',
    'button:contains("Accept")',
    'button:contains("Allow")',
  ]

  for (const selector of dismissSelectors) {
    tryClickButton(selector, false)
  }
}

function joinWebexMeeting() {
  // Webex join button selectors
  const joinSelectors = [
    'button:contains("Join meeting")',
    'button:contains("Join")',
    "button.join-meeting",
    "button#join-meeting-button",
    'xpath://button[contains(., "Join")]',
  ]

  // Try all join button selectors
  for (const selector of joinSelectors) {
    if (tryClickButton(selector)) {
      logWithTime("Clicked Webex join button: " + selector)
      break
    }
  }

  // Handle Webex-specific popups
  const dismissSelectors = [
    'button:contains("Got it")',
    'button:contains("Accept")',
    'button:contains("Skip")',
    'button:contains("Continue")',
  ]

  for (const selector of dismissSelectors) {
    tryClickButton(selector, false)
  }
}

function joinGenericMeeting() {
  // Generic join button selectors that might work across platforms
  const joinSelectors = [
    'button:contains("Join")',
    'button:contains("Enter")',
    'button:contains("Start")',
    "button.join-button",
    "button.primary-button",
    'xpath://button[contains(., "Join")]',
    'xpath://button[contains(., "Enter")]',
  ]

  // Try all join button selectors
  for (const selector of joinSelectors) {
    if (tryClickButton(selector)) {
      logWithTime("Clicked generic join button: " + selector)
      break
    }
  }
}

function checkNetworkIssues() {
  // Check for poor connection indicators
  const connectionIssue =
    document.querySelector(".poor-connection-indicator") ||
    document.querySelector('[aria-label*="Poor connection"]') ||
    document.querySelector('[aria-label*="Unstable connection"]') ||
    document.querySelector('[data-tid="network-warning"]')

  if (connectionIssue) {
    networkRetries++
    logWithTime(`Network connection issues detected (retry ${networkRetries}/${MAX_NETWORK_RETRIES})`, "warn")

    if (networkRetries >= MAX_NETWORK_RETRIES) {
      // Try page reload as last resort for connection issues
      logWithTime("Attempting page reload due to persistent connection issues...", "warn")

      // Report the issue before reloading
      reportJoinFailure("network_issues")

      // Use a short delay before reload to allow the report to be sent
      setTimeout(() => window.location.reload(), 2000)
      return
    }

    // Increase backoff delay for future attempts
    networkBackoffDelay = Math.min(networkBackoffDelay * 2, 30000) // Max 30 seconds
  }
}

// Function to click button with multiple approaches
function tryClickButton(selector, logErrors = false) {
  try {
    // Direct querySelector method
    let button = null

    if (selector.startsWith("xpath://")) {
      // Use XPath
      try {
        const xpath = selector.replace("xpath://", "")
        const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null)
        button = result.singleNodeValue
      } catch (e) {
        if (logErrors) logWithTime("XPath selector error: " + e.message, "warn")
      }
    } else if (selector.includes(":contains(")) {
      // Text content matcher
      try {
        const textMatch = selector.match(/:contains$$"?([^"]+)"?$$/)
        if (textMatch && textMatch[1]) {
          const text = textMatch[1].toLowerCase()
          // Find button or span containing text
          const elements = Array.from(document.querySelectorAll("button, span, div"))
          button = elements.find(
            (el) =>
              el.textContent &&
              el.textContent.toLowerCase().includes(text) &&
              (el.tagName === "BUTTON" || el.closest("button")),
          )

          // If we found a span or div, get its parent button
          if (button && button.tagName !== "BUTTON") {
            button = button.closest("button")
          }
        }
      } catch (e) {
        if (logErrors) logWithTime("Text content selector error: " + e.message, "warn")
      }
    } else {
      // Standard selector
      button = document.querySelector(selector)
    }

    // Click button if found
    if (button) {
      // Check if button is visible and clickable
      const rect = button.getBoundingClientRect()
      const isVisible = rect.width > 0 && rect.height > 0

      if (isVisible) {
        // Log action
        if (logErrors) logWithTime("Found button to click: " + selector)

        // Click with both methods for best compatibility
        button.click()

        // Also dispatch event for extra reliability
        const mouseEvent = new MouseEvent("click", {
          view: window,
          bubbles: true,
          cancelable: true,
        })
        button.dispatchEvent(mouseEvent)

        return true
      } else {
        if (logErrors) logWithTime("Button found but not visible: " + selector, "warn")
      }
    }
    return false
  } catch (error) {
    // Avoid console.error to prevent error reporting - use log instead
    if (logErrors) logWithTime("Button click attempt failed: " + selector + " - " + error.message, "warn")
    return false
  }
}

// Report join failure to background script
function reportJoinFailure(reason) {
  try {
    if (typeof chrome !== "undefined" && chrome.runtime) {
      chrome.runtime.sendMessage({
        action: "joinStatus",
        status: "failed",
        reason: reason,
        url: window.location.href,
        attempts: joinAttempts,
      })
    } else {
      logWithTime("Chrome runtime is not available.", "warn")
    }
  } catch (e) {
    logWithTime("Failed to report join failure: " + e.message, "error")
  }
}

// Detect if we're actually in a meeting
function checkJoinStatus() {
  try {
    // Platform-specific indicators
    let inMeeting = false

    switch (meetingPlatform) {
      case "google":
        inMeeting = checkGoogleMeetJoinStatus()
        break
      case "zoom":
        inMeeting = checkZoomJoinStatus()
        break
      case "teams":
        inMeeting = checkTeamsJoinStatus()
        break
      case "webex":
        inMeeting = checkWebexJoinStatus()
        break
      default:
        inMeeting = checkGenericJoinStatus()
    }

    if (inMeeting && !joinSuccessful) {
      logWithTime("Successfully joined meeting!")

      // Mark as joined to stop auto-join attempts
      joinSuccessful = true

      // Notify background script
      try {
        // Check if chrome is defined
        if (typeof chrome !== "undefined" && chrome.runtime) {
          chrome.runtime.sendMessage({
            action: "joinStatus",
            status: "joined",
            url: window.location.href,
          })
        } else {
          logWithTime("Chrome runtime is not available.", "warn")
        }
      } catch (e) {
        // Chrome runtime might not be available
        logWithTime("Could not send join status to background script: " + e.message, "warn")
      }

      // Auto-mute functionality
      autoMuteDevices()

      // Clean up intervals and observers
      cleanup()
    }

    return inMeeting
  } catch (e) {
    logWithTime("Error checking join status: " + e.message, "error")
    return false
  }
}

// Clean up all intervals and observers
function cleanup() {
  if (joinInterval) {
    clearInterval(joinInterval)
    joinInterval = null
  }

  if (longPollInterval) {
    clearInterval(longPollInterval)
    longPollInterval = null
  }

  if (networkCheckInterval) {
    clearInterval(networkCheckInterval)
    networkCheckInterval = null
  }

  if (pageLoadTimeout) {
    clearTimeout(pageLoadTimeout)
    pageLoadTimeout = null
  }

  if (mutationObserver) {
    mutationObserver.disconnect()
    mutationObserver = null
  }

  logWithTime("Cleaned up all intervals and observers")
}

// Platform-specific join status check functions remain the same...
function checkGoogleMeetJoinStatus() {
  // Google Meet meeting indicators
  const meetingIndicators = [
    ".zWfAib", // Meeting interface container
    "[data-allocation-index]", // Video tiles
    'div[jscontroller="kAPMuc"]', // Meeting control bar
    'button[aria-label="Turn off microphone"]',
    'button[aria-label="Turn off camera"]',
    'button[aria-label="Present now"]',
    'div[aria-label="Chat with everyone"]',
  ]

  for (const indicator of meetingIndicators) {
    if (document.querySelector(indicator)) {
      return true
    }
  }
  return false
}

function checkZoomJoinStatus() {
  // Zoom meeting indicators
  const meetingIndicators = [
    ".meeting-app",
    ".meeting-client",
    ".meeting-info-container",
    'button[aria-label="mute my microphone"]',
    'button[aria-label="stop my video"]',
    ".footer-button__wrapper",
    ".video-avatar__container",
  ]

  for (const indicator of meetingIndicators) {
    if (document.querySelector(indicator)) {
      return true
    }
  }
  return false
}

function checkTeamsJoinStatus() {
  // Teams meeting indicators
  const meetingIndicators = [
    ".ts-calling-screen",
    ".ts-video-screen",
    ".calling-unified-bar",
    'button[data-tid="toggle-mute"]',
    'button[data-tid="toggle-video"]',
    ".ts-calling-screen-main",
    ".meeting-control-bar",
  ]

  for (const indicator of meetingIndicators) {
    if (document.querySelector(indicator)) {
      return true
    }
  }
  return false
}

function checkWebexJoinStatus() {
  // Webex meeting indicators
  const meetingIndicators = [
    ".meeting-container",
    ".call-container",
    ".call-controls",
    'button[aria-label="Mute"]',
    'button[aria-label="Stop video"]',
    ".meeting-info-indicator",
    ".video-layout-container",
  ]

  for (const indicator of meetingIndicators) {
    if (document.querySelector(indicator)) {
      return true
    }
  }
  return false
}

function checkGenericJoinStatus() {
  // Generic meeting indicators that might work across platforms
  const meetingIndicators = [
    // Video elements
    "video[autoplay]",
    // Audio elements
    "audio[autoplay]",
    // Common meeting UI elements
    ".meeting-container",
    ".video-container",
    ".call-controls",
    // Buttons that typically appear in active meetings
    'button[aria-label*="mute"]',
    'button[aria-label*="camera"]',
    'button[aria-label*="video"]',
    'button[aria-label*="leave"]',
    'button[aria-label*="end"]',
  ]

  for (const indicator of meetingIndicators) {
    if (document.querySelector(indicator)) {
      return true
    }
  }
  return false
}

// Auto-mute microphone and camera based on platform
function autoMuteDevices() {
  try {
    switch (meetingPlatform) {
      case "google":
        muteGoogleMeetDevices()
        break
      case "zoom":
        muteZoomDevices()
        break
      case "teams":
        muteTeamsDevices()
        break
      case "webex":
        muteWebexDevices()
        break
      default:
        muteGenericDevices()
    }
    logWithTime("Auto-muted devices")
  } catch (e) {
    logWithTime("Error during auto-mute: " + e.message, "warn")
  }
}

// Platform-specific mute functions remain the same...
function muteGoogleMeetDevices() {
  // Microphone mute button (look for unmuted state)
  const micButtons = [
    'button[aria-label="Turn off microphone"]',
    'button[data-tooltip="Turn off microphone"]',
    'button[aria-pressed="true"][aria-label*="microphone"]',
  ]

  // Camera mute button (look for unmuted state)
  const camButtons = [
    'button[aria-label="Turn off camera"]',
    'button[data-tooltip="Turn off camera"]',
    'button[aria-pressed="true"][aria-label*="camera"]',
  ]

  // Try to mute microphone if it's on
  for (const selector of micButtons) {
    if (tryClickButton(selector)) {
      logWithTime("Google Meet microphone muted automatically")
      break
    }
  }

  // Try to mute camera if it's on
  for (const selector of camButtons) {
    if (tryClickButton(selector)) {
      logWithTime("Google Meet camera muted automatically")
      break
    }
  }
}

function muteZoomDevices() {
  // Zoom mute buttons
  const micButtons = [
    'button[aria-label="mute my microphone"]',
    'button[aria-label="Mute"]',
    "button.join-audio-container__btn",
  ]

  const camButtons = ['button[aria-label="stop my video"]', 'button[aria-label="Stop Video"]']

  // Try to mute microphone
  for (const selector of micButtons) {
    if (tryClickButton(selector)) {
      logWithTime("Zoom microphone muted automatically")
      break
    }
  }

  // Try to mute camera
  for (const selector of camButtons) {
    if (tryClickButton(selector)) {
      logWithTime("Zoom camera muted automatically")
      break
    }
  }
}

function muteTeamsDevices() {
  // Teams mute buttons
  const micButtons = ['button[data-tid="toggle-mute"]', 'button[data-tid="call-control-mute"]', 'button[title*="Mute"]']

  const camButtons = [
    'button[data-tid="toggle-video"]',
    'button[data-tid="call-control-video"]',
    'button[title*="Camera"]',
  ]

  // Try to mute microphone
  for (const selector of micButtons) {
    if (tryClickButton(selector)) {
      logWithTime("Teams microphone muted automatically")
      break
    }
  }

  // Try to mute camera
  for (const selector of camButtons) {
    if (tryClickButton(selector)) {
      logWithTime("Teams camera muted automatically")
      break
    }
  }
}

function muteWebexDevices() {
  // Webex mute buttons
  const micButtons = ['button[aria-label="Mute"]', "button.mute-button", 'button[title*="Mute"]']

  const camButtons = ['button[aria-label="Stop video"]', "button.video-button", 'button[title*="video"]']

  // Try to mute microphone
  for (const selector of micButtons) {
    if (tryClickButton(selector)) {
      logWithTime("Webex microphone muted automatically")
      break
    }
  }

  // Try to mute camera
  for (const selector of camButtons) {
    if (tryClickButton(selector)) {
      logWithTime("Webex camera muted automatically")
      break
    }
  }
}

function muteGenericDevices() {
  // Generic mute buttons that might work across platforms
  const micButtons = [
    'button[aria-label*="mute"]',
    'button[title*="mute"]',
    "button.mute-button",
    'button:contains("Mute")',
  ]

  const camButtons = [
    'button[aria-label*="camera"]',
    'button[aria-label*="video"]',
    'button[title*="camera"]',
    'button[title*="video"]',
    "button.video-button",
    'button:contains("Stop video")',
  ]

  // Try to mute microphone
  for (const selector of micButtons) {
    if (tryClickButton(selector)) {
      logWithTime("Generic microphone muted automatically")
      break
    }
  }

  // Try to mute camera
  for (const selector of camButtons) {
    if (tryClickButton(selector)) {
      logWithTime("Generic camera muted automatically")
      break
    }
  }
}

// Handle slow connections by monitoring page load state
function monitorPageLoadState() {
  const currentState = document.readyState
  if (currentState !== "complete") {
    logWithTime("Page still loading, state: " + currentState)

    // If page is taking too long to load, consider reloading
    pageLoadTimeout = setTimeout(() => {
      if (document.readyState !== "complete") {
        logWithTime("Page load timeout, attempting reload...", "warn")

        // Report the issue before reloading
        reportJoinFailure("page_load_timeout")

        window.location.reload()
      }
    }, 60000) // 1 minute timeout

    // Clear timeout if page eventually loads
    window.addEventListener("load", () => {
      logWithTime("Page fully loaded")
      if (pageLoadTimeout) {
        clearTimeout(pageLoadTimeout)
        pageLoadTimeout = null
      }
    })
  }
}

// Helper function for the join button with textContent matching
Element.prototype.containsText = function (text) {
  return this.textContent && this.textContent.toLowerCase().includes(text.toLowerCase())
}

// Initialize everything when the script loads
initialize()

