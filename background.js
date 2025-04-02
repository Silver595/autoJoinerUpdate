chrome.runtime.onInstalled.addListener(() => {
    console.log('Auto Meeting Assistant Installed');
  });

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'scheduleMeeting') {
      scheduleMeeting(request.details);
    }
  });

  function scheduleMeeting(details) {
    // Create an alarm for meeting start time
    chrome.alarms.create('meetingStart', {
      when: details.startTime
    });

    // Create an alarm for auto-close
    chrome.alarms.create('meetingAutoClose', {
      when: details.startTime + (details.autoCloseDuration * 60 * 1000)
    });

    // Store meeting details for reference
    chrome.storage.sync.set({ lastScheduledMeeting: details });
  }

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'meetingStart') {
      chrome.storage.sync.get('lastScheduledMeeting', (data) => {
        const meetingLink = data.lastScheduledMeeting.link;
        chrome.tabs.create({ url: meetingLink });
      });
    }

    if (alarm.name === 'meetingAutoClose') {
      chrome.tabs.query({ url: '*://meet.google.com/*' }, (tabs) => {
        tabs.forEach(tab => chrome.tabs.remove(tab.id));

        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'images/icon128.png',
          title: 'Meeting Closed',
          message: 'Your meeting has been automatically closed.'
        });
      });
    }
  });
