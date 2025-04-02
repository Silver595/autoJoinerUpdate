chrome.runtime.onInstalled.addListener(() => {
    console.log('Auto Meeting Assistant Installed');
    // Set up recovery check alarm right after installation
    setupPeriodicCheck();
  });

  // Create a periodic check that runs every minute
  function setupPeriodicCheck() {
    chrome.alarms.create('recoveryCheck', {
      periodInMinutes: 1
    });
  }

  chrome.runtime.onStartup.addListener(() => {
    console.log('System resumed from sleep - checking for missed meetings');
    checkForMissedMeetings();
    setupPeriodicCheck();
  });

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'scheduleMeeting') {
      scheduleMeeting(request.details);
      sendResponse({status: 'Meeting scheduled successfully'});
      return true; // Keep the message channel open for async response
    }

    if (request.action === 'joinStatus') {
      console.log('Join status update:', request.status);
      // You can add additional logic here based on join status
      return true;
    }
  });

  function scheduleMeeting(details) {
    // Input validation - prevent errors from invalid inputs
    if (!details || !details.link || !details.startTime || !details.autoCloseDuration) {
      console.error('Invalid meeting details provided:', details);
      return;
    }

    // Ensure startTime is a number
    const startTime = typeof details.startTime === 'number' ? details.startTime : parseInt(details.startTime);
    if (isNaN(startTime)) {
      console.error('Invalid start time:', details.startTime);
      return;
    }

    // Ensure autoCloseDuration is a number
    const autoCloseDuration = typeof details.autoCloseDuration === 'number' ?
      details.autoCloseDuration : parseInt(details.autoCloseDuration);
    if (isNaN(autoCloseDuration)) {
      console.error('Invalid auto close duration:', details.autoCloseDuration);
      return;
    }

    // Store the exact timestamp for the meeting
    const meetingData = {
      link: details.link,
      startTime: startTime,
      autoCloseDuration: autoCloseDuration,
      scheduled: Date.now(),
      completed: false
    };

    // Create unique alarm names with timestamps to avoid conflicts
    const alarmBaseName = startTime.toString();

    // Create an alarm for meeting start time
    chrome.alarms.create('meetingStart_' + alarmBaseName, {
      when: startTime
    });

    // Create an alarm for auto-close
    chrome.alarms.create('meetingClose_' + alarmBaseName, {
      when: startTime + (autoCloseDuration * 60 * 1000)
    });

    // Store meeting details in persistent storage
    chrome.storage.local.get('scheduledMeetings', (data) => {
      let meetings = data.scheduledMeetings || [];

      // Check for and remove any duplicate meetings (same link and start time)
      meetings = meetings.filter(m =>
        m.link !== meetingData.link || m.startTime !== meetingData.startTime);

      meetings.push(meetingData);
      chrome.storage.local.set({ scheduledMeetings: meetings });
      console.log('Meeting scheduled for: ' + new Date(startTime).toLocaleString());
    });
  }

  function checkForMissedMeetings() {
    const now = Date.now();

    chrome.storage.local.get('scheduledMeetings', (data) => {
      if (!data.scheduledMeetings || data.scheduledMeetings.length === 0) return;

      let updatedMeetings = [];
      let needUpdate = false;

      data.scheduledMeetings.forEach(meeting => {
        // Validate meeting object has required properties
        if (!meeting || typeof meeting.startTime !== 'number' || !meeting.link) {
          needUpdate = true; // Skip invalid meeting objects
          return;
        }

        // Check if this is a missed meeting that should be joined now
        // Criteria: Meeting start time is in the past, but not more than 30 minutes ago
        // AND the meeting hasn't been marked as completed
        if (!meeting.completed &&
            meeting.startTime <= now &&
            now - meeting.startTime < 30 * 60 * 1000) {
          console.log('Found missed meeting! Joining now: ' + meeting.link);
          // Open the meeting in a new tab
          chrome.tabs.create({ url: meeting.link });
          meeting.completed = true;
          needUpdate = true;
        }

        // Keep meetings for the current day only
        const oneDayAgo = now - (24 * 60 * 60 * 1000);
        if (meeting.startTime > oneDayAgo) {
          updatedMeetings.push(meeting);
        } else {
          needUpdate = true; // We're removing old meetings
        }
      });

      // Update storage if needed
      if (needUpdate) {
        chrome.storage.local.set({ scheduledMeetings: updatedMeetings });
      }
    });
  }

  chrome.alarms.onAlarm.addListener((alarm) => {
    console.log('Alarm triggered: ' + alarm.name);

    try {
      // Handle specific meeting start alarm
      if (alarm.name.startsWith('meetingStart_')) {
        const startTimePart = alarm.name.split('_')[1];
        if (!startTimePart) {
          console.error('Invalid alarm name format:', alarm.name);
          return;
        }

        const startTime = parseInt(startTimePart);
        if (isNaN(startTime)) {
          console.error('Could not parse start time from alarm:', alarm.name);
          return;
        }

        chrome.storage.local.get('scheduledMeetings', (data) => {
          if (!data.scheduledMeetings) return;

          // Find the meeting with matching start time
          const meeting = data.scheduledMeetings.find(m => m.startTime === startTime);
          if (meeting && !meeting.completed) {
            console.log('Starting scheduled meeting: ' + meeting.link);
            chrome.tabs.create({ url: meeting.link });

            // Mark meeting as completed
            const updatedMeetings = data.scheduledMeetings.map(m => {
              if (m.startTime === startTime) {
                return {...m, completed: true};
              }
              return m;
            });
            chrome.storage.local.set({ scheduledMeetings: updatedMeetings });
          }
        });
      }

      // Handle specific meeting close alarm
      else if (alarm.name.startsWith('meetingClose_')) {
        // No need to parse the time for close, just find and close all Google Meet tabs
        chrome.tabs.query({ url: '*://meet.google.com/*' }, (tabs) => {
          if (tabs.length > 0) {
            console.log('Auto-closing meeting tabs, count:', tabs.length);
            tabs.forEach(tab => chrome.tabs.remove(tab.id));
            chrome.notifications.create({
              type: 'basic',
              iconUrl: 'images/icon128.png',
              title: 'Meeting Closed',
              message: 'Your meeting has been automatically closed.'
            });
          }
        });
      }

      // Handle recovery check alarm (runs every minute)
      else if (alarm.name === 'recoveryCheck') {
        checkForMissedMeetings();
      }
    } catch (error) {
      console.error('Error handling alarm:', alarm.name, error);
    }
  });

  // Handle potential error when extension updates
  chrome.runtime.onUpdateAvailable.addListener(() => {
    // Reset alarms on update to prevent issues
    chrome.alarms.getAll((alarms) => {
      alarms.forEach(alarm => {
        if (alarm.name !== 'recoveryCheck') {
          chrome.alarms.clear(alarm.name);
        }
      });
    });

    // Check for any missed meetings before update
    checkForMissedMeetings();
  });
