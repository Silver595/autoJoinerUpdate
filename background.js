// Global state tracking to prevent duplicate meeting joins
let activeJoinAttempts = {}
let networkRecoveryMode = false
let lastNetworkCheck = 0

chrome.runtime.onInstalled.addListener(() => {
  console.log("[AutoMeet] Extension installed")
  setupPeriodicCheck()

  // Initialize storage with empty activeJoinAttempts if not exists
  chrome.storage.local.get("activeJoinAttempts", (data) => {
    if (!data.activeJoinAttempts) {
      chrome.storage.local.set({ activeJoinAttempts: {} })
    } else {
      // Load existing active join attempts
      activeJoinAttempts = data.activeJoinAttempts
    }
  })

  // Clear any stale logs on install
  chrome.storage.local.get("errorLogs", (data) => {
    const logs = data.errorLogs || []
    // Keep only logs from the last 7 days
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
    const filteredLogs = logs.filter((log) => log.timestamp > sevenDaysAgo)
    chrome.storage.local.set({ errorLogs: filteredLogs })
  })
})

// Create a periodic check that runs every minute
function setupPeriodicCheck() {
  chrome.alarms.create("recoveryCheck", {
    periodInMinutes: 1,
  })

  // Also create a network check alarm that runs every 5 minutes
  chrome.alarms.create("networkCheck", {
    periodInMinutes: 5,
  })
}

// Log function with severity levels and storage
function logEvent(message, severity = "info", storeInErrorLog = false) {
  const timestamp = new Date().toISOString()
  const logEntry = `[${timestamp}] [${severity.toUpperCase()}] ${message}`

  console.log(logEntry)

  // Store critical errors and warnings in persistent storage
  if (storeInErrorLog || severity === "error" || severity === "warning") {
    chrome.storage.local.get("errorLogs", (data) => {
      const logs = data.errorLogs || []
      logs.push({
        timestamp: Date.now(),
        message: message,
        severity: severity,
      })

      // Keep only the last 100 logs to prevent excessive storage use
      if (logs.length > 100) {
        logs.shift() // Remove oldest log
      }

      chrome.storage.local.set({ errorLogs: logs })
    })
  }
}

chrome.runtime.onStartup.addListener(() => {
  logEvent("System started - checking for missed meetings", "info")
  networkRecoveryMode = true // Set recovery mode on startup
  checkForMissedMeetings()
  setupPeriodicCheck()

  // Reset active join attempts on startup
  chrome.storage.local.set({ activeJoinAttempts: {} })
  activeJoinAttempts = {}
})

// Handle wake from sleep detection
chrome.idle.onStateChanged.addListener((state) => {
  if (state === "active") {
    logEvent("System became active - checking for missed meetings", "info")
    networkRecoveryMode = true // Set recovery mode when waking from idle
    checkNetworkStatus().then((isOnline) => {
      if (isOnline) {
        checkForMissedMeetings()
      } else {
        logEvent("Network unavailable after wake - will retry when connection is restored", "warning", true)
      }
    })
  }
})

