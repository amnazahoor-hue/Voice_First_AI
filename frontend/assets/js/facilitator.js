(function facilitatorApp(global) {
  "use strict";

  const socket =
    typeof global.io === "function"
      ? global.io("http://127.0.0.1:5000", {
          transports: ["websocket", "polling"],
          upgrade: true,
        })
      : null;

  const transcriptWindow = document.getElementById("transcriptWindow");
  const liveSpeaker = document.getElementById("liveSpeaker");
  const currentSentiment = document.getElementById("currentSentiment");
  const alertZone = document.getElementById("alertZone");
  const speakerInput = document.getElementById("speakerName");
  const registerSpeakerBtn = document.getElementById("registerSpeakerBtn");
  const startBtn = document.getElementById("startBtn");
  const stopBtn = document.getElementById("stopBtn");
  const finalizeBtn = document.getElementById("finalizeBtn");

  const vibeCtx = document.getElementById("vibeMeter");
  const participationCtx = document.getElementById("participationChart");

  let speechEngine = null;
  let vibeChart = null;
  let participationChart = null;
  let mediaRecorder = null;
  let audioChunks = [];
  let audioBlob = null;
  let meetingStartedAt = null;

  function showToast(message, level) {
    const toast = document.createElement("div");
    toast.className = `toast ${level || "info"}`;
    toast.textContent = message;
    alertZone.prepend(toast);
    global.setTimeout(() => {
      toast.classList.add("fade");
      global.setTimeout(() => toast.remove(), 400);
    }, 4500);
  }

  function appendTranscript(speaker, text) {
    const line = document.createElement("div");
    line.className = "transcript-line";
    line.innerHTML = `<span class="speaker">${speaker}:</span> ${text}`;
    transcriptWindow.appendChild(line);
    transcriptWindow.scrollTop = transcriptWindow.scrollHeight;
  }

  function updateVibeMeter(compound) {
    if (!vibeChart) {
      vibeChart = new Chart(vibeCtx, {
        type: "doughnut",
        data: {
          labels: ["Sentiment", "Neutral Gap"],
          datasets: [
            {
              data: [50, 50],
              backgroundColor: ["#34d399", "#1f2937"],
              borderColor: ["#34d399", "#1f2937"],
              borderWidth: 1,
            },
          ],
        },
        options: {
          responsive: true,
          cutout: "70%",
          plugins: {
            legend: { labels: { color: "#e5e7eb" } },
          },
        },
      });
    }

    const scaled = Math.max(0, Math.min(100, Math.round((compound + 1) * 50)));
    const color = compound < -0.5 ? "#ef4444" : compound > 0.2 ? "#34d399" : "#f59e0b";
    vibeChart.data.datasets[0].data = [scaled, 100 - scaled];
    vibeChart.data.datasets[0].backgroundColor[0] = color;
    vibeChart.update();
    currentSentiment.textContent = compound.toFixed(2);
    currentSentiment.style.color = color;
  }

  function updateParticipationChart(wordCounts) {
    const labels = Object.keys(wordCounts);
    const values = Object.values(wordCounts);

    if (!participationChart) {
      participationChart = new Chart(participationCtx, {
        type: "bar",
        data: {
          labels,
          datasets: [
            {
              label: "Word Count",
              data: values,
              backgroundColor: "#60a5fa",
              borderColor: "#2563eb",
              borderWidth: 1,
            },
          ],
        },
        options: {
          responsive: true,
          scales: {
            x: { ticks: { color: "#e5e7eb" } },
            y: { ticks: { color: "#e5e7eb" }, beginAtZero: true },
          },
          plugins: {
            legend: { labels: { color: "#e5e7eb" } },
          },
        },
      });
      return;
    }

    participationChart.data.labels = labels;
    participationChart.data.datasets[0].data = values;
    participationChart.update();
  }

  function buildSpeechEngine() {
    return new SpeechEngine({
      socket,
      apiEndpoint: "/api/transcript/chunk",
      resolveSpeakerId: () => (speakerInput.value || "Unknown Speaker").trim(),
      onTranscript: ({ fullTextPreview }) => {
        liveSpeaker.textContent = (speakerInput.value || "Unknown Speaker").trim();
        if (fullTextPreview) {
          appendTranscript("Live", fullTextPreview);
        }
      },
      onError: (error) => {
        showToast(`Speech Error: ${error.message}`, "error");
        if (error && error.error === "not-allowed") {
          showToast("Tip: Click the lock icon in address bar and allow Microphone.", "warning");
        }
      },
      onStateChange: ({ running }) => {
        startBtn.disabled = running;
        stopBtn.disabled = !running;
      },
    });
  }

  async function startAudioRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showToast("Audio recording not supported in this browser.", "warning");
      return;
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    audioBlob = null;
    mediaRecorder = new MediaRecorder(stream);

    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = () => {
      const mimeType = mediaRecorder.mimeType || "audio/webm";
      audioBlob = new Blob(audioChunks, { type: mimeType });
      stream.getTracks().forEach((track) => track.stop());
      showToast("Voice note captured and ready to save/download.", "success");
    };

    mediaRecorder.start(1000);
    showToast("Audio recording started.", "success");
  }

  function stopAudioRecording() {
    if (!mediaRecorder) return;
    if (mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }
  }

  function downloadVoiceNote(meetingId) {
    if (!audioBlob) return;
    const extension = audioBlob.type.includes("ogg")
      ? "ogg"
      : audioBlob.type.includes("wav")
      ? "wav"
      : "webm";
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `meeting_${meetingId || "draft"}_${ts}.${extension}`;
    const blobUrl = URL.createObjectURL(audioBlob);
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(blobUrl);
  }

  async function uploadVoiceNote(meetingId) {
    if (!audioBlob) return null;
    const formData = new FormData();
    formData.append("audio", audioBlob, `meeting_${meetingId}.webm`);
    const res = await fetch(`/api/meeting/${meetingId}/audio`, {
      method: "POST",
      body: formData,
    });
    if (!res.ok) {
      throw new Error("Audio upload failed");
    }
    return res.json();
  }

  if (socket) {
    socket.on("connect", () => {
      console.log("Socket Connected:", socket.id);
      showToast("Realtime socket connected.", "success");
    });

    socket.on("system_event", (payload) => {
      showToast(payload.message, "info");
    });

    socket.on("analysis_update", (payload) => {
      appendTranscript(payload.speaker_id, payload.text);
      updateVibeMeter(payload.sentiment.compound);
      if (payload.potential_conflict) {
        showToast("Conflict Detected: Consider a 2-minute break.", "error");
      }
    });

    socket.on("participation_update", (payload) => {
      updateParticipationChart(payload.word_counts || {});
    });

    socket.on("facilitator_alert", (payload) => {
      showToast(payload.message, payload.severity === "high" ? "error" : "warning");
    });
  } else {
    showToast("Realtime socket unavailable. REST mode enabled.", "warning");
  }

  registerSpeakerBtn.addEventListener("click", async () => {
    const speaker = (speakerInput.value || "").trim();
    if (!speaker) {
      showToast("Enter a speaker name first.", "warning");
      return;
    }
    try {
      const res = await fetch("/api/speakers/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ speaker_id: speaker }),
      });
      if (res.ok) {
        showToast(`Speaker registered: ${speaker}`, "success");
      } else {
        showToast("Failed to register speaker.", "error");
      }
    } catch (err) {
      showToast(`Register failed: ${err.message || "network error"}`, "error");
    }
  });

  startBtn.addEventListener("click", () => {
    try {
      if (!speechEngine) speechEngine = buildSpeechEngine();
      meetingStartedAt = Date.now();
      speechEngine.start();
      startAudioRecording().catch((err) => {
        showToast(`Audio recording failed: ${err.message || "permission denied"}`, "warning");
      });
      showToast("Voice facilitation started.", "success");
    } catch (err) {
      showToast(err.message || "Unable to start speech engine.", "error");
    }
  });

  stopBtn.addEventListener("click", () => {
    if (!speechEngine) return;
    speechEngine.stop();
    stopAudioRecording();
    showToast("Voice facilitation stopped.", "warning");
  });

  finalizeBtn.addEventListener("click", async () => {
    try {
      const res = await fetch("/api/meeting/finalize", { method: "POST" });
      if (!res.ok) {
        showToast("Failed to save meeting summary.", "error");
        return;
      }
      const data = await res.json();
      showToast(`Meeting saved with ID #${data.meeting_id}`, "success");
      if (mediaRecorder && mediaRecorder.state !== "inactive") {
        stopAudioRecording();
        await new Promise((resolve) => global.setTimeout(resolve, 600));
      }
      if (audioBlob) {
        downloadVoiceNote(data.meeting_id);
        try {
          const uploadResponse = await uploadVoiceNote(data.meeting_id);
          if (uploadResponse && uploadResponse.audio_path) {
            showToast(`Voice note stored: ${uploadResponse.audio_path}`, "success");
          }
        } catch (uploadErr) {
          showToast(`Voice note upload failed: ${uploadErr.message}`, "warning");
        }
      } else if (meetingStartedAt) {
        showToast("No audio note captured for this meeting.", "warning");
      }
    } catch (err) {
      showToast(`Finalize failed: ${err.message || "network error"}`, "error");
    }
  });

  // Initialize blank charts for immediate visual structure.
  updateVibeMeter(0);
  updateParticipationChart({});
})(window);

