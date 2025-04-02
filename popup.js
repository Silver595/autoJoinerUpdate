document.addEventListener("DOMContentLoaded", () => {
    // Get all required DOM elements - adding error handling if elements aren't found
    const meetingLinkInput = document.getElementById("meetingLink") || createFallbackElement("input", "meetingLink")
    const startTimeInput =
      document.getElementById("startTime") || createFallbackElement("input", "startTime", "datetime-local")
    const autoCloseDurationInput =
      document.getElementById("autoCloseDuration") || createFallbackElement("input", "autoCloseDuration")
    const scheduleMeetingButton =
      document.getElementById("scheduleMeeting") || createFallbackElement("button", "scheduleMeeting")
    const statusDiv = document.getElementById("status") || createFallbackElement("div", "status")
    const upcomingMeetingsDiv =
      document.getElementById("upcomingMeetings") || createFallbackElement("div", "upcomingMeetings")

    // Create connection status div if it doesn't exist
    const connectionStatusDiv =
      document.getElementById("connectionStatus") ||
      (() => {
        const div = document.createElement("div")
        div.id = "connectionStatus"
        div.className = "connection-status"
        document.body.appendChild(div)
        return div
      })()

    // Create error logs section if it doesn't exist
    const errorLogsDiv =
      document.getElementById("errorLogs") ||
      (() => {
        const container = document.createElement("div")
        container.id = "errorLogs"
        container.className = "error-logs-container"
        container.innerHTML = `
                  <div class="error-logs-header">
                      <h2>Error Logs</h2>
                      <button id="toggleErrorLogs" class="toggle-logs-button">Show Logs</button>
                      <button id="clearErrorLogs" class="clear-logs-button">Clear Logs</button>
                  </div>
                  <div id="errorLogsContent" class="error-logs-content" style="display: none;"></div>
              `
        document.body.appendChild(container)
        return container
      })()

    // Helper function to create fallback elements if they don't exist
    function createFallbackElement(type, id, inputType) {
      console.warn(`Element with ID '${id}' not found, creating fallback element`)
      const element = document.createElement(type)
      element.id = id
      if (inputType) element.type = inputType
      document.body.appendChild(element)
      return element
    }

    // Set default values - Adding try-catch for date operations
    try {
      const now = new Date()
      // Set default time to next hour
      now.setHours(now.getHours() + 1)
      now.setMinutes(0)
      now.setSeconds(0)

      // Format date-time for the input - handle potential ISO errors
      const defaultDateTime = now.toISOString().slice(0, 16)
      startTimeInput.value = defaultDateTime
    } catch (e) {
      console.error("Error setting default date:", e)
      // Fallback to simple string format
      const now = new Date()
      startTimeInput.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
        now.getDate(),
      ).padStart(2, "0")}T${String(now.getHours() + 1).padStart(2, "0")}:00`
    }

    autoCloseDurationInput.value = "60" // Default 60 minutes

    // Check network status initially
    updateConnectionStatus()

    // Load and display upcoming meetings - wrapped in try-catch
    try {
      loadUpcomingMeetings()
    } catch (e) {
      console.error("Error loading meetings:", e)
      showStatus("Error loading meetings. Please refresh the page.", "error")
    }

    // Load error logs
    loadErrorLogs()

    // Set up error logs toggle button
    document.getElementById("toggleErrorLogs").addEventListener("click", function () {
      const logsContent = document.getElementById("errorLogsContent")
      const isVisible = logsContent.style.display !== "none"

      logsContent.style.display = isVisible ? "none" : "block"
      this.textContent = isVisible ? "Show Logs" : "Hide Logs"

      if (!isVisible) {
        // Refresh logs when showing
        loadErrorLogs()
      }
    })

    // Set up clear logs button
    document.getElementById("clearErrorLogs").addEventListener("click", () => {
      chrome.runtime.sendMessage(
        {
          action: "clearErrorLogs",
        },
        (response) => {
          if (chrome.runtime.lastError) {
            console.error("Error clearing logs:", chrome.runtime.lastError)
            return
          }

          document.getElementById("errorLogsContent").innerHTML = '<p class="no-logs">No error logs</p>'
          showStatus("Error logs cleared", "success")
        },
      )
    })

    // Periodically check connection status
    setInterval(updateConnectionStatus, 30000)

    // Handle form submission with error handling
    scheduleMeetingButton.addEventListener("click", () => {
      try {
        // Validate form inputs
        if (!validateForm()) return

        // Get values from form
        const meetingLink = meetingLinkInput.value.trim()
        const startTime = new Date(startTimeInput.value).getTime()
        const autoCloseDuration = Number.parseInt(autoCloseDurationInput.value)

        // Validate data once more
        if (isNaN(startTime) || isNaN(autoCloseDuration)) {
          throw new Error("Invalid date or duration value")
        }

        // Show loading state
        scheduleMeetingButton.disabled = true
        scheduleMeetingButton.textContent = "Scheduling..."

        // Check network connection first
        if (!navigator.onLine) {
          showStatus(
            "You appear to be offline. Meeting will be scheduled but may not join if device remains offline.",
            "warning",
          )
        }

        // Send message to background script with timeout and error handling
        const messageTimeout = setTimeout(() => {
          scheduleMeetingButton.disabled = false
          scheduleMeetingButton.textContent = "Schedule Meeting"
          showStatus("Request timed out. Please try again.", "error")
        }, 10000)

        chrome.runtime.sendMessage(
          {
            action: "scheduleMeeting",
            details: {
              link: meetingLink,
              startTime: startTime,
              autoCloseDuration: autoCloseDuration,
            },
          },
          (response) => {
            clearTimeout(messageTimeout)

            // Check for error in response
            if (chrome.runtime.lastError) {
              console.error("Runtime error:", chrome.runtime.lastError)
              showStatus("Error scheduling meeting: " + (chrome.runtime.lastError.message || "Unknown error"), "error")
              scheduleMeetingButton.disabled = false
              scheduleMeetingButton.textContent = "Schedule Meeting"
              return
            }

            // Check for error in the response object
            if (response && response.status === "error") {
              showStatus("Error scheduling meeting: " + (response.message || "Unknown error"), "error")
              scheduleMeetingButton.disabled = false
              scheduleMeetingButton.textContent = "Schedule Meeting"
              return
            }

            // Reset button state
            scheduleMeetingButton.disabled = false
            scheduleMeetingButton.textContent = "Schedule Meeting"

            // Show success message
            showStatus("Meeting scheduled successfully!", "success")

            // Reset form and refresh meetings list
            meetingLinkInput.value = ""
            loadUpcomingMeetings()
          },
        )
      } catch (e) {
        console.error("Error scheduling meeting:", e)
        showStatus("Error scheduling meeting: " + e.message, "error")
        scheduleMeetingButton.disabled = false
        scheduleMeetingButton.textContent = "Schedule Meeting"
      }
    })

    // Form validation with improved error messages
    function validateForm() {
      try {
        const meetingLink = meetingLinkInput.value.trim()
        const startTimeValue = startTimeInput.value

        // More thorough validation of meeting link format
        if (!meetingLink) {
          showStatus("Please enter a meeting link", "error")
          meetingLinkInput.focus()
          return false
        }

        // Basic URL validation
        if (!meetingLink.startsWith("http://") && !meetingLink.startsWith("https://")) {
          showStatus("Please enter a valid URL starting with http:// or https://", "error")
          meetingLinkInput.focus()
          return false
        }

        if (!startTimeValue) {
          showStatus("Please select a start time", "error")
          startTimeInput.focus()
          return false
        }

        // Parse date safely
        let startTime
        try {
          startTime = new Date(startTimeValue).getTime()
          if (isNaN(startTime)) throw new Error("Invalid date format")
        } catch (e) {
          showStatus("Invalid date format. Please select a valid date and time.", "error")
          startTimeInput.focus()
          return false
        }

        if (startTime <= Date.now()) {
          showStatus("Please select a future start time", "error")
          startTimeInput.focus()
          return false
        }

        // Validate autoCloseDuration more carefully
        const autoCloseDurationValue = autoCloseDurationInput.value
        if (!autoCloseDurationValue) {
          showStatus("Please enter an auto-close duration", "error")
          autoCloseDurationInput.focus()
          return false
        }

        const autoCloseDuration = Number.parseInt(autoCloseDurationValue)
        if (isNaN(autoCloseDuration)) {
          showStatus("Please enter a valid number for auto-close duration", "error")
          autoCloseDurationInput.focus()
          return false
        }

        if (autoCloseDuration <= 0) {
          showStatus("Auto-close duration must be greater than 0", "error")
          autoCloseDurationInput.focus()
          return false
        }

        if (autoCloseDuration > 1440) {
          // Max 24 hours
          showStatus("Auto-close duration cannot exceed 1440 minutes (24 hours)", "error")
          autoCloseDurationInput.focus()
          return false
        }

        return true
      } catch (e) {
        console.error("Validation error:", e)
        showStatus("Form validation error: " + e.message, "error")
        return false
      }
    }

    // Display status messages with fade effects
    function showStatus(message, type) {
      statusDiv.textContent = message
      statusDiv.className = "status " + (type || "info")

      // Make sure status is visible
      statusDiv.style.opacity = "1"

      // Hide status after delay unless it's a warning
      if (type !== "warning") {
        setTimeout(() => {
          // Fade out effect
          statusDiv.style.transition = "opacity 1s"
          statusDiv.style.opacity = "0"

          setTimeout(() => {
            statusDiv.textContent = ""
            statusDiv.className = "status"
            statusDiv.style.transition = ""
          }, 1000)
        }, 5000)
      }
    }

    // Check connection status with more details
    function updateConnectionStatus() {
      try {
        if (navigator.onLine) {
          connectionStatusDiv.textContent = "Checking..."
          connectionStatusDiv.className = "checking"

          // Send a message to the background script to check actual connectivity
          chrome.runtime.sendMessage(
            {
              action: "checkNetworkStatus",
            },
            (response) => {
              if (chrome.runtime.lastError) {
                console.error("Error checking network:", chrome.runtime.lastError)
                connectionStatusDiv.textContent = "Status Unknown"
                connectionStatusDiv.className = "unknown"
                return
              }

              if (response && response.online) {
                connectionStatusDiv.textContent = "Online"
                connectionStatusDiv.className = "connected"
              } else {
                connectionStatusDiv.textContent = "Limited Connectivity"
                connectionStatusDiv.className = "limited"
              }
            },
          )
        } else {
          connectionStatusDiv.textContent = "Offline - Meetings may not join if device remains offline"
          connectionStatusDiv.className = "disconnected"
        }
      } catch (e) {
        console.error("Connection status error:", e)
        // Default to showing potential issue
        connectionStatusDiv.textContent = "Connection status unknown"
        connectionStatusDiv.className = "unknown"
      }
    }

    // Load and display error logs
    function loadErrorLogs() {
      try {
        chrome.runtime.sendMessage(
          {
            action: "getErrorLogs",
          },
          (response) => {
            if (chrome.runtime.lastError) {
              console.error("Error loading logs:", chrome.runtime.lastError)
              return
            }

            const logsContent = document.getElementById("errorLogsContent")
            const logs = response && response.logs ? response.logs : []

            if (logs.length === 0) {
              logsContent.innerHTML = '<p class="no-logs">No error logs</p>'
              return
            }

            // Sort logs by timestamp (newest first)
            logs.sort((a, b) => b.timestamp - a.timestamp)

            let logsHtml = '<ul class="logs-list">'

            logs.forEach((log) => {
              const date = new Date(log.timestamp)
              const formattedDate = `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`
              const severityClass = log.severity.toLowerCase()

              logsHtml += `
                          <li class="log-entry ${severityClass}">
                              <span class="log-time">${formattedDate}</span>
                              <span class="log-severity">${log.severity}</span>
                              <span class="log-message">${log.message}</span>
                          </li>
                      `
            })

            logsHtml += "</ul>"
            logsContent.innerHTML = logsHtml
          },
        )
      } catch (e) {
        console.error("Error loading error logs:", e)
      }
    }

    // Load and display upcoming meetings with improved error handling
    function loadUpcomingMeetings() {
      try {
        chrome.storage.local.get("scheduledMeetings", (data) => {
          if (chrome.runtime.lastError) {
            console.error("Storage error:", chrome.runtime.lastError)
            upcomingMeetingsDiv.innerHTML =
              '<p class="error">Error loading meetings: ' +
              (chrome.runtime.lastError.message || "Storage access failed") +
              "</p>"
            return
          }

          const meetings = data.scheduledMeetings || []

          // Clear current list
          upcomingMeetingsDiv.innerHTML = "<h2>Upcoming Meetings</h2>"
          const meetingsListDiv = document.createElement("div")
          meetingsListDiv.className = "meetings-list"
          upcomingMeetingsDiv.appendChild(meetingsListDiv)

          if (meetings.length === 0) {
            meetingsListDiv.innerHTML = '<p class="no-meetings">No upcoming meetings scheduled</p>'
            return
          }

          // Filter out invalid meetings first
          const validMeetings = meetings.filter(
            (meeting) => meeting && typeof meeting === "object" && !isNaN(meeting.startTime) && meeting.link,
          )

          if (validMeetings.length === 0) {
            meetingsListDiv.innerHTML = '<p class="no-meetings">No valid upcoming meetings found</p>'
            // Clean up corrupted data
            chrome.storage.local.set({ scheduledMeetings: [] })
            return
          }

          // Sort meetings by start time (ascending)
          validMeetings.sort((a, b) => a.startTime - b.startTime)

          // Display each meeting
          validMeetings.forEach((meeting, index) => {
            try {
              if (meeting.startTime > Date.now() || !meeting.completed) {
                // Show future meetings and active ones
                const meetingElement = document.createElement("div")
                meetingElement.className = "meeting-card"

                // Add status class
                if (meeting.joined) {
                  meetingElement.classList.add("meeting-joined")
                } else if (meeting.completed) {
                  meetingElement.classList.add("meeting-completed")
                } else if (meeting.startTime <= Date.now()) {
                  meetingElement.classList.add("meeting-active")
                }

                // Format the date and time safely
                const meetingDate = new Date(meeting.startTime)
                let formattedDate = "Invalid Date"
                let formattedTime = "Invalid Time"

                if (!isNaN(meetingDate.getTime())) {
                  formattedDate = meetingDate.toLocaleDateString()
                  formattedTime = meetingDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                }

                // Calculate time remaining with validation
                const timeRemaining = getTimeRemaining(meeting.startTime)

                // Safe URL display
                const linkDisplay = meeting.link ? truncateUrl(meeting.link) : "Invalid link"
                const durationDisplay = !isNaN(meeting.autoCloseDuration)
                  ? `Auto-close after ${meeting.autoCloseDuration} minutes`
                  : "Invalid duration"

                // Detect platform for better display
                const platform = meeting.platform || detectPlatform(meeting.link)
                const platformDisplay =
                  platform !== "unknown"
                    ? `<p class="meeting-platform">${capitalizeFirstLetter(platform)} Meeting</p>`
                    : ""

                // Status display
                let statusDisplay = ""
                if (meeting.joined) {
                  statusDisplay = '<p class="meeting-status joined">Joined</p>'
                } else if (meeting.completed) {
                  statusDisplay = '<p class="meeting-status completed">Completed</p>'
                } else if (meeting.startTime <= Date.now()) {
                  statusDisplay = '<p class="meeting-status active">Active</p>'
                }

                meetingElement.innerHTML = `
                                  <div class="meeting-details">
                                      <h3>Meeting ${index + 1}</h3>
                                      ${platformDisplay}
                                      ${statusDisplay}
                                      <p class="meeting-time">${formattedDate} at ${formattedTime}</p>
                                      <p class="meeting-countdown">${timeRemaining}</p>
                                      <p class="meeting-link">${linkDisplay}</p>
                                      <p class="meeting-duration">${durationDisplay}</p>
                                  </div>
                                  <div class="meeting-actions">
                                      <button class="edit-meeting" data-index="${index}" ${
                                        meeting.completed || meeting.joined ? "disabled" : ""
                                      }>Edit</button>
                                      <button class="cancel-meeting" data-index="${index}">Cancel</button>
                                  </div>
                              `

                meetingsListDiv.appendChild(meetingElement)
              }
            } catch (e) {
              console.error(`Error rendering meeting ${index}:`, e)
              // Continue to next meeting instead of breaking
            }
          })

          // Add event listeners to buttons
          document.querySelectorAll(".cancel-meeting").forEach((button) => {
            button.addEventListener("click", function () {
              const meetingIndex = Number.parseInt(this.getAttribute("data-index"))
              cancelMeeting(meetingIndex)
            })
          })

          // Add edit functionality
          document.querySelectorAll(".edit-meeting").forEach((button) => {
            if (button.disabled) return

            button.addEventListener("click", function () {
              const meetingIndex = Number.parseInt(this.getAttribute("data-index"))
              editMeeting(meetingIndex, validMeetings[meetingIndex])
            })
          })
        })
      } catch (e) {
        console.error("Error in loadUpcomingMeetings:", e)
        upcomingMeetingsDiv.innerHTML = '<p class="error">Error loading meetings: ' + e.message + "</p>"
      }
    }

    // Helper function to detect meeting platform
    function detectPlatform(url) {
      if (!url) return "unknown"

      if (url.includes("meet.google.com")) return "google"
      if (url.includes("zoom.us")) return "zoom"
      if (url.includes("teams.microsoft.com")) return "teams"
      if (url.includes("webex.com")) return "webex"

      return "other"
    }

    // Helper function to capitalize first letter
    function capitalizeFirstLetter(string) {
      return string.charAt(0).toUpperCase() + string.slice(1)
    }

    // Add edit meeting functionality
    function editMeeting(index, meeting) {
      try {
        if (!meeting) return

        // Fill form with meeting details
        meetingLinkInput.value = meeting.link || ""

        // Format date for datetime-local input
        const meetingDate = new Date(meeting.startTime)
        if (!isNaN(meetingDate.getTime())) {
          startTimeInput.value = meetingDate.toISOString().slice(0, 16)
        }

        autoCloseDurationInput.value = meeting.autoCloseDuration || 60

        // Scroll to form
        meetingLinkInput.scrollIntoView({ behavior: "smooth" })

        // Change button text
        scheduleMeetingButton.textContent = "Update Meeting"

        // Store index for update
        scheduleMeetingButton.setAttribute("data-edit-index", index)

        // Show helper message
        showStatus('Editing meeting. Update details and click "Update Meeting"', "info")

        // Override click handler temporarily
        const originalClickHandler = scheduleMeetingButton.onclick
        scheduleMeetingButton.onclick = (e) => {
          e.preventDefault()

          if (!validateForm()) return

          // Get updated values
          const updatedLink = meetingLinkInput.value.trim()
          const updatedStartTime = new Date(startTimeInput.value).getTime()
          const updatedDuration = Number.parseInt(autoCloseDurationInput.value)

          // Update meeting in storage
          chrome.storage.local.get("scheduledMeetings", (data) => {
            const meetings = data.scheduledMeetings || []

            if (index >= 0 && index < meetings.length) {
              // Cancel old meeting timer
              chrome.runtime.sendMessage({
                action: "cancelMeeting",
                details: { startTime: meetings[index].startTime },
              })

              // Update meeting
              meetings[index] = {
                link: updatedLink,
                startTime: updatedStartTime,
                autoCloseDuration: updatedDuration,
                platform: detectPlatform(updatedLink),
                scheduled: Date.now(),
                completed: false,
                joined: false,
                joinAttempts: 0,
              }

              // Schedule updated meeting
              chrome.runtime.sendMessage({
                action: "scheduleMeeting",
                details: meetings[index],
              })

              // Save to storage
              chrome.storage.local.set({ scheduledMeetings: meetings }, () => {
                // Reset form
                meetingLinkInput.value = ""
                scheduleMeetingButton.textContent = "Schedule Meeting"
                scheduleMeetingButton.removeAttribute("data-edit-index")
                scheduleMeetingButton.onclick = originalClickHandler

                // Set a new default time
                const newDefault = new Date()
                newDefault.setHours(newDefault.getHours() + 1)
                newDefault.setMinutes(0)
                newDefault.setSeconds(0)
                startTimeInput.value = newDefault.toISOString().slice(0, 16)

                // Refresh list
                loadUpcomingMeetings()
                showStatus("Meeting updated successfully!", "success")
              })
            }
          })
        }
      } catch (e) {
        console.error("Error editing meeting:", e)
        showStatus("Error editing meeting: " + e.message, "error")
      }
    }

    // Helper function to format time remaining with better error handling
    function getTimeRemaining(timestamp) {
      try {
        if (isNaN(timestamp)) return "Invalid time"

        const now = Date.now()
        const difference = timestamp - now

        if (difference <= 0) return "Starting now"

        const days = Math.floor(difference / (1000 * 60 * 60 * 24))
        const hours = Math.floor((difference % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))
        const minutes = Math.floor((difference % (1000 * 60 * 60)) / (1000 * 60))

        if (days > 0) {
          return `Starts in ${days} day${days > 1 ? "s" : ""} and ${hours} hour${hours > 1 ? "s" : ""}`
        } else if (hours > 0) {
          return `Starts in ${hours} hour${hours > 1 ? "s" : ""} and ${minutes} minute${minutes > 1 ? "s" : ""}`
        } else {
          return `Starts in ${minutes} minute${minutes > 1 ? "s" : ""}`
        }
      } catch (e) {
        console.error("Error formatting time remaining:", e)
        return "Time calculation error"
      }
    }

    // Helper function to truncate long URLs with error handling
    function truncateUrl(url) {
      try {
        if (!url || typeof url !== "string") return "Invalid URL"

        if (url.length > 50) {
          return url.substring(0, 47) + "..."
        }
        return url
      } catch (e) {
        console.error("Error truncating URL:", e)
        return "Invalid URL"
      }
    }

    // Cancel a scheduled meeting with improved error handling
    function cancelMeeting(index) {
      try {
        chrome.storage.local.get("scheduledMeetings", (data) => {
          if (chrome.runtime.lastError) {
            console.error("Storage error:", chrome.runtime.lastError)
            showStatus("Error accessing storage: " + chrome.runtime.lastError.message, "error")
            return
          }

          const meetings = data.scheduledMeetings || []

          if (index >= 0 && index < meetings.length) {
            // Store the meeting for cancellation
            const meetingToCancel = meetings[index]

            // Show canceling status
            showStatus("Canceling meeting...", "info")

            // Notify background script to cancel any timers
            chrome.runtime.sendMessage(
              {
                action: "cancelMeeting",
                details: { startTime: meetingToCancel.startTime },
              },
              (response) => {
                if (chrome.runtime.lastError) {
                  console.warn("Background script notification error:", chrome.runtime.lastError)
                  showStatus("Error canceling meeting: " + chrome.runtime.lastError.message, "error")
                  return
                }

                if (response && response.status === "error") {
                  showStatus("Error canceling meeting: " + (response.message || "Unknown error"), "error")
                  return
                }

                // Refresh the meetings list
                loadUpcomingMeetings()

                // Show success message
                showStatus("Meeting canceled successfully", "success")
              },
            )
          } else {
            showStatus("Invalid meeting index", "error")
          }
        })
      } catch (e) {
        console.error("Error canceling meeting:", e)
        showStatus("Error canceling meeting: " + e.message, "error")
      }
    }

    // Set up periodic refresh of meeting list to update countdowns
    const refreshInterval = setInterval(() => {
      try {
        loadUpcomingMeetings()
      } catch (e) {
        console.error("Error in periodic refresh:", e)
        // Clear interval if we're getting repeated errors
        if (document.querySelectorAll(".error").length > 3) {
          clearInterval(refreshInterval)
          showStatus("Automatic updates stopped due to errors. Please refresh the page.", "error")
        }
      }
    }, 60000) // Update every minute

    // Clean up when navigating away
    window.addEventListener("beforeunload", () => {
      clearInterval(refreshInterval)
    })
  })