// Check network status with fetch to verify actual connectivity
async function checkNetworkStatus() {
  lastNetworkCheck = Date.now()

  if (!navigator.onLine) {
    logEvent("Device reports offline status", "warning")
    return false
  }

  try {
    // Try to fetch a small resource to verify actual connectivity
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 5000) // 5 second timeout

    const response = await fetch("https://www.google.com/favicon.ico", {
      mode: "no-cors",
      cache: "no-store",
      signal: controller.signal,
    })

    clearTimeout(timeoutId)

    if (networkRecoveryMode) {
      logEvent("Network connectivity restored", "info")
      networkRecoveryMode = false
      checkForMissedMeetings() // Check for meetings when network is restored
    }

    return true
  } catch (error) {
    if (error.name === "AbortError") {
      logEvent("Network check timed out - connection may be slow", "warning", true)
    } else {
      logEvent(`Network check failed: ${error.message}`, "warning", true)
    }
    networkRecoveryMode = true
    return false
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "scheduleMeeting") {
    scheduleMeeting(request.details)
      .then((result) => sendResponse(result))
      .catch((error) => {
        logEvent(`Error scheduling meeting: ${error.message}`, "error", true)
        sendResponse({ status: "error", message: error.message })
      })
    return true // Keep the message channel open for async response
  }

  if (request.action === "cancelMeeting") {
    cancelMeeting(request.details)
      .then((result) => sendResponse(result))
      .catch((error) => {
        logEvent(`Error canceling meeting: ${error.message}`, "error", true)
        sendResponse({ status: "error", message: error.message })
      })
    return true
  }

  if (request.action === "joinStatus") {
    handleJoinStatusUpdate(request, sender)
      .then((result) => sendResponse(result))
      .catch((error) => {
        logEvent(`Error handling join status: ${error.message}`, "error", true)
        sendResponse({ status: "error", message: error.message })
      })
    return true
  }

  if (request.action === "getErrorLogs") {
    chrome.storage.local.get("errorLogs", (data) => {
      sendResponse({ logs: data.errorLogs || [] })
    })
    return true
  }

  if (request.action === "clearErrorLogs") {
    chrome.storage.local.set({ errorLogs: [] }, () => {
      sendResponse({ status: "success" })
    })
    return true
  }

  if (request.action === "checkNetworkStatus") {
    checkNetworkStatus()
      .then((isOnline) => sendResponse({ online: isOnline }))
      .catch((error) => {
        logEvent(`Error checking network: ${error.message}`, "error", true)
        sendResponse({ online: false, error: error.message })
      })
    return true
  }
})

async function handleJoinStatusUpdate(request, sender) {
  try {
    logEvent(`Join status update: ${request.status} for URL: ${request.url}`, "info")

    if (request.status === "joined" && request.url) {
      // Get the meeting ID from the URL or tab
      const meetingId = getMeetingIdFromUrl(request.url)

      if (meetingId && activeJoinAttempts[meetingId]) {
        logEvent(`Successfully joined meeting: ${meetingId}`, "info")

        // Clear the active join attempt
        delete activeJoinAttempts[meetingId]
        await updateActiveJoinAttemptsStorage()

        // Update meeting status in storage
        await updateMeetingJoinStatus(request.url)
      }
    } else if (request.status === "failed" && request.url) {
      const meetingId = getMeetingIdFromUrl(request.url)

      if (meetingId) {
        logEvent(`Failed to join meeting: ${meetingId}, reason: ${request.reason || "unknown"}`, "warning", true)

        // If this was an active join attempt, increment the attempt count
        if (activeJoinAttempts[meetingId]) {
          activeJoinAttempts[meetingId].attempts++

          // If we've exceeded max attempts, mark as failed
          if (activeJoinAttempts[meetingId].attempts >= 5) {
            logEvent(`Max join attempts reached for meeting: ${meetingId}`, "error", true)
            delete activeJoinAttempts[meetingId]
          }

          await updateActiveJoinAttemptsStorage()
        }
      }
    }

    return { status: "success" }
  } catch (error) {
    logEvent(`Error in handleJoinStatusUpdate: ${error.message}`, "error", true)
    throw error
  }
}

// Extract a unique meeting ID from URL
function getMeetingIdFromUrl(url) {
  try {
    const urlObj = new URL(url)

    // Google Meet format: https://meet.google.com/abc-defg-hij
    if (urlObj.hostname.includes("meet.google.com")) {
      const pathParts = urlObj.pathname.split("/")
      return pathParts[pathParts.length - 1] || url
    }

    // Zoom format: https://zoom.us/j/1234567890
    if (urlObj.hostname.includes("zoom.us")) {
      const pathParts = urlObj.pathname.split("/")
      return pathParts.length > 2 ? pathParts[2] : url
    }

    // Teams and other platforms - use the full URL as ID
    return url
  } catch (e) {
    logEvent(`Error extracting meeting ID from URL: ${e.message}`, "error", true)
    return url // Fallback to using the full URL
  }
}

async function updateMeetingJoinStatus(meetingUrl) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get("scheduledMeetings", (data) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
        return
      }

      if (!data.scheduledMeetings) {
        resolve()
        return
      }

      const meetings = data.scheduledMeetings
      let updated = false

      for (let i = 0; i < meetings.length; i++) {
        if (meetings[i].link === meetingUrl && !meetings[i].joined) {
          meetings[i].joined = true
          meetings[i].joinedAt = Date.now()
          updated = true
          logEvent(`Marked meeting as joined: ${meetingUrl}`, "info")
        }
      }

      if (updated) {
        chrome.storage.local.set({ scheduledMeetings: meetings }, () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message))
          } else {
            resolve()
          }
        })
      } else {
        resolve()
      }
    })
  })
}

