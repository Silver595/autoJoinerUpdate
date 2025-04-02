function autoJoinMeeting() {
    // Advanced button selection strategies
    const joinSelectors = [
      'button[data-tooltip="Join now"]',
      'button[aria-label="Ask to join"]',
      'button:contains("Join now")',
      'button:contains("Ask to join")',
      // XPath selectors for more flexible matching
      'xpath://button[contains(translate(text(), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "join")]',
      'xpath://button[contains(translate(text(), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "ask to join")]'
    ];

    // Function to click button with multiple approaches
    function tryClickButton(selector) {
      // Direct querySelector method
      let button = document.querySelector(selector);

      // If direct selector fails, try more complex methods
      if (!button && selector.startsWith('xpath://')) {
        const xpathResult = document.evaluate(
          selector.replace('xpath://', ''),
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null
        );
        button = xpathResult.singleNodeValue;
      }

      // Fallback: text content matching
      if (!button && selector.includes(':contains(')) {
        const text = selector.match(/:contains\("(.+)"\)/)[1];
        button = Array.from(document.querySelectorAll('button'))
          .find(el => el.textContent.toLowerCase().includes(text.toLowerCase()));
      }

      // Click button if found
      if (button) {
        try {
          // Simulate mouse events for better compatibility
          const mouseEvent = new MouseEvent('click', {
            view: window,
            bubbles: true,
            cancelable: true
          });
          button.dispatchEvent(mouseEvent);
          console.log('Successfully clicked join button:', selector);
          return true;
        } catch (error) {
          console.error('Error clicking button:', error);
        }
      }
      return false;
    }

    // Try all join button selectors
    for (const selector of joinSelectors) {
      if (tryClickButton(selector)) {
        break;
      }
    }

    // Dismiss common popups and overlays
    const dismissSelectors = [
      'button[aria-label="Close"]',
      'button[data-tooltip="Close"]',
      'button:contains("Close")',
      'xpath://button[contains(translate(text(), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "close")]'
    ];

    dismissSelectors.forEach(selector => {
      const dismissButton = document.querySelector(selector);
      if (dismissButton) dismissButton.click();
    });
  }

  // Run auto-join on page load, immediately and then periodically
  autoJoinMeeting();
  setInterval(autoJoinMeeting, 5000);  // Reduced interval for quicker response
