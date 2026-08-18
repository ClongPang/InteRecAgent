"""mission event sequence unique

Revision ID: 7c3e1a90b2d4
Revises: 4b9560cf055a
Create Date: 2026-08-18

"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "7c3e1a90b2d4"
down_revision: str | None = "4b9560cf055a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_index("ix_mission_events_mission_sequence", table_name="mission_events")
    op.create_unique_constraint(
        "uq_mission_events_mission_sequence",
        "mission_events",
        ["mission_id", "sequence"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_mission_events_mission_sequence",
        "mission_events",
        type_="unique",
    )
    op.create_index(
        "ix_mission_events_mission_sequence",
        "mission_events",
        ["mission_id", "sequence"],
        unique=False,
    )