async function updateActiveJoinAttemptsStorage() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ activeJoinAttempts }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
      } else {
        resolve()
      }
    })
  })
}

async function scheduleMeeting(details) {
  try {
    // Input validation - prevent errors from invalid inputs
    if (!details || !details.link || !details.startTime || !details.autoCloseDuration) {
      throw new Error("Invalid meeting details provided")
    }

    // Ensure startTime is a number
    const startTime = typeof details.startTime === "number" ? details.startTime : Number.parseInt(details.startTime)
    if (isNaN(startTime)) {
      throw new Error("Invalid start time")
    }

    // Ensure autoCloseDuration is a number
    const autoCloseDuration =
      typeof details.autoCloseDuration === "number"
        ? details.autoCloseDuration
        : Number.parseInt(details.autoCloseDuration)
    if (isNaN(autoCloseDuration)) {
      throw new Error("Invalid auto close duration")
    }

    // Store the exact timestamp for the meeting
    const meetingData = {
      link: details.link,
      startTime: startTime,
      autoCloseDuration: autoCloseDuration,
      scheduled: Date.now(),
      completed: false,
      joined: false,
      joinAttempts: 0,
      platform: detectMeetingPlatform(details.link),
      id: getMeetingIdFromUrl(details.link),
    }

    // Create unique alarm names with timestamps to avoid conflicts
    const alarmBaseName = startTime.toString()

    // Create an alarm for meeting start time
    chrome.alarms.create("meetingStart_" + alarmBaseName, {
      when: startTime,
    })

    // Create an alarm for auto-close
    chrome.alarms.create("meetingClose_" + alarmBaseName, {
      when: startTime + autoCloseDuration * 60 * 1000,
    })

    // Store meeting details in persistent storage
    return new Promise((resolve, reject) => {
      chrome.storage.local.get("scheduledMeetings", (data) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message))
          return
        }

        let meetings = data.scheduledMeetings || []

        // Check for and remove any duplicate meetings (same link and start time)
        meetings = meetings.filter((m) => m.link !== meetingData.link || m.startTime !== meetingData.startTime)

        meetings.push(meetingData)

        chrome.storage.local.set({ scheduledMeetings: meetings }, () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message))
          } else {
            logEvent(`Meeting scheduled for: ${new Date(startTime).toLocaleString()} - ${meetingData.link}`, "info")
            resolve({ status: "success", message: "Meeting scheduled successfully" })
          }
        })
      })
    })
  } catch (error) {
    logEvent(`Error in scheduleMeeting: ${error.message}`, "error", true)
    throw error
  }
}

async function cancelMeeting(details) {
  try {
    if (!details || !details.startTime) {
      throw new Error("Invalid meeting details for cancellation")
    }

    const startTime = typeof details.startTime === "number" ? details.startTime : Number.parseInt(details.startTime)
    if (isNaN(startTime)) {
      throw new Error("Invalid start time for cancellation")
    }

    // Clear the alarms associated with this meeting
    await clearMeetingAlarms(startTime.toString())

    // Update storage to mark meeting as canceled
    return new Promise((resolve, reject) => {
      chrome.storage.local.get("scheduledMeetings", (data) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message))
          return
        }

        if (!data.scheduledMeetings) {
          resolve({ status: "success", message: "No meetings to cancel" })
          return
        }

        // Find the meeting to cancel
        const meetingToCancel = data.scheduledMeetings.find((m) => m.startTime === startTime)

        // Remove the meeting from the list
        const meetings = data.scheduledMeetings.filter((m) => m.startTime !== startTime)

        // Also remove from active join attempts if present
        if (meetingToCancel && meetingToCancel.id) {
          delete activeJoinAttempts[meetingToCancel.id]
        }

        // Update both storage objects
        Promise.all([
          new Promise((res, rej) => {
            chrome.storage.local.set({ scheduledMeetings: meetings }, () => {
              if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message))
              else res()
            })
          }),
          updateActiveJoinAttemptsStorage(),
        ])
          .then(() => {
            logEvent(`Meeting canceled: ${new Date(startTime).toLocaleString()}`, "info")
            resolve({ status: "success", message: "Meeting canceled successfully" })
          })
          .catch((err) => {
            reject(err)
          })
      })
    })
  } catch (error) {
    logEvent(`Error in cancelMeeting: ${error.message}`, "error", true)
    throw error
  }
}

