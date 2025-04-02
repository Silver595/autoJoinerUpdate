// Global variables to track state
let joinAttempts = 0;
let joinSuccessful = false;
let networkRetries = 0;
const MAX_JOIN_ATTEMPTS = 20;
const MAX_NETWORK_RETRIES = 5;

function autoJoinMeeting() {
  // Don't keep trying if we've already joined or exceeded max attempts
  if (joinSuccessful) {
    return;
  }

  if (joinAttempts > MAX_JOIN_ATTEMPTS) {
    console.log('Max join attempts reached. Pausing automatic join attempts.');
    return;
  }

  joinAttempts++;

  // Check if page is fully loaded
  if (document.readyState !== 'complete') {
    console.log('Page still loading, waiting before attempting to join...');
    return;
  }

  // Check for loading indicators
  const loadingIndicators = document.querySelectorAll('.loading-indicator, .loadingIndicator, [role="progressbar"]');
  if (loadingIndicators.length > 0) {
    console.log('Loading indicators present, waiting...');
    return;
  }

  // Advanced button selection strategies
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
    'xpath://span[contains(text(), "Ask to join")]/ancestor::button'
  ];

  // Function to click button with multiple approaches
  function tryClickButton(selector, logErrors = false) {
    try {
      // Direct querySelector method
      let button = null;

      if (selector.startsWith('xpath://')) {
        // Use XPath
        try {
          const xpath = selector.replace('xpath://', '');
          const result = document.evaluate(
            xpath,
            document,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null
          );
          button = result.singleNodeValue;
        } catch (e) {
          if (logErrors) console.log('XPath selector error:', e);
        }
      }
      else if (selector.includes(':contains(')) {
        // Text content matcher
        try {
          const textMatch = selector.match(/:contains\("?([^"]+)"?\)/);
          if (textMatch && textMatch[1]) {
            const text = textMatch[1].toLowerCase();
            // Find button or span containing text
            const elements = Array.from(document.querySelectorAll('button, span'));
            button = elements.find(el =>
              el.textContent &&
              el.textContent.toLowerCase().includes(text) &&
              (el.tagName === 'BUTTON' || el.closest('button'))
            );

            // If we found a span, get its parent button
            if (button && button.tagName !== 'BUTTON') {
              button = button.closest('button');
            }
          }
        } catch (e) {
          if (logErrors) console.log('Text content selector error:', e);
        }
      }
      else {
        // Standard selector
        button = document.querySelector(selector);
      }

      // Click button if found
      if (button) {
        // Check if button is visible and clickable
        const rect = button.getBoundingClientRect();
        const isVisible = rect.width > 0 && rect.height > 0;

        if (isVisible) {
          // Log action
          console.log('Found button to click:', selector);

          // Click with both methods for best compatibility
          button.click();

          // Also dispatch event for extra reliability
          const mouseEvent = new MouseEvent('click', {
            view: window,
            bubbles: true,
            cancelable: true
          });
          button.dispatchEvent(mouseEvent);

          return true;
        } else {
          if (logErrors) console.log('Button found but not visible:', selector);
        }
      }
      return false;
    } catch (error) {
      // Avoid console.error to prevent error reporting - use log instead
      if (logErrors) console.log('Button click attempt failed:', selector, error.message);
      return false;
    }
  }

  // Try all join button selectors
  let joinButtonFound = false;
  for (const selector of joinSelectors) {
    if (tryClickButton(selector)) {
      joinButtonFound = true;
      break;
    }
  }

  // Handle network connection issues
  if (!joinButtonFound) {
    // Check for poor connection indicators
    const connectionIssue = document.querySelector('.poor-connection-indicator') ||
                           document.querySelector('[aria-label*="Poor connection"]') ||
                           document.querySelector('[aria-label*="Unstable connection"]');

    if (connectionIssue) {
      networkRetries++;
      console.log(`Network connection issues detected (retry ${networkRetries}/${MAX_NETWORK_RETRIES})`);

      if (networkRetries >= MAX_NETWORK_RETRIES) {
        // Try page reload as last resort for connection issues
        console.log('Attempting page reload due to persistent connection issues...');
        setTimeout(() => window.location.reload(), 2000);
        return;
      }
    }
  }

  // Dismiss common popups and overlays
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
    'xpath://button[contains(., "Dismiss")]'
  ];

  // Try to dismiss popups without logging errors
  for (const selector of dismissSelectors) {
    tryClickButton(selector, false);
  }
}

