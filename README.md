# Voice-First AI Meeting Architect

Real-time meeting facilitation system built with Flask + Socket.IO + Vanilla JS.

## Features

- Live speech-to-text using Web Speech API
- 15-second transcript chunking and streaming to backend
- VADER sentiment analysis with conflict detection (`compound < -0.5`)
- Participation monitoring with 5-minute silence alerts
- Real-time dashboard:
  - Live Transcript Window
  - Vibe Meter (Chart.js)
  - Participation Heatmap (Chart.js)
  - AI Facilitator Toast Prompts
- SQLite meeting summary persistence (transcript + sentiment map)

## Run

1. Create environment and install dependencies:

```bash
pip install -r requirements.txt
```

2. Start backend:

```bash
python backend/app.py
```

3. Open browser:

```text
http://127.0.0.1:5000
```

## Notes

- For best Web Speech API support, use Chrome or Edge.
- Microphone permission must be granted in browser.
- Speaker tracking is name-based via the "Register Speaker" and speaker input field.