async function clearMeetingAlarms(startTimeStr) {
  return Promise.all([
    new Promise((resolve) => {
      chrome.alarms.clear("meetingStart_" + startTimeStr, (wasCleared) => {
        resolve(wasCleared)
      })
    }),
    new Promise((resolve) => {
      chrome.alarms.clear("meetingClose_" + startTimeStr, (wasCleared) => {
        resolve(wasCleared)
      })
    }),
  ])
}

function detectMeetingPlatform(url) {
  if (!url) return "unknown"

  if (url.includes("meet.google.com")) return "google"
  if (url.includes("zoom.us")) return "zoom"
  if (url.includes("teams.microsoft.com")) return "teams"
  if (url.includes("webex.com")) return "webex"

  return "other"
}

async function checkForMissedMeetings() {
  try {
    const now = Date.now()

    // Don't check too frequently to avoid excessive resource usage
    if (now - lastNetworkCheck > 60000) {
      // 1 minute
      const isOnline = await checkNetworkStatus()
      if (!isOnline) {
        logEvent("Network unavailable during missed meetings check", "warning")
        return
      }
    }

    return new Promise((resolve, reject) => {
      chrome.storage.local.get(["scheduledMeetings", "activeJoinAttempts"], (data) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message))
          return
        }

        if (!data.scheduledMeetings || data.scheduledMeetings.length === 0) {
          resolve()
          return
        }

        // Load active join attempts from storage
        activeJoinAttempts = data.activeJoinAttempts || {}

        const updatedMeetings = []
        let needUpdate = false

        data.scheduledMeetings.forEach((meeting) => {
          // Validate meeting object has required properties
          if (!meeting || typeof meeting.startTime !== "number" || !meeting.link) {
            needUpdate = true // Skip invalid meeting objects
            return
          }

          // Check if this is a missed meeting that should be joined now
          // Criteria: Meeting start time is in the past, but not more than 30 minutes ago
          // AND the meeting hasn't been marked as completed or joined
          const meetingId = meeting.id || getMeetingIdFromUrl(meeting.link)
          const isActivelyJoining = activeJoinAttempts[meetingId]

          if (
            !meeting.completed &&
            !meeting.joined &&
            !isActivelyJoining &&
            meeting.startTime <= now &&
            now - meeting.startTime < 30 * 60 * 1000
          ) {
            logEvent(`Found missed meeting! Attempting to join: ${meeting.link}`, "info")

            // Track join attempts to prevent infinite retries
            meeting.joinAttempts = (meeting.joinAttempts || 0) + 1

            // Only try to join if we haven't exceeded max attempts (5)
            if (meeting.joinAttempts <= 5) {
              // Mark this meeting as being actively joined to prevent duplicate tabs
              activeJoinAttempts[meetingId] = {
                startTime: meeting.startTime,
                attempts: 1,
                timestamp: now,
              }

              // Open the meeting in a new tab
              chrome.tabs.create({ url: meeting.link })
              needUpdate = true
            } else if (!meeting.completed) {
              logEvent(`Max join attempts reached for meeting: ${meeting.link}`, "warning", true)
              meeting.completed = true
              needUpdate = true
            }
          }

          // Keep meetings for the current day only
          const oneDayAgo = now - 24 * 60 * 60 * 1000
          if (meeting.startTime > oneDayAgo) {
            updatedMeetings.push(meeting)
          } else {
            needUpdate = true // We're removing old meetings
          }
        })

        // Update storage if needed
        if (needUpdate) {
          Promise.all([
            new Promise((res, rej) => {
              chrome.storage.local.set({ scheduledMeetings: updatedMeetings }, () => {
                if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message))
                else res()
              })
            }),
            updateActiveJoinAttemptsStorage(),
          ])
            .then(() => {
              resolve()
            })
            .catch((err) => {
              reject(err)
            })
        } else {
          resolve()
        }
      })
    })
  } catch (error) {
    logEvent(`Error in checkForMissedMeetings: ${error.message}`, "error", true)
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  logEvent("Alarm triggered: " + alarm.name, "info")

  try {
    // Handle specific meeting start alarm
    if (alarm.name.startsWith("meetingStart_")) {
      handleMeetingStartAlarm(alarm.name)
    }
    // Handle specific meeting close alarm
    else if (alarm.name.startsWith("meetingClose_")) {
      handleMeetingCloseAlarm(alarm.name)
    }
    // Handle recovery check alarm (runs every minute)
    else if (alarm.name === "recoveryCheck") {
      checkForMissedMeetings().catch((error) => {
        logEvent(`Error in recovery check: ${error.message}`, "error", true)
      })
    }
    // Handle network check alarm
    else if (alarm.name === "networkCheck") {
      checkNetworkStatus().catch((error) => {
        logEvent(`Error in network check: ${error.message}`, "error", true)
      })
    }
  } catch (error) {
    logEvent(`Error handling alarm ${alarm.name}: ${error.message}`, "error", true)
  }
})

