document.addEventListener('DOMContentLoaded', function() {
    const meetingLinkInput = document.getElementById('meetingLink');
    const startTimeInput = document.getElementById('startTime');
    const autoCloseDurationInput = document.getElementById('autoCloseDuration');
    const scheduleMeetingButton = document.getElementById('scheduleMeeting');
    const statusDiv = document.getElementById('status');

    scheduleMeetingButton.addEventListener('click', function() {
      const meetingLink = meetingLinkInput.value;
      const startTime = new Date(startTimeInput.value).getTime();
      const autoCloseDuration = parseInt(autoCloseDurationInput.value);

      if (!meetingLink || !startTime || !autoCloseDuration) {
        statusDiv.textContent = 'Please fill all fields';
        return;
      }

      chrome.storage.sync.set({
        meetingDetails: {
          link: meetingLink,
          startTime: startTime,
          autoCloseDuration: autoCloseDuration
        }
      }, function() {
        statusDiv.textContent = 'Meeting Scheduled Successfully!';

        // Request background script to set up scheduling
        chrome.runtime.sendMessage({
          action: 'scheduleMeeting',
          details: {
            link: meetingLink,
            startTime: startTime,
            autoCloseDuration: autoCloseDuration
          }
        });
      });
    });
  });
