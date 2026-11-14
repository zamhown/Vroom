# Query SQL editing notation (version 1)

The query editor has Form and SQL views of the same `query.schema.json` draft.
SQL is parsed into that contract on the client and sent through the existing typed
query API/compiler. It is never forwarded to SQLite. Agent tools still accept the
public JSON query contract. Stable declaration keys are SQL identifiers; display
labels and translated names are not identifiers.

## Statement

```sql
SELECT * FROM films
WHERE "custom.measure" BETWEEN 0 AND 100
  AND ("custom.caption" LIKE 'sample%' OR "custom.caption" IS NULL)
GROUP BY "custom.caption", MEMBER("custom.references")
ORDER BY "custom.measure" DESC NULLS LAST, LABEL("custom.reference") ASC;
```

`WHERE`, `GROUP BY` and `ORDER BY` are optional and appear in that order. The only
source/projection is `SELECT * FROM films`. Pagination, library scope, locale and
archived visibility remain the surrounding query context. SQL cannot change them.
Unknown clauses, additional statements, table access, joins, subqueries, arbitrary
functions and aggregate result projections are rejected, never silently omitted.
Grouping keeps the API's combination counts alongside the matching film list.

- Keywords are case insensitive. Quote field keys with double quotes (double a
  quote to escape it); unquoted ASCII identifiers and backticks are also accepted.
- String values use single quotes, with doubled apostrophes. Backslashes remain
  literal. Numbers support signs, decimals and exponents; non-finite values fail.
- `--` line comments and `/* ... */` comments are accepted. Unterminated comments
  or strings fail. Comments/formatting are retained while editing SQL; converting
  back to SQL from Form produces canonical formatting.
- Supported operators: `=`, `<>`, `!=`, `<`, `<=`, `>`, `>=`, `IN`, `BETWEEN`, `LIKE`,
  `IS NULL`, `IS NOT NULL`, `AND`, `OR`, `NOT`, parentheses, `TRUE` and `FALSE`.
  `NOT IN`, `NOT LIKE`, `GLOB`, `NOT GLOB`, `NOT BETWEEN`, `IS`, `IS NOT`,
  `IS DISTINCT FROM` and `IS NOT DISTINCT FROM` use the corresponding typed operators.
  Standard precedence is NOT, AND, OR. BETWEEN includes both bounds.
- `LIKE` uses `%` and `_`, with backslash escaping. Optional `ESCAPE '\'` is accepted;
  other escape characters are rejected. `CONTAINS` treats wildcards as literal text.
- Missing annotations are explicit absence: `IS NULL` maps to `missing` and
  `IS NOT NULL` maps to `exists`. Ordinary comparisons preserve SQL NULL when the
  annotation is absent, including under NOT. IS/IS NOT are null-safe comparisons.
  Empty IN lists are supported by the current contract; IN/NOT IN preserve NULL
  members and follow the host compiler. IS NULL/IS NOT NULL normalize to the
  equivalent missing/exists predicates when converting back to Form.
- Order fields default to ASC, NULLS LAST in SQL. The serializer always prints
  direction and null placement. Omitting ORDER BY uses the catalog's default order.

## Domain functions

| Notation | Public query meaning |
| --- | --- |
| `TERM('stable-id')` | A `{ "term": "stable-id" }` value; names never identify options |
| `JSON('[1,2]')` | A JSON literal, for example exact collection equality |
| `CONTAINS("key", 'text')` | `contains` |
| `STARTS_WITH("key", 'text')`, `ENDS_WITH("key", 'text')` | Literal prefix/suffix tests |
| `HAS("key", value)` | `has` collection membership |
| `RELATED("key", predicate)` | `related`; child predicate uses term subjects |
| `FACET("key", 'facet-id') = 'band-id'` | `facet` |
| `WITHIN_SCOPE('kind', 'quantifier', 'match', 'startUs', 'endUs', predicate)` | `scoped`; bounds are exact decimal microsecond strings or NULL |
| `ALL_OF(predicate, ...)`, `ANY_OF(predicate, ...)` | Explicit logical groups; preserve empty/single-child groups during conversion |
| `SEARCH('text')` | Toolbar search; occurs once in the outer AND tree, never inside OR, NOT, RELATED or WITHIN_SCOPE |

Scope kinds are whole/point/interval/any, quantifiers any/all/none and matching
overlaps/contains. Scope expressions cannot be nested or used on term subjects.
End requires start and must be greater; whole does not accept bounds. These use
the existing scope contract (half-open media intervals), not BETWEEN semantics.

ORDER BY accepts plain keys (`value`), `LABEL("key")`, `MIN("key")` and `MAX("key")`.
LABEL sorts references by localized labels; MIN/MAX reduce collection values.
GROUP BY accepts plain keys, `MEMBER("key")` and `FACET("key", 'facet-id')`.
Each declared field must enable the selected capability. Each list has at most
12 fields. Query node/depth/value limits still apply.

## Editing and execution

Switching views converts only the draft. Invalid SQL remains editable, survives
panel closure/tab changes/reload, and blocks Form conversion and Apply. Invalid
form fields block SQL conversion and Apply. Errors identify the syntax location;
type/capability errors are reported before submission and checked again by the host.
There is one Apply operation for the query panel. Reset edits the draft and Cancel
keeps the applied query. SQL input never starts result queries. Smart-list editing
uses the same editor; count/preview/save are explicit actions.

No additional persisted SQL representation or SQL execution endpoint is introduced.
Only an unfinished SQL editor buffer is stored in workspace draft state. Applied
queries, smart lists, bulk previews and Agent operations use the same public AST.
