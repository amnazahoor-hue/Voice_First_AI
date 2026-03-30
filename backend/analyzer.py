"""
Meeting facilitation analysis logic.

Responsibilities:
- Sentiment scoring per transcript chunk using VADER.
- Conflict detection when compound sentiment < -0.5.
- Participation tracking per speaker.
- Participation alert when a known speaker is silent for 5 minutes.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional, Set

from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class ChunkAnalysisResult:
    speaker_id: str
    text: str
    timestamp: str
    word_count: int
    sentiment: Dict[str, float]
    global_sentiment_average: float
    potential_conflict: bool
    participation_alerts: List[Dict[str, str]]

    def to_dict(self) -> Dict:
        return asdict(self)


class MeetingAnalyzer:
    """
    Stateful analyzer for one meeting session.
    """

    NEGATIVE_CONFLICT_THRESHOLD = -0.5
    SILENCE_ALERT_MINUTES = 5

    def __init__(self, expected_speakers: Optional[List[str]] = None) -> None:
        self._started_at = _utcnow()
        self._sentiment = SentimentIntensityAnalyzer()
        self._expected_speakers: Set[str] = set(expected_speakers or [])
        self._word_counts: Dict[str, int] = {speaker: 0 for speaker in self._expected_speakers}
        self._last_spoken_at: Dict[str, datetime] = {}
        self._last_alerted_at: Dict[str, datetime] = {}
        self._compound_sum = 0.0
        self._compound_count = 0
        self._global_sentiment_average = 0.0
        self._sentiment_history: List[Dict] = []
        self._transcript_chunks: List[Dict] = []

    def register_speaker(self, speaker_id: str) -> None:
        speaker = self._normalize_speaker(speaker_id)
        self._expected_speakers.add(speaker)
        self._word_counts.setdefault(speaker, 0)

    def process_chunk(
        self,
        text: str,
        speaker_id: Optional[str] = None,
        timestamp: Optional[datetime] = None,
    ) -> Dict:
        """
        Analyze a transcript chunk and update session state.

        Returns a payload appropriate for SocketIO emission.
        """
        ts = timestamp or _utcnow()
        speaker = self._normalize_speaker(speaker_id)
        words = self._word_count(text)

        sentiment_scores = self._sentiment.polarity_scores(text or "")
        self._compound_sum += float(sentiment_scores["compound"])
        self._compound_count += 1
        self._global_sentiment_average = self._compound_sum / self._compound_count
        conflict = sentiment_scores["compound"] < self.NEGATIVE_CONFLICT_THRESHOLD

        if words > 0:
            self._word_counts[speaker] = self._word_counts.get(speaker, 0) + words
            self._last_spoken_at[speaker] = ts

        chunk_record = {
            "speaker_id": speaker,
            "text": text,
            "timestamp": ts.isoformat(),
            "word_count": words,
            "sentiment": sentiment_scores,
            "potential_conflict": conflict,
        }
        self._transcript_chunks.append(chunk_record)
        self._sentiment_history.append(
            {
                "timestamp": ts.isoformat(),
                "speaker_id": speaker,
                "compound": sentiment_scores["compound"],
                "neg": sentiment_scores["neg"],
                "neu": sentiment_scores["neu"],
                "pos": sentiment_scores["pos"],
            }
        )

        alerts = self._get_participation_alerts(ts)

        result = ChunkAnalysisResult(
            speaker_id=speaker,
            text=text,
            timestamp=ts.isoformat(),
            word_count=words,
            sentiment=sentiment_scores,
            global_sentiment_average=self._global_sentiment_average,
            potential_conflict=conflict,
            participation_alerts=alerts,
        )
        return result.to_dict()

    def get_participation_snapshot(self) -> Dict[str, int]:
        return dict(self._word_counts)

    def get_sentiment_map(self) -> List[Dict]:
        return list(self._sentiment_history)

    def get_global_sentiment_average(self) -> float:
        return self._global_sentiment_average

    def get_transcript(self) -> List[Dict]:
        return list(self._transcript_chunks)

    def get_meeting_summary_payload(self) -> Dict:
        """
        Shape intended for persistence in SQLite by backend/database.py.
        """
        return {
            "transcript_chunks": self.get_transcript(),
            "sentiment_map": self.get_sentiment_map(),
            "participation_word_counts": self.get_participation_snapshot(),
            "global_sentiment_average": self.get_global_sentiment_average(),
            "generated_at": _utcnow().isoformat(),
        }

    def _get_participation_alerts(self, now: datetime) -> List[Dict[str, str]]:
        alerts: List[Dict[str, str]] = []
        quiet_window = timedelta(minutes=self.SILENCE_ALERT_MINUTES)

        for speaker in sorted(self._expected_speakers):
            last_spoken = self._last_spoken_at.get(speaker)
            has_never_spoken = last_spoken is None

            should_alert = False
            if has_never_spoken:
                should_alert = (now - self._started_at) >= quiet_window
            else:
                should_alert = (now - last_spoken) >= quiet_window

            if not should_alert:
                continue

            last_alert = self._last_alerted_at.get(speaker)
            # Throttle duplicates: once per silence window.
            if last_alert and (now - last_alert) < quiet_window:
                continue

            self._last_alerted_at[speaker] = now
            alerts.append(
                {
                    "type": "participation_alert",
                    "speaker_id": speaker,
                    "message": f"Prompt: Ask {speaker} for their opinion.",
                }
            )

        return alerts

    @staticmethod
    def _normalize_speaker(speaker_id: Optional[str]) -> str:
        if speaker_id and speaker_id.strip():
            return speaker_id.strip()
        return "Unknown Speaker"

    @staticmethod
    def _word_count(text: str) -> int:
        if not text:
            return 0
        return len([w for w in text.strip().split() if w])
