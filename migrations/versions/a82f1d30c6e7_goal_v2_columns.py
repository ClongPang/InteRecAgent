"""add authoritative Goal V2 columns

Revision ID: a82f1d30c6e7
Revises: 7c3e1a90b2d4
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "a82f1d30c6e7"
down_revision: str | None = "7c3e1a90b2d4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "shopping_missions",
        sa.Column("goal_json", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False),
    )
    op.add_column(
        "shopping_missions",
        sa.Column("goal_version", sa.Integer(), server_default="1", nullable=False),
    )
    op.add_column(
        "shopping_missions",
        sa.Column("schema_version", sa.String(length=20), server_default="goal-v2", nullable=False),
    )
    op.execute(
        "UPDATE shopping_missions SET goal_json = COALESCE(constraints_json->'goal', '{}'::jsonb), "
        "goal_version = GREATEST(constraints_version, COALESCE((constraints_json->'goal'->>'goal_version')::int, 1))"
    )


def downgrade() -> None:
    op.drop_column("shopping_missions", "schema_version")
    op.drop_column("shopping_missions", "goal_version")
    op.drop_column("shopping_missions", "goal_json")
