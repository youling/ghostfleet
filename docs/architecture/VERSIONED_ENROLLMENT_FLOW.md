# Versioned enrollment and reconciliation flow / 版本化纳管与收敛流程

status: `DERIVED_ARCHITECTURE_VIEW`
canonical_contract: [VERSIONED_ENROLLMENT_RECONCILE_V1.md](VERSIONED_ENROLLMENT_RECONCILE_V1.md)
parent: [GhostFleet #11](https://github.com/youling/ghostfleet/issues/11)
candidate: [PR #78](https://github.com/youling/ghostfleet/pull/78)

This diagram is a navigation projection of the S1–S3 proposal. It does not implement a release resolver, signer, reconciliation executor, durable journal, or runtime acceptance.

## 中文

```mermaid
flowchart TD
  A["Human selects desired profile"] --> B["Resolve immutable ReleaseManifestPayload"]
  B --> C["Verify digest and trusted publisher provenance"]
  C --> D{"Exact compatibility evidence?"}
  D -->|SUPPORTED| E["Observe target and bind identity"]
  D -->|UNKNOWN / INCOMPATIBLE| X["Block affected mutation; preserve unrelated safe paths"]
  E --> F["Classify intent: NEW / ADOPT / REPAIR / UPGRADE"]
  F --> G["Create immutable minimal-delta plan"]
  G --> H["Recheck target, snapshot, artifact digests and authority"]
  H --> I{"Current and authorized?"}
  I -->|No| X
  I -->|Yes| J["Apply bounded effects with durable operation identity"]
  J --> K["Fresh readback and effect reconciliation"]
  K --> L{"All required postconditions proven?"}
  L -->|No / uncertain| M["UNKNOWN / MAY_HAVE_EXECUTED; query before retry"]
  L -->|Yes| N["Checkpoint evidence; project node conformance"]
  N --> O["Independent ConsumerAcceptance"]
```

## English

The flow separates immutable release identity from mutable channel selection, and separates compatibility evidence, per-node conformance, and independent consumer acceptance. An unresolved or uncertain effect is reconciled by querying durable state before retry; a plan projection or checkpoint alone is not proof of a fully managed node.

## Evidence boundary

- S1–S3 are candidate contracts, not runtime implementation.
- The 24 VE acceptance cases remain `NOT_RUN`; CI validates the specification structure only.
- `SUPPORTED` requires an exact artifact/version/protocol/platform/capability tuple and independently readable evidence.
- Provider credentials, private deployment bindings, real node facts and production actions remain with the private deployment owner.
- OMV8 and other protected storage/business resources remain outside any unapproved write set.

