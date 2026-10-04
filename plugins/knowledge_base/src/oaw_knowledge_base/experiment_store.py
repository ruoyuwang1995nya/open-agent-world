"""Experiment records: many files, one structured entity — alongside MKB's own tables.

Mirrors ``graph_store.py``'s pattern of plugin-owned SQL structure in the same
SQLite file as the rest of the card. An experiment record is not a graph draft and
never touches ``oaw_kg_entity``/``oaw_kg_relation`` or the review flow at all: it is
assembled from several projections (one per attached file, extracted against one
``kind="experiment"`` schema) with the model's help, then a person confirms it or
edits it directly. Nothing here depends on mat-know-base beyond the engine the card
already opens; MKB has no concept of "one entity built from many files" in this
embedded, SQLite-backed mode to extend instead.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Column, DateTime, Index, Integer, MetaData, String, Table, Text,
    delete, insert, select, update,
)

from .errors import KnowledgeError

METADATA = MetaData()

RECORDS = Table(
    "oaw_kb_experiment_record", METADATA,
    Column("id", String(36), primary_key=True),
    Column("group_id", String(36), nullable=False),
    Column("schema_id", String(36), nullable=False),
    Column("name", String(500), nullable=False),
    Column("data", Text, nullable=False),
    # A list of {"field": ..., "values": [{"value": ..., "source_id": ...}, ...]} for
    # every field the merge could not reconcile on its own; empty once confirmed clean.
    Column("conflicts", Text, nullable=False),
    Column("status", String(32), nullable=False),
    Column("revision", Integer, nullable=False),
    Column("created_by", String(255), nullable=True),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
    Index("ix_oaw_experiment_record_group", "group_id"),
    Index("ix_oaw_experiment_record_schema", "schema_id"),
)

EVIDENCE = Table(
    "oaw_kb_experiment_record_evidence", METADATA,
    Column("record_id", String(36), primary_key=True),
    Column("projection_id", String(36), primary_key=True),
    Column("source_id", String(36), nullable=False),
    Column("artifact_id", String(36), nullable=True),
    Index("ix_oaw_experiment_evidence_record", "record_id"),
)

# One immutable snapshot per revision, so every change to a record is traceable: who
# (``actor``), through what (``source``: user / llm / agent / revert) and what moved
# (``changes``: one {"field", "before", "after"} per top-level field that differs).
REVISIONS = Table(
    "oaw_kb_experiment_record_revision", METADATA,
    Column("record_id", String(36), primary_key=True),
    Column("revision", Integer, primary_key=True),
    Column("name", String(500), nullable=False),
    Column("data", Text, nullable=False),
    Column("status", String(32), nullable=False),
    Column("changes", Text, nullable=False),
    Column("actor", String(255), nullable=True),
    Column("source", String(32), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
)

STATUSES = ("draft", "confirmed")
SOURCES = ("user", "llm", "agent", "revert")


def diff_data(before, after):
    """Top-level field changes between two data objects."""
    before, after = before or {}, after or {}
    return [{"field": key, "before": before.get(key), "after": after.get(key)}
            for key in sorted(set(before) | set(after), key=str)
            if before.get(key) != after.get(key) or (key in before) != (key in after)]


class ConflictingRevision(KnowledgeError):
    """Raised when an optimistic experiment-record write loses a race."""


def _aware(value):
    # SQLite returns naive datetimes; keep every timestamp this store hands back
    # timezone-aware, matching what the rest of the card already returns.
    if isinstance(value, datetime) and value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def _row_json(row):
    return {
        "id": row["id"], "group_id": row["group_id"], "schema_id": row["schema_id"],
        "name": row["name"], "data": json.loads(row["data"]),
        "conflicts": json.loads(row["conflicts"]), "status": row["status"],
        "revision": row["revision"], "created_by": row["created_by"],
        "created_at": _aware(row["created_at"]), "updated_at": _aware(row["updated_at"]),
    }


class ExperimentRecordStore:
    """Durable experiment-record storage, independent of the draft/review/graph flow."""

    def __init__(self, engine):
        self._engine = engine
        METADATA.create_all(engine, checkfirst=True)

    def create(self, *, group_id, schema_id, name, data, conflicts=(), created_by=None,
              record_id=None, source="llm"):
        identifier = str(record_id or uuid.uuid4())
        now = datetime.now(timezone.utc)
        with self._engine.begin() as connection:
            connection.execute(insert(RECORDS).values(
                id=identifier, group_id=str(group_id), schema_id=str(schema_id),
                name=name, data=json.dumps(data), conflicts=json.dumps(list(conflicts)),
                status="draft", revision=1, created_by=created_by,
                created_at=now, updated_at=now))
            connection.execute(insert(REVISIONS).values(
                record_id=identifier, revision=1, name=name, data=json.dumps(data),
                status="draft", changes=json.dumps(diff_data({}, data)),
                actor=created_by, source=source, created_at=now))
        return self.require(identifier)

    def get(self, record_id):
        with self._engine.connect() as connection:
            row = connection.execute(
                select(RECORDS).where(RECORDS.c.id == str(record_id))).mappings().first()
        return _row_json(row) if row else None

    def require(self, record_id):
        record = self.get(record_id)
        if record is None:
            raise KnowledgeError(f"Experiment record not found: {record_id}")
        return record

    def list(self, *, group_id=None, schema_id=None, status=None, limit=100):
        query = select(RECORDS).order_by(RECORDS.c.updated_at.desc()).limit(max(1, min(limit, 500)))
        if group_id:
            query = query.where(RECORDS.c.group_id == str(group_id))
        if schema_id:
            query = query.where(RECORDS.c.schema_id == str(schema_id))
        if status:
            query = query.where(RECORDS.c.status == status)
        with self._engine.connect() as connection:
            rows = connection.execute(query).mappings().all()
        return [_row_json(row) for row in rows]

    def update(self, record_id, *, name=None, data=None, conflicts=None, status=None,
              expected_revision=None, actor=None, source="user"):
        with self._engine.begin() as connection:
            current = connection.execute(
                select(RECORDS).where(RECORDS.c.id == str(record_id))).mappings().first()
            if current is None:
                raise KnowledgeError(f"Experiment record not found: {record_id}")
            if expected_revision is not None and current["revision"] != expected_revision:
                raise ConflictingRevision(
                    f"Experiment record changed underneath this call (revision {current['revision']})")
            if status is not None and status not in STATUSES:
                raise KnowledgeError(f"status must be one of {STATUSES}")
            values = {"revision": current["revision"] + 1, "updated_at": datetime.now(timezone.utc)}
            if name is not None:
                values["name"] = name
            if data is not None:
                values["data"] = json.dumps(data)
            if conflicts is not None:
                values["conflicts"] = json.dumps(list(conflicts))
            if status is not None:
                values["status"] = status
            connection.execute(update(RECORDS).where(RECORDS.c.id == str(record_id)).values(**values))
            new_data = data if data is not None else json.loads(current["data"])
            connection.execute(insert(REVISIONS).values(
                record_id=str(record_id), revision=values["revision"],
                name=values.get("name", current["name"]), data=json.dumps(new_data),
                status=values.get("status", current["status"]),
                changes=json.dumps(diff_data(json.loads(current["data"]), new_data)),
                actor=actor, source=source if source in SOURCES else "user",
                created_at=values["updated_at"]))
        return self.require(record_id)

    def history(self, record_id, limit=100):
        """Newest-first change log for one record, each entry carrying its snapshot."""
        with self._engine.connect() as connection:
            rows = connection.execute(select(REVISIONS).where(
                REVISIONS.c.record_id == str(record_id))
                .order_by(REVISIONS.c.revision.desc()).limit(max(1, min(limit, 500)))).mappings().all()
        return [{"revision": row["revision"], "name": row["name"], "data": json.loads(row["data"]),
                 "status": row["status"], "changes": json.loads(row["changes"]),
                 "actor": row["actor"], "source": row["source"],
                 "created_at": _aware(row["created_at"])} for row in rows]

    def revision(self, record_id, revision):
        for entry in self.history(record_id, limit=500):
            if entry["revision"] == revision:
                return entry
        raise KnowledgeError(f"Experiment record {record_id} has no revision {revision}")

    def set_evidence(self, record_id, links):
        """Replace every evidence link for one record — used on create and re-assemble."""
        with self._engine.begin() as connection:
            connection.execute(delete(EVIDENCE).where(EVIDENCE.c.record_id == str(record_id)))
            rows = [{"record_id": str(record_id), "projection_id": str(link["projection_id"]),
                     "source_id": str(link["source_id"]),
                     "artifact_id": str(link["artifact_id"]) if link.get("artifact_id") else None}
                    for link in links]
            if rows:
                connection.execute(insert(EVIDENCE), rows)

    def evidence_for(self, record_id):
        with self._engine.connect() as connection:
            rows = connection.execute(select(EVIDENCE).where(
                EVIDENCE.c.record_id == str(record_id))).mappings().all()
        return [dict(row) for row in rows]