async function handleMeetingStartAlarm(alarmName) {
  try {
    const startTimePart = alarmName.split("_")[1]
    if (!startTimePart) {
      throw new Error("Invalid alarm name format: " + alarmName)
    }

    const startTime = Number.parseInt(startTimePart)
    if (isNaN(startTime)) {
      throw new Error("Could not parse start time from alarm: " + alarmName)
    }

    // Check network status before attempting to join
    const isOnline = await checkNetworkStatus()
    if (!isOnline) {
      logEvent(
        "Network unavailable when trying to join meeting - will retry when connection is restored",
        "warning",
        true,
      )
      return
    }

    return new Promise((resolve, reject) => {
      chrome.storage.local.get("scheduledMeetings", (data) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message))
          return
        }

        if (!data.scheduledMeetings) {
          resolve()
          return
        }

        // Find the meeting with matching start time
        const meeting = data.scheduledMeetings.find((m) => m.startTime === startTime)
        if (!meeting || meeting.completed || meeting.joined) {
          resolve()
          return
        }

        const meetingId = meeting.id || getMeetingIdFromUrl(meeting.link)

        // Check if we're already trying to join this meeting
        if (activeJoinAttempts[meetingId]) {
          logEvent(`Already attempting to join meeting: ${meeting.link}`, "warning")
          resolve()
          return
        }

        logEvent(`Starting scheduled meeting: ${meeting.link}`, "info")

        // Mark this meeting as being actively joined
        activeJoinAttempts[meetingId] = {
          startTime: meeting.startTime,
          attempts: 1,
          timestamp: Date.now(),
        }

        // Wake up the system if possible (requires "system.display" permission)
        try {
          if (chrome.system && chrome.system.display) {
            chrome.system.display.getInfo((info) => {
              // Attempt to keep display on
              chrome.system.display.setDisplayProperties(info[0].id, { isEnabled: true }, () => {})
            })
          }
        } catch (e) {
          logEvent("Unable to control display: " + e.message, "warning")
        }

        // Open the meeting in a new tab
        chrome.tabs.create({ url: meeting.link })

        // Update meeting status
        meeting.joinAttempts = (meeting.joinAttempts || 0) + 1

        const updatedMeetings = data.scheduledMeetings.map((m) => {
          if (m.startTime === startTime) {
            return { ...m, joinAttempts: meeting.joinAttempts }
          }
          return m
        })

        Promise.all([
          new Promise((res, rej) => {
            chrome.storage.local.set({ scheduledMeetings: updatedMeetings }, () => {
              if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message))
              else res()
            })
          }),
          updateActiveJoinAttemptsStorage(),
        ])
          .then(() => {
            resolve()
          })
          .catch((err) => {
            reject(err)
          })
      })
    })
  } catch (error) {
    logEvent(`Error in handleMeetingStartAlarm: ${error.message}`, "error", true)
    throw error
  }
}

