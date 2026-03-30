import json
import sqlite3
from pathlib import Path
from typing import Any, Dict, List


BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "meeting_architect.db"


def init_db() -> None:
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meetings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                transcript TEXT NOT NULL,
                sentiment_map TEXT NOT NULL,
                participation_map TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meeting_audio (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                meeting_id INTEGER NOT NULL,
                audio_path TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(meeting_id) REFERENCES meetings(id)
            )
            """
        )
        conn.commit()


def save_meeting_summary(payload: Dict[str, Any]) -> int:
    transcript = json.dumps(payload.get("transcript_chunks", []))
    sentiment_map = json.dumps(payload.get("sentiment_map", []))
    participation_map = json.dumps(payload.get("participation_word_counts", {}))
    created_at = payload.get("generated_at")

    with sqlite3.connect(DB_PATH) as conn:
        cursor = conn.execute(
            """
            INSERT INTO meetings (created_at, transcript, sentiment_map, participation_map)
            VALUES (?, ?, ?, ?)
            """,
            (created_at, transcript, sentiment_map, participation_map),
        )
        conn.commit()
        return int(cursor.lastrowid)


def list_meetings(limit: int = 20) -> List[Dict[str, Any]]:
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT m.id, m.created_at, ma.audio_path
            FROM meetings m
            LEFT JOIN meeting_audio ma ON ma.meeting_id = m.id
            ORDER BY id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

    return [
        {"id": row["id"], "created_at": row["created_at"], "audio_path": row["audio_path"]}
        for row in rows
    ]


def attach_audio_note(meeting_id: int, audio_path: str, created_at: str) -> int:
    with sqlite3.connect(DB_PATH) as conn:
        cursor = conn.execute(
            """
            INSERT INTO meeting_audio (meeting_id, audio_path, created_at)
            VALUES (?, ?, ?)
            """,
            (meeting_id, audio_path, created_at),
        )
        conn.commit()
        return int(cursor.lastrowid)