// Detect if we're actually in a meeting
function checkJoinStatus() {
  try {
    // Several different UI elements that indicate we're in a meeting
    const meetingIndicators = [
      '.zWfAib',                           // Meeting interface container
      '[data-allocation-index]',           // Video tiles
      'div[jscontroller="kAPMuc"]',        // Meeting control bar
      'button[aria-label="Turn off microphone"]',
      'button[aria-label="Turn off camera"]',
      'button[aria-label="Present now"]',
      'div[aria-label="Chat with everyone"]'
    ];

    for (const indicator of meetingIndicators) {
      if (document.querySelector(indicator)) {
        if (!joinSuccessful) {
          console.log('Successfully joined meeting!');

          // Mark as joined to stop auto-join attempts
          joinSuccessful = true;

          // Notify background script
          try {
            chrome.runtime.sendMessage({
              action: 'joinStatus',
              status: 'joined',
              url: window.location.href
            });
          } catch (e) {
            // Chrome runtime might not be available
            console.log('Could not send join status to background script');
          }

          // Auto-mute functionality
          autoMuteDevices();
        }
        return true;
      }
    }
    return false;
  } catch (e) {
    console.log('Error checking join status:', e.message);
    return false;
  }
}

// Auto-mute microphone and camera
function autoMuteDevices() {
  try {
    // Microphone mute button (look for unmuted state)
    const micButtons = [
      'button[aria-label="Turn off microphone"]',
      'button[data-tooltip="Turn off microphone"]',
      'button[aria-pressed="true"][aria-label*="microphone"]'
    ];

    // Camera mute button (look for unmuted state)
    const camButtons = [
      'button[aria-label="Turn off camera"]',
      'button[data-tooltip="Turn off camera"]',
      'button[aria-pressed="true"][aria-label*="camera"]'
    ];

    // Try to mute microphone if it's on
    for (const selector of micButtons) {
      if (tryClickButton(selector)) {
        console.log('Microphone muted automatically');
        break;
      }
    }

    // Try to mute camera if it's on
    for (const selector of camButtons) {
      if (tryClickButton(selector)) {
        console.log('Camera muted automatically');
        break;
      }
    }
  } catch (e) {
    console.log('Error during auto-mute:', e.message);
  }

  function tryClickButton(selector) {
    try {
      const button = document.querySelector(selector);
      if (button) {
        button.click();
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }
}

// Handle slow connections by monitoring page load state
function monitorPageLoadState() {
  const currentState = document.readyState;
  if (currentState !== 'complete') {
    console.log('Page still loading, state:', currentState);

    // If page is taking too long to load, consider reloading
    const loadTimeout = setTimeout(() => {
      if (document.readyState !== 'complete') {
        console.log('Page load timeout, attempting reload...');
        window.location.reload();
      }
    }, 60000); // 1 minute timeout

    // Clear timeout if page eventually loads
    window.addEventListener('load', () => {
      console.log('Page fully loaded');
      clearTimeout(loadTimeout);
    });
  }
}

// Initial page load monitoring
monitorPageLoadState();

// Run auto-join with an initial delay to ensure page has loaded, then periodically
setTimeout(() => {
  autoJoinMeeting();
  checkJoinStatus();
}, 3000);

// Run at different intervals to catch different scenarios
const shortInterval = setInterval(() => {
  autoJoinMeeting();
  if (checkJoinStatus()) {
    // If successfully joined, reduce check frequency
    clearInterval(shortInterval);
  }
}, 3000);

// Keep a longer interval active to handle delayed UI changes
setInterval(() => {
  if (!joinSuccessful) {
    autoJoinMeeting();
    checkJoinStatus();
  }
}, 10000);

// Detect network status changes
window.addEventListener('online', () => {
  console.log('Network connection restored - attempting to rejoin');
  networkRetries = 0;
  autoJoinMeeting();
});

window.addEventListener('offline', () => {
  console.log('Network connection lost');
});

// Watch for DOM changes to detect when join buttons appear
const observer = new MutationObserver(() => {
  if (!joinSuccessful) {
    autoJoinMeeting();
  }
});

// Start observing the document with the configured parameters
observer.observe(document.body, {
  childList: true,
  subtree: true,
  attributes: true,
  characterData: false
});

// Function to handle page visibility changes (for when browser tab is hidden)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !joinSuccessful) {
    console.log('Tab became visible, attempting to join meeting');
    autoJoinMeeting();
  }
});

// Helper function for the join button with textContent matching
Element.prototype.containsText = function(text) {
  return this.textContent && this.textContent.toLowerCase().includes(text.toLowerCase());
};