async function handleMeetingCloseAlarm(alarmName) {
  try {
    const startTimePart = alarmName.split("_")[1]
    if (!startTimePart) {
      throw new Error("Invalid alarm name format for close: " + alarmName)
    }

    const startTime = Number.parseInt(startTimePart)
    if (isNaN(startTime)) {
      throw new Error("Could not parse start time from close alarm: " + alarmName)
    }

    return new Promise((resolve, reject) => {
      chrome.storage.local.get("scheduledMeetings", (data) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message))
          return
        }

        if (!data.scheduledMeetings) {
          resolve()
          return
        }

        // Find the meeting with matching start time
        const meeting = data.scheduledMeetings.find((m) => m.startTime === startTime)
        if (!meeting) {
          resolve()
          return
        }

        // Close tabs based on the meeting platform
        const platform = meeting.platform || detectMeetingPlatform(meeting.link)

        let urlPattern = "*://meet.google.com/*" // Default to Google Meet

        if (platform === "zoom") urlPattern = "*://*.zoom.us/j/*"
        else if (platform === "teams") urlPattern = "*://*.teams.microsoft.com/*"
        else if (platform === "webex") urlPattern = "*://*.webex.com/meet/*"

        chrome.tabs.query({ url: urlPattern }, (tabs) => {
          if (tabs.length > 0) {
            logEvent(`Auto-closing meeting tabs, count: ${tabs.length}`, "info")
            tabs.forEach((tab) => chrome.tabs.remove(tab.id))
            chrome.notifications.create({
              type: "basic",
              iconUrl: "images/icon128.png",
              title: "Meeting Closed",
              message: "Your meeting has been automatically closed.",
            })
          }
        })

        // Mark meeting as completed
        const updatedMeetings = data.scheduledMeetings.map((m) => {
          if (m.startTime === startTime) {
            return { ...m, completed: true }
          }
          return m
        })

        // Also remove from active join attempts if present
        if (meeting.id) {
          delete activeJoinAttempts[meeting.id]
        }

        Promise.all([
          new Promise((res, rej) => {
            chrome.storage.local.set({ scheduledMeetings: updatedMeetings }, () => {
              if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message))
              else res()
            })
          }),
          updateActiveJoinAttemptsStorage(),
        ])
          .then(() => {
            resolve()
          })
          .catch((err) => {
            reject(err)
          })
      })
    })
  } catch (error) {
    logEvent(`Error in handleMeetingCloseAlarm: ${error.message}`, "error", true)
    throw error
  }
}

// Handle potential error when extension updates
chrome.runtime.onUpdateAvailable.addListener(() => {
  // Reset alarms on update to prevent issues
  chrome.alarms.getAll((alarms) => {
    alarms.forEach((alarm) => {
      if (alarm.name !== "recoveryCheck" && alarm.name !== "networkCheck") {
        chrome.alarms.clear(alarm.name)
      }
    })
  })

  // Check for any missed meetings before update
  checkForMissedMeetings().catch((error) => {
    logEvent(`Error checking for missed meetings before update: ${error.message}`, "error", true)
  })
})

// Clean up stale active join attempts periodically
function cleanupStaleJoinAttempts() {
  const now = Date.now()
  let hasChanges = false

  // Consider an attempt stale if it's been more than 10 minutes
  const staleThreshold = now - 10 * 60 * 1000

  for (const meetingId in activeJoinAttempts) {
    if (activeJoinAttempts[meetingId].timestamp < staleThreshold) {
      logEvent(`Removing stale join attempt for meeting: ${meetingId}`, "info")
      delete activeJoinAttempts[meetingId]
      hasChanges = true
    }
  }

  if (hasChanges) {
    updateActiveJoinAttemptsStorage().catch((error) => {
      logEvent(`Error updating active join attempts: ${error.message}`, "error", true)
    })
  }
}

// Run cleanup every 5 minutes
setInterval(cleanupStaleJoinAttempts, 5 * 60 * 1000)

// Listen for browser wake events
chrome.power &&
  chrome.power.onWakeup &&
  chrome.power.onWakeup.addListener(() => {
    logEvent("System woke up - checking for missed meetings", "info")
    networkRecoveryMode = true
    checkNetworkStatus()
      .then((isOnline) => {
        if (isOnline) {
          checkForMissedMeetings()
        } else {
          logEvent("Network unavailable after wake - will retry when connection is restored", "warning", true)
        }
      })
      .catch((error) => {
        logEvent(`Error checking network after wake: ${error.message}`, "error", true)
      })
  })

