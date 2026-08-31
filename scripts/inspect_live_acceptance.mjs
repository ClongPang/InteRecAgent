import pg from "pg";

if (process.env.INTEREC_LIVE_INSPECT_CONFIRM !== "authorized-local-evidence") {
  throw new Error("INTEREC_LIVE_INSPECT_CONFIRM_MUST_BE_authorized-local-evidence");
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

const tenantId = process.env.INTEREC_LIVE_INSPECT_TENANT?.trim() || "live-acceptance";
const ownerId = process.env.INTEREC_LIVE_INSPECT_OWNER?.trim() || "browser-acceptance";
const requestedConversationId = process.env.INTEREC_LIVE_INSPECT_CONVERSATION_ID?.trim() || null;
const pool = new pg.Pool({ connectionString: required("INTEREC_DATABASE_URL") });

try {
  const target = await pool.query(
    `SELECT id, current_revision, active_turn_id, created_at, updated_at
       FROM interec_agent.conversations
      WHERE tenant_id = $1 AND owner_id = $2
        AND ($3::uuid IS NULL OR id = $3::uuid)
      ORDER BY created_at DESC
      LIMIT 1`,
    [tenantId, ownerId, requestedConversationId],
  );
  if (!target.rows[0]) throw new Error("LIVE_CONVERSATION_NOT_FOUND");
  const conversationId = target.rows[0].id;
  const scopedTurn = "turn_id IN (SELECT id FROM interec_agent.turns WHERE conversation_id = $1)";
  const queries = {
    turns: `SELECT id, status, attempt, error_code, base_revision, created_at, completed_at
              FROM interec_agent.turns WHERE conversation_id = $1 ORDER BY created_at`,
    attempts: `SELECT turn_id, attempt, status, plan_json, draft_json, draft_envelope_json, evidence_keys
                 FROM interec_agent.turn_attempts WHERE ${scopedTurn} ORDER BY created_at`,
    tools: `SELECT turn_id, attempt, step_key, status, request_json, error_code
              FROM interec_agent.tool_executions WHERE ${scopedTurn} ORDER BY created_at`,
    permits: `SELECT provider, turn_id, attempt, step_key, status, error_code
                FROM interec_agent.provider_permits WHERE ${scopedTurn} ORDER BY acquired_at`,
    searches: `SELECT rw.turn_id, rw.wave_no, rw.status AS wave_status,
                      ms.market, ms.status, ms.result_count, ms.error_code
                 FROM interec_agent.research_waves rw
                 LEFT JOIN interec_agent.market_searches ms ON ms.research_wave_id = rw.id
                WHERE rw.conversation_id = $1
                ORDER BY rw.wave_no, ms.market`,
    artifacts: `SELECT retrieval_market, provider_schema_version, count(*)::integer AS artifact_count
                  FROM interec_agent.provider_artifacts
                 WHERE conversation_id = $1
                 GROUP BY retrieval_market, provider_schema_version
                 ORDER BY retrieval_market`,
    artifactConditionSamples: `SELECT pa.retrieval_market,
                                      item->>'title' AS title,
                                      item->'condition' AS raw_condition,
                                      item->'metadata'->'condition' AS metadata_condition,
                                      item->'metadata'->'product_condition' AS metadata_product_condition,
                                      item->'metadata'->'item_condition' AS metadata_item_condition,
                                      item->'metadata' AS metadata
                                 FROM interec_agent.provider_artifacts pa
                                 CROSS JOIN LATERAL jsonb_array_elements(COALESCE(pa.payload_json->'data', '[]'::jsonb)) item
                                WHERE pa.conversation_id = $1
                                  AND item->>'title' ILIKE '%iPhone 16 Pro%'
                                ORDER BY pa.retrieval_market, item->>'title'
                                LIMIT 24`,
    listings: `SELECT retrieval_market, count(*)::integer AS listing_count
                 FROM interec_agent.source_listings
                WHERE conversation_id = $1
                GROUP BY retrieval_market
                ORDER BY retrieval_market`,
    facts: `SELECT fact_kind, evidence_status, count(*)::integer AS fact_count
              FROM interec_agent.source_facts
             WHERE conversation_id = $1
             GROUP BY fact_kind, evidence_status
             ORDER BY fact_kind, evidence_status`,
    eligibilityResults: `SELECT status, reason_codes, count(*)::integer AS eligibility_count
                       FROM interec_agent.offer_qualifications
                      WHERE conversation_id = $1
                      GROUP BY status, reason_codes
                      ORDER BY status, reason_codes::text`,
    qualificationSamples: `SELECT oq.status, oq.reason_codes, sl.retrieval_market,
                                  sl.listing_json->'title'->>'value' AS title,
                                  sl.listing_json->'categoryPath'->'value' AS category_path,
                                  sl.listing_json->'providerProductType'->>'value' AS provider_product_type,
                                  sl.listing_json->'identity' AS identity
                             FROM interec_agent.offer_qualifications oq
                             JOIN interec_agent.source_listings sl ON sl.id = oq.source_listing_id
                            WHERE oq.conversation_id = $1
                            ORDER BY oq.status, sl.retrieval_market, sl.listing_ref
                            LIMIT 12`,
    responses: `SELECT turn_id, outcome, rendered_text
                  FROM interec_agent.assistant_responses
                 WHERE conversation_id = $1 ORDER BY created_at`,
  };
  const evidence = { conversation: target.rows[0] };
  for (const [key, sql] of Object.entries(queries)) {
    evidence[key] = (await pool.query(sql, [conversationId])).rows;
  }
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} finally {
  await pool.end();
}
