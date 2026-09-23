from __future__ import annotations

from datetime import UTC, datetime
from typing import Iterable

from backend.persistence.database import Database


def _now() -> str:
    return datetime.now(UTC).isoformat()


class ConversationDeliveryStore:
    """Durable per-Agent delivery ledger for Conversation user messages."""

    def __init__(self, database: Database) -> None:
        self.database = database

    def enqueue(self, conversation_id: str, session_id: str, message_id: str, agent_ids: Iterable[str]) -> None:
        now = _now()
        with self.database.transaction(immediate=True) as db:
            for agent_id in dict.fromkeys(agent_ids):
                db.execute(
                    """INSERT OR IGNORE INTO conversation_deliveries
                    (conversation_id, session_id, message_id, agent_id, status, created_at)
                    VALUES (?, ?, ?, ?, 'queued', ?)""",
                    (conversation_id, session_id, message_id, agent_id, now),
                )

    def next_batch(self, agent_id: str) -> tuple[str, str, list[str], int] | None:
        """Return the oldest queued Agent+session burst without mutating it."""
        with self.database.locked() as db:
            first = db.execute(
                """SELECT conversation_id, session_id FROM conversation_deliveries
                WHERE agent_id=? AND status='queued' ORDER BY id LIMIT 1""",
                (agent_id,),
            ).fetchone()
            if first is None:
                return None
            rows = db.execute(
                """SELECT d.message_id, m.sequence FROM conversation_deliveries d
                JOIN conversation_messages m ON m.id=d.message_id
                WHERE d.agent_id=? AND d.conversation_id=? AND d.session_id=?
                AND d.status='queued' ORDER BY d.id""",
                (agent_id, first["conversation_id"], first["session_id"]),
            ).fetchall()
        if not rows:
            return None
        return (
            str(first["conversation_id"]),
            str(first["session_id"]),
            [str(row["message_id"]) for row in rows],
            max(int(row["sequence"]) for row in rows),
        )

    def all_queued_agents(self) -> list[str]:
        with self.database.locked() as db:
            rows = db.execute(
                """SELECT DISTINCT agent_id FROM conversation_deliveries
                WHERE status='queued' ORDER BY agent_id"""
            ).fetchall()
        return [str(row["agent_id"]) for row in rows]

    def queued_agents(self, conversation_id: str, session_id: str) -> list[str]:
        with self.database.locked() as db:
            rows = db.execute(
                """SELECT DISTINCT agent_id FROM conversation_deliveries
                WHERE conversation_id=? AND session_id=? AND status='queued'
                ORDER BY agent_id""",
                (conversation_id, session_id),
            ).fetchall()
        return [str(row["agent_id"]) for row in rows]

    def has_queued(self, agent_id: str) -> bool:
        with self.database.locked() as db:
            row = db.execute(
                "SELECT 1 FROM conversation_deliveries WHERE agent_id=? AND status='queued' LIMIT 1",
                (agent_id,),
            ).fetchone()
        return row is not None

    def claim_batch(
        self,
        conversation_id: str,
        session_id: str,
        agent_id: str,
        run_id: str,
        message_ids: list[str],
    ) -> list[str]:
        """Atomically claim exactly the burst selected for the next Run."""
        if not message_ids:
            return []
        message_placeholders = ",".join("?" for _ in message_ids)
        with self.database.transaction(immediate=True) as db:
            rows = db.execute(
                f"""SELECT id, message_id FROM conversation_deliveries
                WHERE conversation_id=? AND session_id=? AND agent_id=? AND status='queued'
                AND message_id IN ({message_placeholders}) ORDER BY id""",
                (conversation_id, session_id, agent_id, *message_ids),
            ).fetchall()
            if not rows:
                return []
            ids = [int(row["id"]) for row in rows]
            placeholders = ",".join("?" for _ in ids)
            db.execute(
                f"""UPDATE conversation_deliveries
                SET status='claimed', claimed_run_id=?, claimed_at=?
                WHERE id IN ({placeholders}) AND status='queued'""",
                (run_id, _now(), *ids),
            )
            claimed = db.execute(
                f"""SELECT message_id FROM conversation_deliveries
                WHERE id IN ({placeholders}) AND status='claimed' AND claimed_run_id=?
                ORDER BY id""",
                (*ids, run_id),
            ).fetchall()
        return [str(row["message_id"]) for row in claimed]

    def mark_run_done(self, run_id: str) -> None:
        with self.database.transaction(immediate=True) as db:
            db.execute(
                """UPDATE conversation_deliveries
                SET status='done', completed_at=?
                WHERE status='claimed' AND claimed_run_id=?""",
                (_now(), run_id),
            )

    def requeue_run(self, run_id: str) -> None:
        with self.database.transaction(immediate=True) as db:
            db.execute(
                """UPDATE conversation_deliveries
                SET status='queued', claimed_run_id=NULL, claimed_at=NULL
                WHERE status='claimed' AND claimed_run_id=?""",
                (run_id,),
            )

    def recover_interrupted(self) -> None:
        """Requeue claims whose Run cannot still be executing after restart."""
        with self.database.transaction(immediate=True) as db:
            db.execute(
                """UPDATE conversation_deliveries
                SET status='queued', claimed_run_id=NULL, claimed_at=NULL
                WHERE status='claimed' AND claimed_run_id IN (
                    SELECT run_id FROM runs
                    WHERE status IN ('failed','cancelled','interrupted')
                )"""
            )

    def list_pending(self, conversation_id: str, session_id: str) -> list[dict]:
        with self.database.locked() as db:
            rows = db.execute(
                """SELECT message_id, agent_id, status, claimed_run_id
                FROM conversation_deliveries
                WHERE conversation_id=? AND session_id=? AND status IN ('queued','claimed')
                ORDER BY id""",
                (conversation_id, session_id),
            ).fetchall()
        return [
            {
                "message_id": str(row["message_id"]),
                "agent_id": str(row["agent_id"]),
                "status": str(row["status"]),
                "claimed_run_id": row["claimed_run_id"],
            }
            for row in rows
        ]

    def messages_for_run(self, run_id: str) -> list[str]:
        with self.database.locked() as db:
            rows = db.execute(
                """SELECT message_id FROM conversation_deliveries
                WHERE claimed_run_id=? ORDER BY id""",
                (run_id,),
            ).fetchall()
        return [str(row["message_id"]) for row in rows]
