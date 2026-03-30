from pathlib import Path
from datetime import datetime, timezone

from flask import Flask, jsonify, request, send_from_directory
from flask_socketio import SocketIO, emit

from analyzer import MeetingAnalyzer
from database import attach_audio_note, init_db, list_meetings, save_meeting_summary


BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR.parent / "frontend"
ASSETS_DIR = FRONTEND_DIR / "assets"
RECORDINGS_DIR = BASE_DIR / "recordings"
RECORDINGS_DIR.mkdir(exist_ok=True)

app = Flask(
    __name__,
    static_folder=str(ASSETS_DIR),
    static_url_path="/assets",
)
app.config["SECRET_KEY"] = "meeting-architect-secret"
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="eventlet")


analyzer = MeetingAnalyzer(expected_speakers=["Alex", "Taylor", "Jordan"])
init_db()


@app.get("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.post("/api/speakers/register")
def register_speaker():
    payload = request.get_json(silent=True) or {}
    speaker = str(payload.get("speaker_id", "")).strip()
    if not speaker:
        return jsonify({"ok": False, "error": "speaker_id is required"}), 400
    analyzer.register_speaker(speaker)
    return jsonify({"ok": True, "speaker_id": speaker})


@app.post("/api/transcript/chunk")
def receive_chunk():
    payload = request.get_json(silent=True) or {}
    text = str(payload.get("text", "")).strip()
    speaker_id = str(payload.get("speaker_id", "Unknown Speaker")).strip()
    if not text:
        return jsonify({"ok": False, "error": "text is required"}), 400

    result = analyzer.process_chunk(text=text, speaker_id=speaker_id)
    _emit_facilitation_events(result)
    return jsonify({"ok": True, "analysis": result})


@app.post("/api/meeting/finalize")
def finalize_meeting():
    payload = analyzer.get_meeting_summary_payload()
    meeting_id = save_meeting_summary(payload)
    return jsonify({"ok": True, "meeting_id": meeting_id, "summary": payload})


@app.get("/api/meetings")
def get_meetings():
    return jsonify({"ok": True, "meetings": list_meetings()})


@app.post("/api/meeting/<int:meeting_id>/audio")
def upload_audio_note(meeting_id: int):
    audio = request.files.get("audio")
    if audio is None:
        return jsonify({"ok": False, "error": "audio file is required"}), 400

    ext = ".webm"
    if audio.mimetype and "ogg" in audio.mimetype:
        ext = ".ogg"
    elif audio.mimetype and "wav" in audio.mimetype:
        ext = ".wav"
    elif audio.filename and "." in audio.filename:
        ext = f".{audio.filename.rsplit('.', 1)[1].lower()}"

    filename = f"meeting_{meeting_id}_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}{ext}"
    file_path = RECORDINGS_DIR / filename
    audio.save(file_path)

    public_path = f"/recordings/{filename}"
    attach_audio_note(meeting_id=meeting_id, audio_path=public_path, created_at=datetime.now(timezone.utc).isoformat())
    return jsonify({"ok": True, "audio_path": public_path})


@app.get("/recordings/<path:filename>")
def get_recording(filename: str):
    return send_from_directory(RECORDINGS_DIR, filename, as_attachment=False)


@socketio.on("connect")
def on_connect():
    print("Socket client connected")
    emit(
        "system_event",
        {"type": "connected", "message": "Connected to Voice-First AI Meeting Architect"},
    )


@socketio.on("transcript_chunk")
def on_transcript_chunk(payload):
    text = str((payload or {}).get("text", "")).strip()
    speaker_id = str((payload or {}).get("speaker_id", "Unknown Speaker")).strip()
    if not text:
        emit("error_event", {"type": "validation", "message": "Chunk text is required"})
        return

    result = analyzer.process_chunk(text=text, speaker_id=speaker_id)
    _emit_facilitation_events(result)


def _emit_facilitation_events(result):
    socketio.emit("analysis_update", result)
    socketio.emit(
        "participation_update",
        {"word_counts": analyzer.get_participation_snapshot()},
    )
    socketio.emit(
        "sentiment_update",
        {"compound": result["sentiment"]["compound"], "sentiment": result["sentiment"]},
    )

    if result["potential_conflict"]:
        socketio.emit(
            "facilitator_alert",
            {
                "type": "conflict",
                "severity": "high",
                "message": "Conflict Detected: Consider a 2-minute break.",
            },
        )

    for alert in result["participation_alerts"]:
        socketio.emit(
            "facilitator_alert",
            {"type": "participation", "severity": "medium", "message": alert["message"]},
        )


if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=5000, debug=True)

