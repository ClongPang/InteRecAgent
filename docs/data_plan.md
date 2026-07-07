# Data Plan: InteRecAgent

## Data Goal

The MVP uses Amazon Reviews 2018 / legacy 5-core and metadata to build a product catalog, user profile signals, review evidence, and evaluation data. The product supports any category loaded into the catalog rather than hard-coding a category boundary.

## Source Data

### Amazon Reviews 2018 5-Core

Primary usage:

- user behavior
- ratings
- review text
- review timestamps
- user-product interaction history

The 5-core subset is useful because each included user and item has a minimum amount of interaction, which supports profile construction and recommendation history.

### Amazon Metadata

Primary usage:

- product title
- category
- brand
- price
- image
- description
- feature text
- related products if available

Metadata is the source of product facts and should be treated as more reliable than LLM output.

## Product Scale

MVP target:

```text
20k-50k products
```

Additionally maintain:

```text
curated_demo_pool = high-quality subset for polished demos
```

The curated pool should contain products with relatively complete title, price, image, category, and review evidence.

## Data Processing Pipeline

```text
raw Amazon reviews + metadata
  -> parse JSON
  -> join review and metadata by ASIN
  -> filter products
  -> normalize product fields
  -> build review summaries/evidence
  -> build user profiles
  -> generate product embeddings
  -> build vector index
  -> export processed product store
```

## Product Filtering Rules

Candidate products should be filtered during processing:

- remove products without title
- remove products without category
- remove products with unusable or missing metadata
- prefer products with price when available
- prefer products with image when available
- prefer products with multiple reviews

Do not require every product to have every field. Missing fields should be represented as `null` or `unknown`.

## Normalized Product Schema

```json
{
  "product_id": "asin",
  "title": "",
  "category_path": [],
  "leaf_category": "",
  "brand": "",
  "price": null,
  "image_url": "",
  "description": "",
  "features": [],
  "attributes": {},
  "average_rating": null,
  "rating_count": 0,
  "review_count": 0,
  "review_summary": "",
  "evidence_snippets": [],
  "raw_metadata": {}
}
```

## Review Evidence Schema

```json
{
  "review_id": "",
  "product_id": "",
  "user_id": "",
  "rating": 5,
  "timestamp": "",
  "text": "",
  "evidence_aspects": [
    {
      "aspect": "comfort",
      "sentiment": "positive",
      "snippet": ""
    }
  ]
}
```

## User Profile Schema

User profiles are internal only and are not displayed directly in the frontend.

```json
{
  "user_id": "",
  "preferred_categories": [],
  "preferred_brands": [],
  "price_sensitivity": "",
  "positive_item_ids": [],
  "negative_item_ids": [],
  "average_rating_given": null,
  "category_rating_stats": {},
  "brand_rating_stats": {}
}
```

## Product Embedding Text

Recommended text for product embedding:

```text
Title: {title}
Brand: {brand}
Category: {category_path}
Features: {features}
Description: {description}
Review summary: {review_summary}
```

Do not include excessive raw reviews in embedding text. Use review summaries or representative snippets to keep embeddings stable.

## Intent and Task Test Set

The MVP needs a small hand-authored or semi-synthetic test set for evaluation and regression testing.

Suggested test set size:

```text
100-300 user requests
```

Each test case should include:

```json
{
  "case_id": "",
  "user_query": "",
  "expected_task_type": "",
  "expected_intent_slots": {},
  "hard_constraints": [],
  "soft_preferences": [],
  "negative_preferences": [],
  "expected_behavior": "",
  "notes": ""
}
```

## Feedback Test Set

Create multi-turn test cases for feedback recovery.

Example:

```json
{
  "case_id": "feedback_001",
  "turns": [
    {
      "user": "Recommend wireless headphones under 100 dollars.",
      "expected_task_type": "single_item_recommendation"
    },
    {
      "user": "Not this brand, show me something cheaper.",
      "expected_task_type": "negative_feedback",
      "expected_intent_update": {
        "negative_preferences": ["previous_brand"],
        "price_sensitivity": "higher"
      }
    }
  ]
}
```

## Data Quality Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Price missing or noisy | Price-based ranking and constraints degrade | Use unknown state, avoid false claims, prefer priced products in demo pool |
| Category paths inconsistent | Task routing/category retrieval can be noisy | Normalize category strings and use leaf category |
| Attributes are sparse | Constraint verification may be incomplete | Extract weak attributes from title/features and preserve unknown |
| Reviews are long/noisy | Evidence generation may be unstable | Summarize and select concise snippets |
| 5-core filters out cold-start items | Demo may underrepresent long tail | Use metadata pool beyond strict interaction data if needed later |

## Data Product Principle

For a product-grade demo, data quality is more important than raw scale. The MVP should combine a 20k-50k searchable catalog with a smaller curated pool that is reliable enough for smooth demonstrations.
