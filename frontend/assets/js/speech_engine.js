/*
 * Web Speech API engine for live meeting transcription.
 *
 * Features:
 * - Continuous recognition with interim transcript updates.
 * - Debounced chunk emission on natural pauses.
 * - Forced chunk emission after 5s of continuous speech.
 * - Emits realtime events via Socket.IO and optional REST fallback.
 * - Supports manual speaker identity via config or callback.
 */

(function attachSpeechEngine(global) {
  "use strict";

  const MAX_CONTINUOUS_SPEECH_MS = 5000;
  const PAUSE_DEBOUNCE_MS = 700;

  function mapSpeechError(errorCode) {
    const code = (errorCode || "").toString();
    const helpByCode = {
      "not-allowed": "Microphone permission denied. Allow mic access in browser site settings.",
      "service-not-allowed": "Speech service is blocked by browser/policy. Try Chrome/Edge and enable speech services.",
      "audio-capture": "No microphone detected. Check device connection and OS input settings.",
      "no-speech": "No speech detected. Speak clearly and check microphone input level.",
      aborted: "Recognition was aborted. Try starting recognition again.",
      network: "Network issue while using speech service. Check internet connection.",
      "language-not-supported": "Selected language is not supported by this browser speech engine.",
    };
    return helpByCode[code] || "Unknown speech recognition issue.";
  }

  class SpeechEngine {
    constructor(options = {}) {
      this.socket = options.socket || null;
      this.apiEndpoint = options.apiEndpoint || "/api/transcript/chunk";
      this.lang = options.lang || "en-US";
      this.onTranscript = options.onTranscript || function noop() {};
      this.onError = options.onError || function noop() {};
      this.onStateChange = options.onStateChange || function noop() {};
      this.resolveSpeakerId =
        options.resolveSpeakerId ||
        function defaultSpeaker() {
          return "Unknown Speaker";
        };

      this.isRunning = false;
      this.finalBuffer = [];
      this.interimText = "";
      this.segmentStartedAt = null;
      this.pauseFlushTimer = null;

      const SpeechRecognition =
        global.SpeechRecognition || global.webkitSpeechRecognition;
      if (!SpeechRecognition) {
        throw new Error("Web Speech API is not supported in this browser.");
      }

      this.recognition = new SpeechRecognition();
      this.recognition.lang = this.lang;
      this.recognition.continuous = true;
      this.recognition.interimResults = true;
      this.recognition.maxAlternatives = 1;

      this._bindRecognitionEvents();
    }

    start() {
      if (this.isRunning) return;
      this.isRunning = true;
      this.segmentStartedAt = null;
      this.recognition.start();
      this.onStateChange({ running: true });
    }

    stop() {
      if (!this.isRunning) return;
      this.isRunning = false;
      this._clearPauseTimer();
      this.recognition.stop();
      this.flush(true);
      this.onStateChange({ running: false });
    }

    flush(force = false) {
      const text = this.finalBuffer.join(" ").trim();
      if (!text) {
        return;
      }

      const now = Date.now();
      const segmentStart = this.segmentStartedAt || now;

      const payload = {
        text,
        speaker_id: this.resolveSpeakerId(),
        chunk_seconds: Math.max(1, Math.round((now - segmentStart) / 1000)),
        client_timestamp: new Date().toISOString(),
      };

      this._emitChunk(payload);

      this.finalBuffer = [];
      this.interimText = "";
      this.segmentStartedAt = null;
      this._clearPauseTimer();
    }

    _bindRecognitionEvents() {
      this.recognition.onresult = (event) => {
        const now = Date.now();
        let interimAggregate = "";

        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i];
          const transcript = (result[0] && result[0].transcript ? result[0].transcript : "").trim();
          if (!transcript) continue;

          if (result.isFinal) {
            this.finalBuffer.push(transcript);
          } else {
            interimAggregate += `${transcript} `;
          }
        }

        if ((interimAggregate || this.finalBuffer.length > 0) && !this.segmentStartedAt) {
          this.segmentStartedAt = now;
        }

        this.interimText = interimAggregate.trim();
        this.onTranscript({
          finalText: this.finalBuffer.join(" ").trim(),
          interimText: this.interimText,
          fullTextPreview: `${this.finalBuffer.join(" ")} ${this.interimText}`.trim(),
        });

        const speakingContinuously = this.interimText.length > 0;
        const hasFinalText = this.finalBuffer.join(" ").trim().length > 0;

        if (speakingContinuously) {
          this._clearPauseTimer();
        } else if (hasFinalText) {
          this._schedulePauseFlush();
        }

        // Force atomic emit every 5s while user is continuously speaking.
        if (
          this.segmentStartedAt &&
          now - this.segmentStartedAt >= MAX_CONTINUOUS_SPEECH_MS &&
          hasFinalText
        ) {
          this.flush(false);
        }
      };

      this.recognition.onerror = (event) => {
        const errorCode = event && event.error ? event.error : "unknown_error";
        this.onError({
          type: "speech_error",
          error: errorCode,
          message: `Speech recognition error: ${errorCode}. ${mapSpeechError(errorCode)}`,
        });
      };

      this.recognition.onend = () => {
        // In continuous mode, restart automatically if user did not explicitly stop.
        if (this.isRunning) {
          try {
            this.recognition.start();
          } catch (err) {
            this.onError({
              type: "speech_restart_failed",
              error: "restart_failed",
              message: err && err.message ? err.message : "Could not restart speech recognition.",
            });
          }
        }
      };
    }

    _startFlushTimer() {
      // Intentionally unused: kept for API compatibility.
    }

    _stopFlushTimer() {
      // Intentionally unused: kept for API compatibility.
    }

    _schedulePauseFlush() {
      this._clearPauseTimer();
      this.pauseFlushTimer = global.setTimeout(() => {
        this.flush(false);
      }, PAUSE_DEBOUNCE_MS);
    }

    _clearPauseTimer() {
      if (!this.pauseFlushTimer) return;
      global.clearTimeout(this.pauseFlushTimer);
      this.pauseFlushTimer = null;
    }

    _emitChunk(payload) {
      // Primary realtime channel: Socket.IO
      if (this.socket && typeof this.socket.emit === "function") {
        this.socket.emit("transcript_chunk", payload);
      }

      // Optional REST persistence path (useful when socket ack flow is unavailable)
      if (this.apiEndpoint && global.fetch) {
        global
          .fetch(this.apiEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
          .catch((err) => {
            this.onError({
              type: "chunk_send_failed",
              error: "network_error",
              message: err && err.message ? err.message : "Failed to send transcript chunk.",
            });
          });
      }
    }
  }

  global.SpeechEngine = SpeechEngine;
})(window);
